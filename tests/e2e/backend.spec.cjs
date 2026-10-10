const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const core = require("../../timer-core.js");
const backendURL = "http://127.0.0.1:4200";
const now = Date.UTC(2026, 9, 11, 2);

// 所有案例共用临时 Go 数据库，任务名独立，断言始终按任务过滤。
function taskPrefix(testInfo) {
  return `${testInfo.project.name}-${randomUUID().slice(0, 8)}`;
}

async function matchingSessions(request, task) {
  const response = await request.get(`${backendURL}/api/sessions`);
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  return payload.sessions.filter((session) => session.task === task);
}

async function seedV2(page, sessions) {
  await page.addInitScript((sessions) => {
    // 每个浏览器只播种一次，reload 必须从应用真实保存的状态恢复。
    if (sessionStorage.getItem("backend-seeded")) return;
    localStorage.setItem("tomato.state.v2", JSON.stringify({
      version: 2,
      settings: { focus: 1, break: 1, sound: false },
      mode: "focus",
      task: "",
      activeTask: null,
      remainingMs: 60000,
      running: false,
      endAt: null,
      sessions
    }));
    sessionStorage.setItem("backend-seeded", "1");
  }, sessions);
}

async function completeMinute(page, task) {
  await page.locator("#focus-duration").fill("1");
  await page.getByRole("button", { name: "保存时长" }).click();
  await page.locator("#task-name").fill(task);
  await page.getByRole("button", { name: "开始专注" }).click();
  await page.clock.fastForward(60000);
  await page.locator("#history-query").fill(task);
  await expect(page.locator("#history-list li")).toHaveCount(1);
  await expect(page.locator("#history-list")).toContainText(task);
}

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  page.__backendErrors = [];
  page.on("pageerror", (error) => page.__backendErrors.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(page.__backendErrors).toEqual([]);
});

test("Go 健康检查与真实页面资源可以访问", async ({ page, request }, testInfo) => {
  const health = await request.get(`${backendURL}/healthz`);
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ status: "ok", version: "0.3.0" });
  const response = await page.goto(backendURL);
  expect(response.status()).toBe(200);
  await expect(page.locator("#time-display")).toHaveText("25:00");
  await expect(page.locator("#sync-status")).toBeVisible();
  await expect(page.locator("#sync-now")).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("backend-initial-layout.png"), fullPage: true });
});

test("专注完成写入 API，独立浏览器可以读取且刷新不重复", async ({ page, browser, request }, testInfo) => {
  const task = `${taskPrefix(testInfo)}-跨浏览器专注`;
  await page.goto(backendURL);
  await expect(page.locator("#sync-now")).toBeEnabled();
  await completeMinute(page, task);
  await expect.poll(async () => (await matchingSessions(request, task)).length).toBe(1);
  const [saved] = await matchingSessions(request, task);
  expect(saved).toMatchObject({ completedAt: now + 60000, minutes: 1, task });
  expect(saved.id).toBeTruthy();

  // 独立上下文不共享 localStorage，只有后端才能把这条记录提供给第二个浏览器。
  const secondContext = await browser.newContext({
    viewport: testInfo.project.use.viewport,
    isMobile: Boolean(testInfo.project.use.isMobile),
    hasTouch: Boolean(testInfo.project.use.hasTouch),
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai"
  });
  try {
    const secondPage = await secondContext.newPage();
    await secondPage.clock.install({ time: now + 60000 });
    await secondPage.clock.pauseAt(now + 60000);
    await secondPage.goto(backendURL);
    await secondPage.locator("#history-query").fill(task);
    await expect(secondPage.locator("#history-list li")).toHaveCount(1);
    await expect(secondPage.locator("#history-list")).toContainText(task);
    await secondPage.reload();
    await secondPage.locator("#history-query").fill(task);
    await expect(secondPage.locator("#history-list li")).toHaveCount(1);
  } finally {
    await secondContext.close();
  }
  await page.reload();
  await expect(page.locator("#sync-now")).toBeEnabled();
  await page.locator("#sync-now").click();
  await expect(page.locator("#sync-now")).toBeEnabled();
  expect(await matchingSessions(request, task)).toHaveLength(1);
});

test("第二版本地记录迁移到 SQLite，重新载入与再次同步均幂等", async ({ page, request }, testInfo) => {
  const task = `${taskPrefix(testInfo)}-第二版旧记录`;
  const localRecord = { completedAt: now - 86400000, minutes: 25, task };
  await seedV2(page, [localRecord]);
  await page.goto(backendURL);
  await expect.poll(async () => (await matchingSessions(request, task)).length).toBe(1);
  await page.locator("#history-query").fill(task);
  await expect(page.locator("#history-list li")).toHaveCount(1);
  await expect(page.locator("#focus-duration")).toHaveValue("1");
  await expect(page.locator("#sound-toggle")).not.toBeChecked();
  await page.reload();
  await expect(page.locator("#sync-now")).toBeEnabled();
  await page.locator("#sync-now").click();
  await expect(page.locator("#sync-now")).toBeEnabled();
  expect(await matchingSessions(request, task)).toHaveLength(1);
  expect((await matchingSessions(request, task))[0]).toMatchObject(localRecord);
});

