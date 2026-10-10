"use strict";

// 浏览器验证启动独立 Go 服务与数据库，避免读写用户正在使用的存档。
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const projectRoot = path.resolve(__dirname, "..");
const qaDirectory = path.join(projectRoot, ".qa");
fs.mkdirSync(qaDirectory, { recursive: true });

const binaryPath = path.join(qaDirectory, process.platform === "win32" ? "tomato-test.exe" : "tomato-test");
const build = spawnSync("go", ["build", "-o", binaryPath, "./cmd/tomato"], {
  cwd: projectRoot,
  stdio: "inherit",
  windowsHide: true
});
if (build.error) {
  console.error("Go 测试服务编译失败：", build.error.message);
  process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);

const databasePath = path.join(qaDirectory, `e2e-${Date.now()}-${process.pid}.db`);
const server = spawn(binaryPath, [], {
  cwd: projectRoot,
  env: { ...process.env, PORT: "4200", DB_PATH: databasePath },
  stdio: "inherit",
  windowsHide: true
});

// Playwright 停止包装进程时，一并停止 Go 子进程，避免测试端口遗留占用。
let stoppingSignal;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stoppingSignal = signal;
    if (server.exitCode === null && server.signalCode === null) server.kill(signal);
  });
}
server.on("error", (error) => {
  console.error("Go 测试服务启动失败：", error.message);
  process.exitCode = 1;
});
server.on("exit", (code, signal) => {
  // 正常退出时原样返回服务退出码，信号退出时使用约定的 shell 退出码。
  const exitSignal = signal || stoppingSignal;
  process.exitCode = code ?? (exitSignal === "SIGINT" ? 130 : exitSignal === "SIGTERM" ? 143 : 1);
});
