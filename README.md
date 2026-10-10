# 番茄 · 专注当下

第四版 `v0.4.0`：在 Go + SQLite 番茄时钟上增加 Docker、Kubernetes 和 Prometheus 运维能力。保留计时、音效、任务、历史筛选、七天统计、CSV 导出、旧记录导入与离线同步。

版本变化见 [CHANGELOG.md](CHANGELOG.md)，接口见 [API 文档](docs/api.md)，容器、集群与监控操作见 [部署手册](docs/deployment.md)。

## 本机启动

需要 Go 1.25.5 或以上版本。从项目根目录启动，首次启动会下载 `go.mod`、`go.sum` 锁定的 SQLite 驱动依赖，后续使用本机缓存。

```powershell
# 确认 Go 已安装
go version
# 启动页面与记录服务；无需先安装 npm 依赖
go run ./cmd/tomato
# 浏览器打开 http://127.0.0.1:4187
# Ctrl+C 停止服务
```

已安装 Node.js 时也可运行 `npm.cmd start`，它执行相同的 Go 启动命令。Windows PowerShell 使用 `npm.cmd` 避开 `npm.ps1` 的执行策略限制；其他系统使用 `npm start`。

从第二版升级时，先在旧服务终端按 Ctrl+C，再启动上述 Go 服务；关闭旧标签页，重新打开**同一浏览器、同一地址与端口**。页面会自动上传旧的完成记录，显示“记录已备份”后即可用另一浏览器访问同一服务。计时状态与设置仍属于原浏览器。

本机默认监听 `127.0.0.1:4187`，不提供账号登录。容器显式设置 `BIND_ADDR=0.0.0.0`，宿主机仍只发布回环端口；请求 Host 通过精确白名单校验。端口和数据库路径可通过环境变量设置：

```powershell
# 可选配置；改变端口会改变浏览器存储来源，升级导入时应保留原端口
$env:PORT = '4188'
$env:DB_PATH = 'data/tomato.db'
go run ./cmd/tomato
```

没有 Go 时，可使用 `npm.cmd run start:local`、VS Code Live Server 或直接打开 `index.html` 运行纯本地页面。这些方式只使用浏览器存储，页面显示“仅保存在浏览器”，不提供 SQLite 备份。

## 功能

- 默认专注 25 分钟、短休息 5 分钟；开始、暂停、继续、重置与模式切换。
- 专注时长 1–180 分钟，休息 1–60 分钟；结束后切换模式，等待手动开始下一轮。
- 音效开关控制全部操作音和结束提示音；支持试听，刷新保留选择。
- 任务名称最多 80 个 UTF-16 单元，可留空；本轮专注开始后锁定，暂停与刷新后归属不变。
- 今日番茄数量、专注分钟与最近七个本地自然日统计；只统计已完成的专注。
- 历史支持今天、近七天、全部、任务搜索与每页八条记录；CSV 导出全部筛选结果，不受分页限制。
- SQLite 保存已同步的全部历史；浏览器缓存、页面展示、统计与 CSV 最多使用最近 1000 条。
- 自动导入旧浏览器记录；上传重试按完成时间、时长、任务内容去重。
- 初次加载、完成专注、恢复网络、返回页面与每隔 30 秒尝试同步；支持手动“同步记录”。
- 服务不可用时继续计时，新记录保存在浏览器，恢复后上传；页面显示待同步数量。
- 手机布局、键盘操作与减少动态效果的系统偏好。
- Docker 多阶段构建，非 root 运行、只读根文件系统、持久数据卷。
- Kubernetes 单副本 Deployment、PVC、ClusterIP、资源限制与三类探针。
- `/livez` 判断进程存活，`/readyz` 检查数据库；`/healthz` 保留兼容。
- `/metrics` 提供 Prometheus 请求数、延迟、数据库错误、新记录计数与版本指标。
- 可选 Prometheus Compose profile，包含采集和三条本地告警规则。

## 容器启动

```powershell
# 需要已运行的 Docker Linux 引擎
docker compose up -d --build
# 容器页面：http://127.0.0.1:4188，与本机开发端口 4187 区分
docker compose ps

# 可选：一起启动 Prometheus，查看 http://127.0.0.1:9090
docker compose --profile monitoring up -d --build
```

容器使用独立命名卷，不自动读取本机 `data/tomato.db`。若需要导入旧浏览器记录，应按部署手册保留原来的浏览器地址与端口，再确认“记录已备份”。`docker compose down` 保留卷，不要用 `--volumes` 停止日常服务。

## 数据与备份

计时、设置和最近 1000 条记录保存在当前浏览器的 `tomato.state.v2`。第三版沿用此键以兼容第二版；没有第二版存档时读取 `tomato.state.v1`。旧记录保留时间和时长，未填写任务的记录显示为“未命名专注”。

同步成功的完成记录写入 `data/tomato.db`。重复提交不会重复增加记录；数据库重启后仍可读取。不同浏览器打开同一个本机服务可以看到相同的完成历史，各自的当前计时与设置独立。

服务离线期间，请保留原浏览器数据。尚未上传的记录仍受本地最近 1000 条上限约束；清除存储、切换浏览器或换地址不会携带这些记录。SQLite 保存超过 1000 条后，较旧记录仍在数据库中，但本版页面/API 列表只提供最新 1000 条。

数据库、WAL 文件、浏览器记录和测试临时文件均被 Git 忽略，**不会随代码推送到 GitHub**。备份时先停止 Go 服务，再复制数据库文件；服务正在运行时不要只复制主数据库文件，因为 SQLite 可能仍有 WAL 中的未合并数据。