test("旧存档的 emoji 截断与孤立代理字符正规化后可完整同步", async ({ page, request }, testInfo) => {
  const prefix = taskPrefix(testInfo);
  const oldRecords = [
    { completedAt: now - 2000, minutes: 25, task: `${prefix}-emoji边界`.padEnd(79, "a") + "🍅" },
    { completedAt: now - 1000, minutes: 25, task: `${prefix}-孤立\uD800代理` }
  ];
  // 以真实核心迁移规则为预期，API 应保存正规化后的文本，而不是损坏原文。
  const expected = core.restore({ version: 2, sessions: oldRecords }).sessions;
  expect(expected[0].task).not.toBe(oldRecords[0].task);
  expect(expected[1].task).not.toBe(oldRecords[1].task);
  await seedV2(page, oldRecords);
  await page.goto(backendURL);
  await expect(page.locator("#sync-strip")).toHaveClass(/\bsynced\b/);
  for (const session of expected) {
    const persisted = await matchingSessions(request, session.task);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject(session);
  }
  await page.locator("#history-query").fill(prefix);
  await expect(page.locator("#history-list li")).toHaveCount(2);
  await page.reload();
  await expect(page.locator("#sync-strip")).toHaveClass(/\bsynced\b/);
  for (const session of expected) expect(await matchingSessions(request, session.task)).toHaveLength(1);
});

test("GET 失败保留本地旧记录，恢复连接后手动同步成功", async ({ page, request }, testInfo) => {
  const task = `${taskPrefix(testInfo)}-读取失败暂存`;
  await seedV2(page, [{ completedAt: now - 1000, minutes: 25, task }]);
  await page.route("**/api/sessions", (route) => route.request().method() === "GET" ? route.abort("failed") : route.continue());
  await page.goto(backendURL);
  await expect(page.locator("#sync-strip")).toHaveClass(/offline/);
  await expect(page.locator("#sync-detail")).toContainText("1 条记录留在浏览器");
  await page.locator("#history-query").fill(task);
  await expect(page.locator("#history-list li")).toHaveCount(1);
  await expect(page.locator("#history-list")).toContainText(task);
  const localRecords = await page.evaluate(() => JSON.parse(localStorage.getItem("tomato.state.v2")).sessions);
  expect(localRecords.some((session) => session.task === task)).toBeTruthy();
  await page.unroute("**/api/sessions");
  await page.locator("#sync-now").click();
  await expect.poll(async () => (await matchingSessions(request, task)).length).toBe(1);
  await expect(page.locator("#sync-now")).toBeEnabled();
});

test("POST 失败仍能完成计时，刷新保留待同步记录并可恢复上传", async ({ page, request }, testInfo) => {
  const task = `${taskPrefix(testInfo)}-写入失败暂存`;
  await page.route("**/api/sessions", (route) => route.request().method() === "POST" ? route.abort("failed") : route.continue());
  await page.goto(backendURL);
  await expect(page.locator("#sync-now")).toBeEnabled();
  await completeMinute(page, task);
  await expect(page.locator("#sync-strip")).toHaveClass(/offline/);
  await expect(page.locator("#sync-detail")).toContainText("1 条记录留在浏览器");
  expect(await matchingSessions(request, task)).toHaveLength(0);
  await page.reload();
  await page.locator("#history-query").fill(task);
  await expect(page.locator("#history-list li")).toHaveCount(1);
  await expect(page.locator("#sync-now")).toBeEnabled();
  await page.unroute("**/api/sessions");
  await page.locator("#sync-now").click();
  await expect.poll(async () => (await matchingSessions(request, task)).length).toBe(1);
  await expect(page.locator("#sync-now")).toBeEnabled();
  await page.locator("#sync-now").click();
  await expect(page.locator("#sync-now")).toBeEnabled();
  expect(await matchingSessions(request, task)).toHaveLength(1);
});

test("后端历史支持筛选分页与真实 CSV 下载，任务文本安全展示", async ({ page, request }, testInfo) => {
  const prefix = taskPrefix(testInfo);
  const sessions = Array.from({ length: 10 }, (_, index) => ({
    completedAt: now - index * 60000,
    minutes: 25,
    task: `${prefix} ${index === 0 ? '<img src=x onerror="alert(1)">' : index === 1 ? '阅读, "Go"' : `学习 Go ${index}`}`
  }));
  const saved = await request.post(`${backendURL}/api/sessions`, { data: { sessions } });
  expect(saved.ok()).toBeTruthy();
  await page.goto(backendURL);
  await page.locator("#history-query").fill(prefix);
  await expect(page.locator("#history-summary")).toHaveText("共 10 条记录 · 250 分钟");
  await expect(page.locator("#history-list li")).toHaveCount(8);
  await expect(page.locator("#history-list img")).toHaveCount(0);
  await expect(page.locator("#history-list")).toContainText('<img src=x onerror="alert(1)">');
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.locator("#history-list li")).toHaveCount(2);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出筛选记录 CSV" }).click();
  const download = await downloadPromise;
  const csv = await fs.readFile(await download.path(), "utf8");
  expect(csv.startsWith("\uFEFF")).toBeTruthy();
  expect(csv.split("\r\n")).toHaveLength(12);
  expect(csv).toContain(`${prefix} 阅读, ""Go""`);
  for (const session of sessions) expect(csv).toContain(session.task.replace(/"/g, '""'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("backend-history-layout.png"), fullPage: true });
});
