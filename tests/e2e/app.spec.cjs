const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const now = Date.UTC(2026, 9, 11, 2);

test.beforeEach(async ({ page }) => {
  // 每条测试用独立浏览器上下文和测试端口，不访问真实用户存档。
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.__errors = errors;
});

test.afterEach(async ({ page }) => { expect(page.__errors).toEqual([]); });

test("直接打开 HTML 可本地计时，刷新保留记录且不尝试不存在的 API", async ({ page }) => {
  const apiRequests = [];
  page.on("request", (request) => { if (request.url().includes("/api/sessions")) apiRequests.push(request.url()); });
  await page.goto(pathToFileURL(path.resolve(__dirname, "../../index.html")).href);
  await expect(page.locator("#sync-status")).toContainText("仅保存在浏览器");
  await page.locator("#focus-duration").fill("1");
  await page.getByRole("button", { name: "保存时长" }).click();
  await page.locator("#task-name").fill("本地离线专注");
  await page.getByRole("button", { name: "开始专注" }).click();
  await page.clock.fastForward(60000);
  await expect(page.locator("#history-list li")).toHaveCount(1);
  await expect(page.locator("#history-list")).toContainText("本地离线专注");
  await page.reload();
  await expect(page.locator("#history-list li")).toHaveCount(1);
  await page.locator("#sync-now").click();
  await expect(page.locator("#sync-status")).toContainText("仅保存在浏览器");
  expect(apiRequests).toEqual([]);
});

async function seed(page, value, key = "tomato.state.v2") {
  await page.addInitScript(({ value, key }) => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem(key, JSON.stringify(value));
      sessionStorage.setItem("seeded", "1");
    }
  }, { value, key });
}

test("任务计时完成：暂停、刷新、继续与休息都不重复记账", async ({ page }) => {
  await page.goto("/");
  await page.locator("#focus-duration").fill("1");
  await page.locator("#break-duration").fill("1");
  await page.getByRole("button", { name: "保存时长" }).click();
  await page.locator("#task-name").fill("学习 Go");
  await page.getByRole("button", { name: "开始专注" }).click();
  await expect(page.locator("#task-name")).toBeDisabled();
  await page.clock.fastForward(15000);
  await expect(page.locator("#time-display")).toHaveText("00:45");
  await page.getByRole("button", { name: "暂停计时" }).click();
  await page.clock.fastForward(60000);
  await expect(page.locator("#time-display")).toHaveText("00:45");
  await page.reload();
  await expect(page.locator("#task-name")).toHaveValue("学习 Go");
  await expect(page.locator("#task-name")).toBeDisabled();
  await expect(page.locator("#time-display")).toHaveText("00:45");
  await page.getByRole("button", { name: "继续计时" }).click();
  await page.clock.fastForward(45000);
  await expect(page.locator("#today-count")).toHaveText("1");
  await expect(page.locator("#history-list li")).toHaveCount(1);
  await expect(page.locator("#history-list")).toContainText("学习 Go");
  await expect(page.getByRole("button", { name: "开始休息" })).toBeVisible();
  await page.clock.fastForward(120000);
  await expect(page.locator("#today-count")).toHaveText("1");
  await page.getByRole("button", { name: "开始休息" }).click();
  await page.clock.fastForward(60000);
  await expect(page.getByRole("button", { name: "开始专注" })).toBeVisible();
  await expect(page.locator("#history-list li")).toHaveCount(1);
});

test("第一版存档迁移后，运行中的计时与旧记录仍可恢复", async ({ page }) => {
  await seed(page, { version: 1, settings: { focus: 1, break: 5, sound: false }, mode: "focus", remainingMs: 60000, running: true, endAt: now + 50000, sessions: [{ completedAt: now - 86400000, minutes: 25 }] }, "tomato.state.v1");
  await page.goto("/");
  await expect(page.locator("#time-display")).toHaveText("00:50");
  await expect(page.locator("#history-list")).toContainText("未命名专注");
  await expect(page.locator("#sound-toggle")).not.toBeChecked();
  await page.clock.fastForward(50000);
  await expect(page.locator("#history-list li")).toHaveCount(2);
  await page.reload();
  await expect(page.locator("#history-list li")).toHaveCount(2);
  await expect(page.locator("#today-count")).toHaveText("1");
});