同一浏览器来源建议只打开一个计时页。另一页更新存档时，旧页会停止操作并提示刷新；写入前也检查存档快照，避免旧页覆盖新历史。存储不可用时会提示无法保存；计时仍能在当前页面运行。

CSV 使用 UTF-8 BOM，兼容中文、逗号与引号；以 `=`、`+`、`-`、`@` 开头的任务增加文本前缀，避免表格软件当作公式执行。

## 计时与同步原理

计时依据绝对结束时间，定时器只负责刷新显示，避免后台标签页降低调用频率时产生累计误差。

```javascript
// 开始或继续时计算结束时间
endAt = Date.now() + remainingMs;
// 刷新显示时根据当前时间校正
remainingMs = Math.max(0, endAt - Date.now());
```

暂停保存剩余毫秒数；刷新恢复已保存的计时，到期只记一次完成。页面关闭或电脑休眠时无法播放音效，重新打开后校正；更改系统时钟会影响计时。Web Audio 提示音可能需要先点击按钮解锁，实际声音还受浏览器和系统音量控制。

同步先读取服务端记录，再上传尚未确认的本地记录。批量上传使用数据库事务，同一条记录的内容生成稳定 ID；响应丢失后重新同步也不会重复记账。先确认旧记录上传成功，再合并和裁剪页面历史，防止远端的最新 1000 条挤掉未上传记录。

用一句话理解：**浏览器负责“现在计到哪里”，SQLite 负责“已经完成了什么”**。

## 文件结构

```text
index.html                  # 页面结构
style.css                   # 外观与手机布局
app.js                      # 页面、存储、音效与同步状态
timer-core.js               # 独立计时和历史逻辑
sync.js                     # 离线重试、去重与合并
cmd/tomato/main.go          # 服务启动、配置与优雅退出
internal/server/            # API、SQLite 与后端测试
go.mod / go.sum             # 固定 Go 依赖
scripts/serve.cjs           # 可选纯静态预览
scripts/test-backend.cjs    # 隔离的 Go 浏览器测试服务
tests/*.test.cjs            # 计时、历史与同步单元测试
tests/e2e/                  # 桌面与手机浏览器验收
docs/                       # API 和验证证据
.github/workflows/checks.yml # GitHub 自动检查
Dockerfile / compose.yaml   # 镜像构建与本机容器服务
deploy/k8s/                 # Kubernetes Kustomize 清单
deploy/monitoring/          # Prometheus 采集和告警规则
scripts/test-container.cjs  # 隔离容器、去重和重建持久化验收
scripts/test-kubernetes.cjs # 隔离 kind 集群、探针和卷持久化验收
scripts/test-monitoring.cjs # 独立 Compose、真实采集和告警规则验收
```

## 验证与推送规范

需要 Go、Node.js 20 或以上版本，以及浏览器测试开发依赖：

```powershell
# 首次安装开发依赖
npm.cmd ci
# Windows 默认使用已安装的 Edge；其他系统先安装测试用 Chromium
# npx.cmd playwright install chromium

# JS 语法 + 前端单元测试 + Go 测试 + Go vet + 桌面/手机浏览器测试
npm.cmd run check
```

测试使用独立端口 `4199`（静态页）和 `4200`（Go API），隔离浏览器存档及 `.qa/` 临时 SQLite，不读取或写入日常使用的 `4187` 存档。Windows 也可设置 `$env:PLAYWRIGHT_CHANNEL = 'chrome'` 使用已安装的 Chrome。CI 安装 Chromium，执行相同检查。

第四版增加容器、监控和 Kubernetes 实际部署验收，监控测试需要 Compose 2.24.4 或以上版本：

```powershell
# Docker引擎启动后，构建镜像并用临时数据卷测试，结束后清理自身资源
npm.cmd run test:container
# 实际采集、重复提交计数，以及告警规则的延迟和低流量抑制
npm.cmd run test:monitoring
# 只安装项目内的固定版本测试工具，并校验官方 SHA256
npm.cmd run tools:kind
# 独立 kind 测试集群，不使用当前生产 kubeconfig
$env:TOMATO_KIND_NODE_IMAGE = 'kindest/node:v1.34.3@sha256:08497ee19eace7b4b5348db5c6a1591d7752b164530a36f855cb0f2bdcbadd48'
npm.cmd run test:kubernetes
```

任何检查失败都先修复并重新验证；应用、容器、集群检查通过后再提交推送，确认对应提交的 GitHub Actions 两项作业成功。第四版实测范围见 [验证记录](docs/validation-v0.4.0.md)，第三版证据也保留在 [第三版验证记录](docs/validation-v0.3.0.md)。

```powershell
# 先验证，再检查提交范围
npm.cmd run check
# 部署文件变更还需运行上述容器与 Kubernetes 验收
git status
git add .
git commit -m "feat: 描述本次功能"
git push
```

手动验收：完成一次一分钟专注 → 确认“记录已备份” → 用另一浏览器打开同一服务并搜索该任务 → 重启服务确认记录保留。再停止服务，在已打开页面完成专注，确认待同步提示；重新启动服务并点击“重试同步”，确认只新增一条。

GitHub 保存源代码和检查结果；本版没有自动发布镜像或修改用户已有集群。后续可以在现有监控指标上练习 SLO、告警处置与数据库备份恢复，或在引入共享数据库后再讨论多副本架构。
