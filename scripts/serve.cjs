// 仅供本地预览，使用 Node.js 内置模块，无需安装依赖。
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 4187);
const allowed = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/timer-core.js", ["timer-core.js", "text/javascript; charset=utf-8"]],
  ["/sync.js", ["sync.js", "text/javascript; charset=utf-8"]]
]);
http.createServer((request, response) => {
  const route = allowed.get(new URL(request.url, "http://localhost").pathname);
  if (!route || !["GET", "HEAD"].includes(request.method)) {
    response.writeHead(404); response.end("Not found"); return;
  }
  fs.readFile(path.join(root, route[0]), (error, data) => {
    if (error) { response.writeHead(500); response.end("Unable to read file"); return; }
    response.writeHead(200, { "Content-Type": route[1], "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : data);
  });
}).listen(port, "127.0.0.1", () => console.log(`Local: http://127.0.0.1:${port}`)).on("error", (error) => { console.error(error.message); process.exitCode = 1; });
