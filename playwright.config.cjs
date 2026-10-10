const { defineConfig } = require("@playwright/test");

// 本地使用已安装的 Edge；CI 使用 Playwright 下载的 Chromium。
const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === "win32" ? "msedge" : undefined);
module.exports = defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 2,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4199",
    timezoneId: "Asia/Shanghai",
    locale: "zh-CN",
    channel,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1080 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }
  ],
  // 测试独占独立端口，避免影响用户正在使用的 4187 预览与存档。
  webServer: {
    command: "node scripts/serve.cjs",
    env: { PORT: "4199" },
    url: "http://127.0.0.1:4199",
    reuseExistingServer: false,
    timeout: 15000
  }
});
