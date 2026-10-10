"use strict";

// 所有 kubectl 命令显式使用本次独立 kubeconfig；不访问用户当前 context。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { run, request, waitUntil, verifyEndpoints, saveAndDeduplicate, verifyStored, registerSignals, projectRoot, version, image } = require("./test-container.cjs");

async function main() {
  registerSignals();
  const nodeImage = process.env.TOMATO_KIND_NODE_IMAGE;
  const runID = randomUUID();
  const suffix = runID.replaceAll("-", "");
  const cluster = `tomato-qa-${suffix}`;
  const qaDirectory = path.join(projectRoot, ".qa");
  fs.mkdirSync(qaDirectory, { recursive: true });
  const localKind = path.join(qaDirectory, "tools", process.platform === "win32" ? "kind.exe" : "kind");
  const kind = process.env.TOMATO_KIND_BIN || (fs.existsSync(localKind) ? localKind : "kind");
  const kubeconfig = path.join(qaDirectory, `kind-${suffix}.kubeconfig`);
  assert.equal(fs.existsSync(kubeconfig), false, "独立测试 kubeconfig 必须尚未存在");
  const env = { ...process.env, KIND_EXPERIMENTAL_PROVIDER: "docker", KUBECONFIG: kubeconfig };
  const namespace = "tomato";
  const deployment = "tomato-clock";
  const serviceName = "tomato";
  const claim = "tomato-data";
  const selector = "app.kubernetes.io/name=tomato-clock";
  const base = "http://127.0.0.1:4201";
  const checks = [];
  const report = { type: "kubernetes", runID, cluster, version, image, nodeImage, checks, passed: false, startedAt: new Date().toISOString() };
  let clusterAttempted = false;
  let forward = null;
  let forwardOutput = "";

  const kubectl = (args, options = {}) => run("kubectl", ["--kubeconfig", kubeconfig, ...args], { env, ...options });
  const get = async (resource) => JSON.parse((await kubectl(["-n", namespace, "get", resource, "-o", "json"], { quiet: true })).stdout);

  async function stopForward() {
    const child = forward;
    forward = null;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3000);
    try { await stopped; } finally { clearTimeout(timer); }
  }

  async function startForward() {
    // 端口冲突时明确失败，避免连上其他本机服务后误判测试通过。
    await new Promise((resolve, reject) => {
      const listener = net.createServer();
      listener.once("error", reject);
      listener.listen(4201, "127.0.0.1", () => listener.close(resolve));
    });
    const service = await get(`service/${serviceName}`);
    const http = service.spec.ports.find((item) => item.name === "http") || service.spec.ports[0];
    assert.ok(Number.isInteger(http.port));
    forwardOutput = "";
    forward = spawn("kubectl", ["--kubeconfig", kubeconfig, "-n", namespace, "port-forward", "--address", "127.0.0.1", `service/${serviceName}`, `4201:${http.port}`], { cwd: projectRoot, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const child = forward;
    child.stdout.on("data", (data) => { forwardOutput = (forwardOutput + data.toString()).slice(-16000); });
    child.stderr.on("data", (data) => { forwardOutput = (forwardOutput + data.toString()).slice(-16000); });
    let startError;
    child.once("error", (error) => { startError = error; });
    await waitUntil(async () => {
      if (startError || child.exitCode !== null || child.signalCode !== null) {
        const error = new Error(`本次 port-forward 启动失败：${startError?.message || forwardOutput}`);
        error.fatal = true;
        throw error;
      }
      assert.match(forwardOutput, /Forwarding from 127\.0\.0\.1:4201/, "等待本次转发进程绑定端口");
      await request(base, "/readyz");
    }, 60000, "隔离的 localhost port-forward");
  }

  async function readyPod() {
    const body = JSON.parse((await kubectl(["-n", namespace, "get", "pods", "-l", selector, "-o", "json"], { quiet: true })).stdout);
    const pods = body.items.filter((item) => !item.metadata.deletionTimestamp && item.status.phase === "Running");
    assert.equal(pods.length, 1, "SQLite 使用单副本 Deployment");
    const pod = pods[0];
    assert.ok(pod.status.containerStatuses.every((item) => item.ready));
    const container = pod.spec.containers.find((item) => item.name === "tomato") || pod.spec.containers[0];
    const security = { ...pod.spec.securityContext, ...container.securityContext };
    assert.equal(security.runAsNonRoot, true);
    assert.equal(security.runAsUser, 10001);
    assert.equal(security.readOnlyRootFilesystem, true);
    assert.equal(security.allowPrivilegeEscalation, false);
    assert.equal(security.seccompProfile.type, "RuntimeDefault");
    assert.ok(security.capabilities.drop.includes("ALL"));
    assert.ok(container.livenessProbe?.httpGet && container.readinessProbe?.httpGet && container.startupProbe?.httpGet);
    assert.equal(container.livenessProbe.httpGet.path, "/livez");
    assert.equal(container.startupProbe.httpGet.path, "/livez");
    assert.equal(container.readinessProbe.httpGet.path, "/readyz");
    assert.ok(container.resources?.requests?.cpu && container.resources?.limits?.memory);
    assert.equal(pod.spec.automountServiceAccountToken, false);
    assert.ok(pod.spec.volumes.some((item) => item.persistentVolumeClaim?.claimName === claim));
    await kubectl(["-n", namespace, "exec", pod.metadata.name, "-c", container.name, "--", "/tomato", "healthcheck"]);
    return pod;
  }

  try {
    assert.match(nodeImage || "", /^kindest\/node:v\d+\.\d+\.\d+(?:@sha256:[a-f0-9]{64})?$/, "设置 TOMATO_KIND_NODE_IMAGE 为官方固定版本 kindest/node:vX.Y.Z（建议含 digest）");
    assert.match(image, /^[a-z0-9][a-z0-9._/:@-]*$/);
    const engine = await run("docker", ["info", "--format", "{{.OSType}}"]);
    assert.equal(engine.stdout.trim(), "linux", "kind 验证需要 Docker Linux 容器引擎");
    await run(kind, ["version"], { env });
    await kubectl(["version", "--client", "-o", "json"]);
    const clusters = (await run(kind, ["get", "clusters"], { quiet: true, env })).stdout.trim().split(/\r?\n/);
    assert.equal(clusters.includes(cluster), false, "随机测试集群名必须未被使用");
    await run("docker", ["build", "--tag", image, "."], { timeout: 600000 });
    clusterAttempted = true;
    await run(kind, ["create", "cluster", "--name", cluster, "--image", nodeImage, "--kubeconfig", kubeconfig, "--wait", "180s"], { env, timeout: 600000 });
    const nodes = await run(kind, ["get", "nodes", "--name", cluster], { env, quiet: true });
    for (const node of nodes.stdout.trim().split(/\r?\n/).filter(Boolean)) {
      const inspected = JSON.parse((await run("docker", ["inspect", node], { quiet: true })).stdout)[0];
      assert.equal(inspected.Config.Labels?.["io.x-k8s.kind.cluster"], cluster, "kind 节点应属于本次随机集群");
    }
    await run(kind, ["load", "docker-image", image, "--name", cluster], { env, timeout: 180000 });
    // 新集群先创建目标 Namespace，之后 server dry-run 才能校验其中的资源。
    await kubectl(["apply", "-f", path.join(projectRoot, "deploy", "k8s", "namespace.yaml")]);
    await kubectl(["apply", "--dry-run=server", "-k", path.join(projectRoot, "deploy", "k8s")]);
    checks.push("Namespace 引导完成，全部 Kustomize 清单通过 server dry-run/schema/admission 校验");
    await kubectl(["apply", "-k", path.join(projectRoot, "deploy", "k8s")]);
    // 自定义测试镜像仅修改本次独立测试集群，不编辑发布清单。
    if (image !== `tomato-clock:${version}`) await kubectl(["-n", namespace, "set", "image", `deployment/${deployment}`, `tomato=${image}`]);
    await kubectl(["-n", namespace, "rollout", "status", `deployment/${deployment}`, "--timeout=180s"], { timeout: 210000 });
    const pvc = await get(`pvc/${claim}`);
    assert.equal(pvc.status.phase, "Bound", "PVC 应成功动态绑定");
    checks.push("清单 apply、Deployment rollout、PVC Bound");
    const originalPod = await readyPod();
    checks.push("单副本 Pod Ready、非 root、只读根目录、drop ALL、禁止提权、三类探针及资源限制");
    await startForward();
    await verifyEndpoints(base, checks);
    const session = { completedAt: Date.now(), minutes: 1, task: `K8s 持久化验证 ${runID}` };
    const id = await saveAndDeduplicate(base, session, checks);
    await stopForward();
    await kubectl(["-n", namespace, "rollout", "restart", `deployment/${deployment}`]);
    await kubectl(["-n", namespace, "rollout", "status", `deployment/${deployment}`, "--timeout=180s"], { timeout: 210000 });
    const replacementPod = await readyPod();
    assert.notEqual(replacementPod.metadata.uid, originalPod.metadata.uid, "重启应实际替换 Pod");
    await startForward();
    await verifyStored(base, session, id);
    await verifyEndpoints(base, checks);
    assert.equal((await get(`pvc/${claim}`)).metadata.uid, pvc.metadata.uid, "重启应复用同一个 PVC");
    checks.push("Deployment 重启实际替换 Pod，PVC 与 SQLite 历史保持");
    report.passed = true;
    console.log("Kubernetes 隔离集群部署实测通过。");
  } catch (error) {
    report.error = error.message;
    report.portForwardOutput = forwardOutput;
    if (clusterAttempted && fs.existsSync(kubeconfig)) {
      await kubectl(["-n", namespace, "get", "pods,pvc,deploy", "-o", "wide"], { cleanup: true, allowFailure: true });
      await kubectl(["-n", namespace, "get", "events", "--sort-by=.lastTimestamp"], { cleanup: true, allowFailure: true });
      await kubectl(["-n", namespace, "logs", `deployment/${deployment}`, "--tail=60"], { cleanup: true, allowFailure: true });
    }
    throw error;
  } finally {
    const errors = [];
    try { await stopForward(); } catch (error) { errors.push(error.message); }
    if (clusterAttempted) {
      try {
        // 只删除预先确认不存在且由本脚本创建的随机集群；独立 kubeconfig 不合并到用户配置。
        const nodes = await run(kind, ["get", "nodes", "--name", cluster], { env, cleanup: true, quiet: true });
        for (const node of nodes.stdout.trim().split(/\r?\n/).filter(Boolean)) {
          const inspected = JSON.parse((await run("docker", ["inspect", node], { quiet: true, cleanup: true })).stdout)[0];
          assert.equal(inspected.Config.Labels?.["io.x-k8s.kind.cluster"], cluster, "清理前再次核验节点归属");
        }
        await run(kind, ["delete", "cluster", "--name", cluster, "--kubeconfig", kubeconfig], { env, cleanup: true, timeout: 180000 });
      } catch (error) { errors.push(error.message); }
    }
    if (!errors.length && fs.existsSync(kubeconfig)) {
      assert.equal(path.dirname(path.resolve(kubeconfig)), path.resolve(qaDirectory));
      fs.rmSync(kubeconfig);
    }
    report.finishedAt = new Date().toISOString();
    report.cleanupErrors = errors;
    if (errors.length) report.passed = false;
    const reportPath = path.join(qaDirectory, `kubernetes-${suffix}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    fs.writeFileSync(path.join(qaDirectory, "validation-kubernetes.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`验证记录：${reportPath}`);
    if (errors.length) throw new Error(`测试集群清理失败：${errors.join("；")}`);
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode ||= 1; });
