"use strict";

// 本脚本只创建带随机名称及归属标签的测试容器/卷，不读取用户真实数据卷。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const projectRoot = path.resolve(__dirname, "..");
const version = "0.4.0";
const image = process.env.TOMATO_TEST_IMAGE || `tomato-clock:${version}`;
const cancellation = new AbortController();

async function run(command, args, options = {}) {
  const { timeout = 120000, quiet = false, allowFailure = false, cleanup = false, env = process.env } = options;
  if (!quiet) console.log(`> ${command} ${args.join(" ")}`);
  try {
    const result = await execute(command, args, {
      cwd: projectRoot, env, timeout, windowsHide: true, shell: false,
      maxBuffer: 16 * 1024 * 1024, signal: cleanup ? undefined : cancellation.signal
    });
    if (!quiet && result.stdout.trim()) console.log(result.stdout.trim());
    if (!quiet && result.stderr.trim()) console.log(result.stderr.trim());
    return { ...result, ok: true };
  } catch (error) {
    const result = { stdout: error.stdout || "", stderr: error.stderr || "", ok: false, code: error.code, message: error.message };
    if (allowFailure) return result;
    throw new Error(`${command} 失败：${result.stderr.trim() || result.stdout.trim() || error.message}`, { cause: error });
  }
}

async function request(base, pathname, options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  cancellation.signal.addEventListener("abort", abort, { once: true });
  if (cancellation.signal.aborted) abort();
  const timer = setTimeout(abort, 5000);
  try {
    const response = await fetch(base + pathname, { ...options, signal: controller.signal });
    const text = await response.text();
    assert.equal(response.status, 200, `${pathname} 返回 HTTP ${response.status}：${text}`);
    return { text, json: () => JSON.parse(text), headers: response.headers };
  } finally {
    clearTimeout(timer);
    cancellation.signal.removeEventListener("abort", abort);
  }
}

