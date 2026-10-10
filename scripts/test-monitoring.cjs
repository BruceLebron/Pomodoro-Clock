"use strict";

// 监控验证使用唯一 Compose 项目；退出时只清理由本次 runID 标记的资源。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { run, request, waitUntil, registerSignals, projectRoot, version } = require("./test-container.cjs");

function isMissingResource(type, name, result) {
  // 只接受该资源精确名称对应的“没有找到”；daemon 连接/权限错误仍必须停止验证。
  const nouns = { container: "(?:object|container)", volume: "volume", network: "network" };
  if (!nouns[type] || result.code !== 1) return false;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const legacy = new RegExp(`^(?:Error(?: response from daemon)?:\\s*)?No such ${nouns[type]}:\\s*${escapedName}$`, "i");
  const network = new RegExp(`^Error response from daemon:\\s*network\\s+${escapedName}\\s+not found$`, "i");
  const volume = new RegExp(`^Error response from daemon:\\s*get\\s+${escapedName}:\\s*no such volume$`, "i");
  const lines = (result.stderr || "").trim().split(/\r?\n/).filter(Boolean);
  const stdout = (result.stdout || "").trim();
  return lines.length > 0 && (!stdout || stdout === "[]") && lines.every((line) => legacy.test(line.trim()) || (type === "network" && network.test(line.trim())) || (type === "volume" && volume.test(line.trim())));
}

