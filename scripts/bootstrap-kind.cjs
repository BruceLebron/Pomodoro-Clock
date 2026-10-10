"use strict";

// 测试工具只安装到项目 .qa/tools，不修改系统 PATH 或用户 kubeconfig。
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const version = "v0.31.0";
const platform = { win32: "windows", linux: "linux", darwin: "darwin" }[process.platform];
const architecture = { x64: "amd64", arm64: "arm64" }[process.arch];

async function main() {
  if (!platform || !architecture) throw new Error("当前平台没有配置 kind 发布文件");
  const asset = `kind-${platform}-${architecture}`;
  const base = `https://github.com/kubernetes-sigs/kind/releases/download/${version}/${asset}`;
  const directory = path.resolve(__dirname, "../.qa/tools");
  const output = path.join(directory, process.platform === "win32" ? "kind.exe" : "kind");
  const checksumResponse = await fetch(`${base}.sha256sum`, { signal: AbortSignal.timeout(30000) });
  if (!checksumResponse.ok) throw new Error(`读取 kind 校验文件失败：HTTP ${checksumResponse.status}`);
  const expected = (await checksumResponse.text()).trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/i.test(expected)) throw new Error("kind 官方校验文件格式不正确");
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  try {
    if (digest(await fs.readFile(output)) === expected.toLowerCase()) {
      console.log(`kind ${version} 校验通过：${output}`);
      return;
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const response = await fetch(base, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`下载 kind 失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== expected.toLowerCase()) throw new Error("kind SHA256 不匹配，拒绝安装");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(output, bytes, { mode: 0o755 });
  if (process.platform !== "win32") await fs.chmod(output, 0o755);
  console.log(`kind ${version} 下载并校验成功：${output}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