async function waitUntil(check, timeout = 90000, description = "服务就绪") {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    if (cancellation.signal.aborted) throw new Error("部署验证已被中断");
    try { return await check(); } catch (error) {
      if (error.fatal) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${description} 超时：${lastError?.message || "未满足条件"}`);
}

async function verifyEndpoints(base, checks) {
  for (const pathname of ["/healthz", "/livez", "/readyz"]) {
    const body = (await request(base, pathname)).json();
    assert.equal(body.status, "ok", `${pathname} 状态`);
    assert.equal(body.version, version, `${pathname} 运行版本`);
    checks.push(`${pathname} HTTP 200`);
  }
  const page = await request(base, "/");
  assert.match(page.text, /<html/i);
  assert.match(page.text, /番茄/);
  checks.push("网页 HTML 可访问");
  const sessions = (await request(base, "/api/sessions")).json();
  assert.ok(Array.isArray(sessions.sessions));
  assert.ok(Number.isInteger(sessions.total));
  checks.push("专注记录 API 可访问");
  const metrics = await request(base, "/metrics");
  assert.match(metrics.text, /^# (HELP|TYPE) /m, "Prometheus 指标格式");
  assert.match(metrics.headers.get("content-type"), /text\/plain|application\/openmetrics-text/i);
  assert.match(metrics.text, /^tomato_build_info\{version="0\.4\.0"\} 1$/m, "版本指标");
  assert.match(metrics.text, /^tomato_http_requests_total\{[^}\n]*route="\/api\/sessions"/m, "API 请求计数指标");
  assert.match(metrics.text, /^tomato_http_request_duration_seconds_bucket\{/m, "请求延迟直方图");
  assert.match(metrics.text, /^tomato_sessions_saved_total \d+/m, "专注写入计数指标");
  checks.push("Prometheus 指标可访问");
}

async function saveAndDeduplicate(base, session, checks) {
  const options = { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ sessions: [session] }) };
  const first = (await request(base, "/api/sessions", options)).json();
  assert.equal(first.saved, 1, "首次提交写入一条记录");
  assert.equal(first.sessions[0].task, session.task);
  const duplicate = (await request(base, "/api/sessions", options)).json();
  assert.equal(duplicate.saved, 0, "重复提交不新增记录");
  assert.equal(duplicate.sessions[0].id, first.sessions[0].id, "幂等内容键一致");
  checks.push("专注写入及重复提交 saved=0");
  return first.sessions[0].id;
}

async function verifyStored(base, session, id) {
  const body = (await request(base, "/api/sessions")).json();
  const found = body.sessions.filter((item) => item.completedAt === session.completedAt && item.minutes === session.minutes && item.task === session.task);
  assert.equal(found.length, 1, "重建后原专注记录仅一条");
  assert.equal(found[0].id, id, "重建后服务端记录 id 一致");
}

function registerSignals() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      console.error(`收到 ${signal}，停止验证并清理本次临时资源。`);
      cancellation.abort();
      process.exitCode = signal === "SIGINT" ? 130 : 143;
    });
  }
}

async function main() {
  registerSignals();
  const runID = randomUUID();
  const suffix = runID.replaceAll("-", "");
  const volume = `tomato-qa-volume-${suffix}`;
  const containers = [`tomato-qa-${suffix}-first`, `tomato-qa-${suffix}-second`];
  const labels = ["--label", `io.tomato.qa.run=${runID}`, "--label", "io.tomato.qa.test=true"];
  const checks = [];
  const report = { type: "container", runID, version, image, checks, passed: false, startedAt: new Date().toISOString() };
  const qaDirectory = path.join(projectRoot, ".qa");
  fs.mkdirSync(qaDirectory, { recursive: true });
  let volumeAttempted = false;
  const attemptedContainers = new Set();

  async function inspectContainer(name, cleanup = false) {
    const result = await run("docker", ["inspect", name], { quiet: true, allowFailure: true, cleanup });
    if (result.ok) return JSON.parse(result.stdout)[0];
    if (/no such (object|container)/i.test(result.stderr + result.stdout)) return null;
    throw new Error(`无法核验测试容器归属：${result.stderr || result.message}`);
  }

  async function removeOwnedContainer(name) {
    const inspected = await inspectContainer(name, true);
    if (!inspected) return;
    assert.equal(inspected.Config.Labels?.["io.tomato.qa.run"], runID, "拒绝清理非本次创建的容器");
    assert.equal(inspected.Config.Labels?.["io.tomato.qa.test"], "true");
    await run("docker", ["stop", "--time", "10", name], { cleanup: true, allowFailure: true });
    await run("docker", ["rm", name], { cleanup: true });
  }

  async function startContainer(name) {
    assert.equal(await inspectContainer(name), null, "测试容器名必须尚未被使用");
    attemptedContainers.add(name);
    await run("docker", ["create", "--name", name, ...labels, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
      "--publish", "127.0.0.1::4187", "--mount", `type=volume,source=${volume},target=/data`, "--env", "BIND_ADDR=0.0.0.0", "--env", "PORT=4187", "--env", "DB_PATH=/data/tomato.db", image]);
    await run("docker", ["start", name]);
    const mapping = (await run("docker", ["port", name, "4187/tcp"], { quiet: true })).stdout.trim();
    const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping);
    assert.ok(match, `必须只发布本机随机端口：${mapping}`);
    const base = `http://127.0.0.1:${match[1]}`;
    await waitUntil(async () => {
      const info = await inspectContainer(name);
      assert.equal(info?.State.Running, true, "测试容器应运行");
      await request(base, "/readyz");
      return base;
    }, 90000, "容器 readiness");
    return base;
  }

  try {
    assert.match(image, /^[a-z0-9][a-z0-9._/:@-]*$/, "镜像名称格式不正确");
    // daemon 不可用就失败，不将未执行的部署验证伪装为通过。
    const engine = await run("docker", ["info", "--format", "{{.OSType}}"]);
    assert.equal(engine.stdout.trim(), "linux", "部署验证需要 Docker Linux 容器引擎");
    await run("docker", ["build", "--tag", image, "."], { timeout: 600000 });
    const previousVolume = await run("docker", ["volume", "inspect", volume], { quiet: true, allowFailure: true });
    assert.equal(previousVolume.ok, false, "测试卷名必须尚未被使用");
    assert.match(previousVolume.stderr + previousVolume.stdout, /no such volume/i, "核验测试卷不存在时 daemon 仍应可用");
    volumeAttempted = true;
    await run("docker", ["volume", "create", ...labels, volume]);
    let base = await startContainer(containers[0]);
    const info = await inspectContainer(containers[0]);
    assert.match(info.Config.User, /^10001(?::10001)?$/, "镜像应以 UID 10001 运行");
    assert.equal(info.HostConfig.ReadonlyRootfs, true);
    assert.ok(info.HostConfig.CapDrop.includes("ALL"));
    assert.ok(info.HostConfig.SecurityOpt.some((item) => item === "no-new-privileges=true" || item === "no-new-privileges"));
    const processList = (await run("docker", ["top", containers[0], "-eo", "uid,pid,args"], { quiet: true })).stdout;
    const rows = processList.trim().split(/\r?\n/).slice(1);
    assert.ok(rows.length > 0 && rows.every((line) => /^\s*10001\s/.test(line)), "实际进程 UID 应为 10001");
    const blocked = await run("docker", ["exec", "--env", `DB_PATH=/tomato-qa-${suffix}/blocked.db`, containers[0], "/tomato"], { quiet: true, allowFailure: true, timeout: 10000 });
    assert.equal(blocked.ok, false, "只读根目录应拒绝创建数据库目录");
    assert.match(blocked.stdout + blocked.stderr, /read-only file system/i, "实际根目录写入应被只读文件系统拒绝");
    checks.push("运行进程 UID 10001、只读根目录拒绝写入、drop ALL、no-new-privileges");
    await run("docker", ["exec", containers[0], "/tomato", "healthcheck"]);
    await verifyEndpoints(base, checks);
    const session = { completedAt: Date.now(), minutes: 1, task: `容器持久化验证 ${runID}` };
    const id = await saveAndDeduplicate(base, session, checks);
    await waitUntil(async () => {
      const current = await inspectContainer(containers[0]);
      assert.equal(current?.State.Health?.Status, "healthy", "Docker HEALTHCHECK");
    }, 120000, "Docker HEALTHCHECK healthy");
    checks.push("Docker HEALTHCHECK healthy");
    await removeOwnedContainer(containers[0]);
    base = await startContainer(containers[1]);
    await verifyStored(base, session, id);
    await verifyEndpoints(base, checks);
    checks.push("删除并重建容器后同一测试卷的 SQLite 记录保留");
    report.passed = true;
    console.log("容器部署实测通过。");
  } catch (error) {
    report.error = error.message;
    for (const name of attemptedContainers) {
      const info = await inspectContainer(name, true);
      if (info?.Config.Labels?.["io.tomato.qa.run"] === runID) await run("docker", ["logs", "--tail", "60", name], { cleanup: true, allowFailure: true });
    }
    throw error;
  } finally {
    const errors = [];
    for (const name of attemptedContainers) {
      try { await removeOwnedContainer(name); } catch (error) { errors.push(error.message); }
    }
    if (volumeAttempted) {
      try {
        const inspected = await run("docker", ["volume", "inspect", volume], { quiet: true, allowFailure: true, cleanup: true });
        if (inspected.ok) {
          const info = JSON.parse(inspected.stdout)[0];
          assert.equal(info.Labels?.["io.tomato.qa.run"], runID, "拒绝删除非本次测试卷");
          assert.equal(info.Labels?.["io.tomato.qa.test"], "true", "仅删除明确标记的唯一临时测试卷");
          await run("docker", ["volume", "rm", volume], { cleanup: true });
        } else if (!/no such volume/i.test(inspected.stderr + inspected.stdout)) throw new Error(`无法核验测试卷归属：${inspected.stderr || inspected.message}`);
      } catch (error) { errors.push(error.message); }
    }
    report.finishedAt = new Date().toISOString();
    report.cleanupErrors = errors;
    if (errors.length) report.passed = false;
    const reportPath = path.join(qaDirectory, `container-${suffix}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    fs.writeFileSync(path.join(qaDirectory, "validation-container.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`验证记录：${reportPath}`);
    if (errors.length) throw new Error(`临时资源清理失败：${errors.join("；")}`);
  }
}

module.exports = { run, request, waitUntil, verifyEndpoints, saveAndDeduplicate, verifyStored, registerSignals, projectRoot, version, image };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode ||= 1; });