async function unusedLocalPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function main() {
  registerSignals();
  const runID = randomUUID();
  const suffix = runID.replaceAll("-", "");
  const project = `tomato-monitoring-qa-${suffix}`;
  const qaDirectory = path.join(projectRoot, ".qa");
  fs.mkdirSync(qaDirectory, { recursive: true });
  const overridePath = path.join(qaDirectory, `monitoring-${suffix}.yaml`);
  const rootCompose = path.join(projectRoot, "compose.yaml");
  const checks = [];
  const report = { type: "monitoring", runID, project, version, checks, passed: false, startedAt: new Date().toISOString() };
  let rootSnapshot;
  let overrideSnapshot;
  let config;
  let creationAttempted = false;
  let projectWasEmpty = false;
  const argumentsForCompose = ["compose", "--project-directory", projectRoot, "-f", rootCompose, "-f", overridePath, "--project-name", project, "--profile", "monitoring"];

  async function compose(args, options = {}) {
    return run("docker", [...argumentsForCompose, ...args], options);
  }

  async function inspect(type, name, cleanup = false) {
    const args = type === "container" ? ["inspect", name] : [type, "inspect", name];
    const result = await run("docker", args, { quiet: true, allowFailure: true, cleanup });
    if (result.ok) return JSON.parse(result.stdout)[0];
    if (isMissingResource(type, name, result)) return null;
    throw new Error(`无法核验 ${type} ${name}：${result.stderr || result.message}`);
  }

  async function resourcesWithProjectLabel(cleanup = false) {
    const filter = `label=com.docker.compose.project=${project}`;
    const calls = [
      ["ps", "--all", "--filter", filter, "--format", "{{.ID}}"],
      ["volume", "ls", "--filter", filter, "--format", "{{.Name}}"],
      ["network", "ls", "--filter", filter, "--format", "{{.ID}}"]
    ];
    const results = await Promise.all(calls.map((args) => run("docker", args, { quiet: true, cleanup })));
    return results.map(({ stdout }) => stdout.trim() ? stdout.trim().split(/\r?\n/) : []);
  }

  function confirmOwned(labels, description) {
    assert.equal(labels?.["com.docker.compose.project"], project, `${description} 必须属于本次随机项目`);
    assert.equal(labels?.["io.tomato.qa.run"], runID, `${description} 必须由本次验证创建`);
    assert.equal(labels?.["io.tomato.qa.test"], "true", `${description} 必须明确标记为测试资源`);
  }

  async function confirmProjectResources(cleanup = false) {
    const [containers, volumes, networks] = await resourcesWithProjectLabel(cleanup);
    const expectedVolumes = new Set(Object.values(config.volumes).map((value) => value.name));
    const expectedNetworks = new Set(Object.values(config.networks).map((value) => value.name));
    const serviceNames = new Set(["tomato", "prometheus"]);
    for (const id of containers) {
      const info = await inspect("container", id, cleanup);
      assert.ok(info, "列出的测试容器必须仍可核验");
      confirmOwned(info.Config.Labels, "测试容器");
      const service = info.Config.Labels["com.docker.compose.service"];
      assert.ok(serviceNames.has(service), "只允许验证清单中的两个服务");
      assert.ok([`${project}-${service}-1`, `${project}_${service}_1`].includes(info.Name.replace(/^\//, "")), "测试容器名称必须有唯一项目名前缀");
    }
    for (const name of volumes) assert.ok(expectedVolumes.has(name), "拒绝清理项目中未预期的卷");
    for (const id of networks) {
      const info = await inspect("network", id, cleanup);
      assert.ok(info && expectedNetworks.has(info.Name), "拒绝清理项目中未预期的网络");
      confirmOwned(info.Labels, "测试网络");
    }
    // 同时检查精确名称，防止同名资源没有项目标签而逃过上述列表检查。
    for (const name of expectedVolumes) {
      const info = await inspect("volume", name, cleanup);
      if (info) confirmOwned(info.Labels, "测试数据卷");
    }
    for (const name of expectedNetworks) {
      const info = await inspect("network", name, cleanup);
      if (info) confirmOwned(info.Labels, "测试网络");
    }
  }

  async function query(base, expression) {
    const body = (await request(base, `/api/v1/query?query=${encodeURIComponent(expression)}`)).json();
    assert.equal(body.status, "success", "Prometheus 查询应成功");
    assert.equal(body.data.resultType, "vector");
    return body.data.result;
  }

  function requireSingleValue(vector, value, description) {
    assert.equal(vector.length, 1, `${description} 应只有本次测试目标的一个时间序列`);
    assert.equal(vector[0].metric.job, "tomato");
    assert.equal(vector[0].metric.instance, "tomato:4187");
    assert.equal(Number(vector[0].value[1]), value, description);
  }

  try {
    rootSnapshot = fs.readFileSync(rootCompose, "utf8");
    const applicationPort = await unusedLocalPort();
    let prometheusPort = await unusedLocalPort();
    while (prometheusPort === applicationPort) prometheusPort = await unusedLocalPort();
    const labels = `      io.tomato.qa.run: ${JSON.stringify(runID)}\n      io.tomato.qa.test: "true"`;
    overrideSnapshot = [
      "# 仅本次验证使用；随机端口和项目名与用户正常运行的 Compose 完全分离。",
      "services:",
      "  tomato:",
      "    ports: !override",
      `      - "127.0.0.1:${applicationPort}:4187"`,
      "    labels:", labels,
      "  prometheus:",
      "    ports: !override",
      `      - "127.0.0.1:${prometheusPort}:9090"`,
      "    labels:", labels,
      "    volumes:",
      "      - type: bind",
      `        source: ${JSON.stringify(path.join(projectRoot, "deploy", "monitoring", "rules.test.yml"))}`,
      "        target: /etc/prometheus/rules.test.yml",
      "        read_only: true",
      "volumes:",
      "  tomato-data:", "    labels:", labels,
      "  prometheus-data:", "    labels:", labels,
      "networks:", "  default:", "    labels:", labels,
      ""
    ].join("\n");
    fs.writeFileSync(overridePath, overrideSnapshot);
    const rendered = await compose(["config", "--format", "json"], { quiet: true });
    config = JSON.parse(rendered.stdout);
    assert.deepEqual(Object.keys(config.services).sort(), ["prometheus", "tomato"], "只启动预期的两个服务");
    assert.deepEqual(Object.keys(config.volumes).sort(), ["prometheus-data", "tomato-data"]);
    assert.deepEqual(Object.keys(config.networks), ["default"]);
    for (const [name, value] of Object.entries(config.volumes)) {
      assert.equal(value.external, undefined, "不允许使用用户外部数据卷");
      assert.equal(value.name, `${project}_${name}`, "数据卷必须以唯一项目名命名");
      assert.equal(value.labels["io.tomato.qa.run"], runID);
    }
    assert.equal(config.networks.default.name, `${project}_default`);
    assert.equal(config.networks.default.external, undefined);
    for (const [service, port, target] of [["tomato", applicationPort, 4187], ["prometheus", prometheusPort, 9090]]) {
      const ports = config.services[service].ports;
      assert.equal(ports.length, 1, "!override 必须替换默认端口，不能追加");
      assert.equal(ports[0].host_ip, "127.0.0.1");
      assert.equal(Number(ports[0].published), port);
      assert.equal(ports[0].target, target);
      assert.equal(config.services[service].labels["io.tomato.qa.run"], runID);
    }
    report.applicationPort = applicationPort;
    report.prometheusPort = prometheusPort;
    report.prometheusImage = config.services.prometheus.image;

    await run("docker", ["info", "--format", "{{.OSType}}"], { quiet: true });
    const before = await resourcesWithProjectLabel();
    assert.ok(before.every((list) => list.length === 0), "随机项目必须没有任何已有资源");
    for (const name of Object.values(config.volumes).map((value) => value.name)) assert.equal(await inspect("volume", name), null, "测试数据卷名称必须未使用");
    for (const name of Object.values(config.networks).map((value) => value.name)) assert.equal(await inspect("network", name), null, "测试网络名称必须未使用");
    for (const service of ["tomato", "prometheus"]) {
      for (const name of [`${project}-${service}-1`, `${project}_${service}_1`]) assert.equal(await inspect("container", name), null, "测试容器名称必须未使用");
    }
    projectWasEmpty = true;
    creationAttempted = true;
    await compose(["up", "--build", "--detach", "--wait", "--wait-timeout", "120"], { timeout: 600000 });
    await confirmProjectResources();
    checks.push("随机项目、独立数据卷、随机回环端口及资源归属确认");

    const base = `http://127.0.0.1:${applicationPort}`;
    const prometheus = `http://127.0.0.1:${prometheusPort}`;
    await waitUntil(async () => {
      const body = (await request(prometheus, "/api/v1/targets")).json();
      assert.equal(body.status, "success");
      const targets = body.data.activeTargets.filter((target) => target.labels.job === "tomato");
      assert.equal(targets.length, 1);
      assert.equal(targets[0].scrapeUrl, "http://tomato:4187/metrics");
      assert.equal(targets[0].health, "up");
      assert.equal(targets[0].lastError, "");
    }, 90000, "Prometheus 首次成功采集应用");
    requireSingleValue(await query(prometheus, 'up{job="tomato"}'), 1, "up 指标");
    requireSingleValue(await query(prometheus, 'tomato_sessions_saved_total{job="tomato"}'), 0, "新项目的写入计数基线");
    const initial = (await request(base, "/api/sessions")).json();
    assert.equal(initial.total, 0, "独立测试卷必须没有用户历史数据");
    checks.push("真实 targets health=up，PromQL up=1，独立空数据库和写入计数基线=0");

    await confirmProjectResources();
    await compose(["exec", "-T", "prometheus", "/bin/promtool", "check", "config", "/etc/prometheus/prometheus.yml"]);
    await compose(["exec", "-T", "--workdir", "/etc/prometheus", "prometheus", "/bin/promtool", "test", "rules", "/etc/prometheus/rules.test.yml"]);
    checks.push("运行中的固定版本 promtool 配置校验与 5 组告警规则测试通过");
    const alerts = await waitUntil(async () => {
      const rules = (await request(prometheus, "/api/v1/rules")).json();
      assert.equal(rules.status, "success");
      const found = rules.data.groups.flatMap((group) => group.rules).filter((rule) => rule.type === "alerting");
      assert.deepEqual(found.map((rule) => rule.name).sort(), ["TomatoAPIErrorRate", "TomatoDatabaseErrors", "TomatoTargetDown"]);
      assert.ok(found.every((rule) => rule.health === "ok" && !rule.lastError), "所有告警规则应正常计算");
      return found;
    }, 90000, "首次成功计算 3 条告警规则");
    report.alertRules = alerts.map((rule) => rule.name);
    checks.push("Prometheus 已加载且正常计算 3 条告警规则");

    const session = { completedAt: Date.now(), minutes: 1, task: `监控写入验证 ${runID}` };
    const options = { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ sessions: [session] }) };
    const first = (await request(base, "/api/sessions", options)).json();
    const duplicate = (await request(base, "/api/sessions", options)).json();
    assert.equal(first.saved, 1);
    assert.equal(duplicate.saved, 0);
    assert.equal(first.sessions[0].id, duplicate.sessions[0].id);
    await waitUntil(async () => {
      requireSingleValue(await query(prometheus, 'tomato_sessions_saved_total{job="tomato"}'), 1, "仅新记录增加写入计数");
    }, 60000, "Prometheus 采集新记录写入计数");
    const final = (await request(base, "/api/sessions")).json();
    assert.equal(final.total, 1);
    report.sessionsSavedMetric = 1;
    checks.push("真实 POST 首次 saved=1、重复 saved=0，随后 PromQL 写入计数=1");
    report.passed = true;
    console.log("监控采集和告警规则实测通过。");
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    const errors = [];
    if (creationAttempted) {
      try {
        assert.equal(projectWasEmpty, true, "只能清理执行前已确认不存在的随机项目");
        assert.equal(fs.readFileSync(rootCompose, "utf8"), rootSnapshot, "清理前确认根清单没有被修改");
        assert.equal(fs.readFileSync(overridePath, "utf8"), overrideSnapshot, "清理前确认本次覆盖清单没有被修改");
        await confirmProjectResources(true);
        // 本次项目使用唯一命名卷；归属核验通过后才能删除它们。
        await compose(["down", "--volumes", "--timeout", "15"], { cleanup: true });
        const after = await resourcesWithProjectLabel(true);
        assert.ok(after.every((list) => list.length === 0), "本次项目容器、卷、网络应全部清理");
        for (const name of Object.values(config.volumes).map((value) => value.name)) assert.equal(await inspect("volume", name, true), null, "本次临时数据卷应已删除");
        report.cleanedUp = true;
      } catch (error) { errors.push(error.message); }
    } else report.cleanedUp = true;
    report.cleanupErrors = errors;
    report.finishedAt = new Date().toISOString();
    if (errors.length) report.passed = false;
    const output = JSON.stringify(report, null, 2) + "\n";
    const uniqueReport = path.join(qaDirectory, `monitoring-${suffix}.json`);
    fs.writeFileSync(uniqueReport, output);
    fs.writeFileSync(path.join(qaDirectory, "validation-monitoring.json"), output);
    console.log(`验证记录：${uniqueReport}`);
    if (errors.length) throw new Error(`临时监控资源清理失败：${errors.join("；")}`);
  }
}

module.exports = { isMissingResource };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode ||= 1; });