test("历史筛选、分页、特殊任务与实际 CSV 下载", async ({ page }, testInfo) => {
  const sessions = Array.from({ length: 10 }, (_, index) => ({ completedAt: now - (index % 3) * 86400000 - index * 60000, minutes: 25, task: `Go 学习 ${index}` }));
  sessions.push({ completedAt: now, minutes: 30, task: '<img src=x onerror="alert(1)">' }, { completedAt: now - 1000, minutes: 25, task: "=1+1" }, { completedAt: now - 2000, minutes: 25, task: '阅读, "Go"' });
  await seed(page, { version: 2, sessions });
  await page.goto("/");
  await expect(page.locator("#history-summary")).toHaveText("共 13 条记录 · 330 分钟");
  await expect(page.locator("#history-list li")).toHaveCount(8);
  await expect(page.locator("#history-list img")).toHaveCount(0);
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.locator("#history-list li")).toHaveCount(5);
  await page.locator("#history-query").fill("Go");
  await expect(page.locator("#history-summary")).toHaveText("共 11 条记录 · 275 分钟");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出筛选记录 CSV" }).click();
  const download = await downloadPromise;
  const text = await fs.readFile(await download.path(), "utf8");
  expect(text.startsWith("\uFEFF")).toBeTruthy();
  expect(text.split("\r\n")).toHaveLength(13);
  expect(text).toContain('"阅读, ""Go"""');
  await page.locator("#history-query").fill("");
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.locator("#history-summary")).toHaveText("共 7 条记录 · 180 分钟");
  await page.screenshot({ path: testInfo.outputPath("history-layout.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("真实 Web Audio 节点播放，关闭开关后静音并持久保存", async ({ page }) => {
  await page.addInitScript(() => {
    window.__soundStarts = 0;
    const original = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (...args) {
      const oscillator = original.apply(this, args);
      const start = oscillator.start.bind(oscillator);
      oscillator.start = (...times) => { window.__soundStarts++; return start(...times); };
      return oscillator;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "试听结束提示音" }).click();
  await expect.poll(() => page.evaluate(() => window.__soundStarts)).toBe(3);
  await page.locator("#sound-toggle").uncheck();
  await expect(page.locator("#preview-sound")).toBeDisabled();
  await page.getByRole("button", { name: "开始专注" }).click();
  expect(await page.evaluate(() => window.__soundStarts)).toBe(3);
  await page.reload();
  await expect(page.locator("#sound-toggle")).not.toBeChecked();
  await expect(page.locator("#sound-state")).toHaveText("已关闭");
});

test("较旧页面不能覆盖另一页的新记录，包括 pagehide 保存", async ({ page, context }) => {
  await page.goto("/");
  const other = await context.newPage();
  await other.goto("/");
  await page.locator("#focus-duration").fill("1");
  await page.getByRole("button", { name: "保存时长" }).click();
  await expect(other.locator("#storage-conflict")).toBeVisible();
  await page.locator("#task-name").fill("保护历史记录");
  await page.getByRole("button", { name: "开始专注" }).click();
  await page.clock.fastForward(60000);
  await expect(page.locator("#history-list li")).toHaveCount(1);
  await other.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await other.close();
  await page.reload();
  await expect(page.locator("#history-list")).toContainText("保护历史记录");
});

test("空历史、手机布局与键盘操作", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#history-empty")).toBeVisible();
  await expect(page.locator("#export-history")).toBeDisabled();
  await page.locator("#task-name").fill("键盘专注");
  await page.locator("#start-button").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#start-label")).toHaveText("暂停计时");
  await page.clock.fastForward(1000);
  await page.keyboard.press("Enter");
  await expect(page.locator("#start-label")).toHaveText("继续计时");
  await page.getByRole("button", { name: "重置当前计时" }).click();
  await expect(page.locator("#time-display")).toHaveText("25:00");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("initial-layout.png"), fullPage: true });
});

test("未收到 storage 事件的旧页面，写入前仍能检测外部更新", async ({ page, context }) => {
  await page.goto("/");
  const other = await context.newPage();
  await other.addInitScript(() => window.addEventListener("storage", (event) => event.stopImmediatePropagation()));
  await other.goto("/");
  await page.locator("#focus-duration").fill("1");
  await page.getByRole("button", { name: "保存时长" }).click();
  await page.getByRole("button", { name: "开始专注" }).click();
  await page.clock.fastForward(60000);
  await expect(page.locator("#history-list li")).toHaveCount(1);
  await other.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(other.locator("#storage-conflict")).toBeVisible();
  await other.close();
  await page.reload();
  await expect(page.locator("#history-list li")).toHaveCount(1);
});

test("存储不可用时仍能计时，且明确告知无法保存", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error("Storage blocked"); };
    Storage.prototype.setItem = () => { throw new Error("Storage blocked"); };
  });
  await page.goto("/");
  await expect(page.locator("#notice")).toContainText("无法保存");
  await page.getByRole("button", { name: "开始专注" }).click();
  await page.clock.fastForward(1000);
  await expect(page.locator("#time-display")).toHaveText("24:59");
  await expect(page.locator("#notice")).toContainText("无法保存");
});
