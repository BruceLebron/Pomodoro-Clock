# v0.4.0 验证记录

验证日期：2026-10-11。沿用第二版的规范：实现 → 审查 → 测试 → 修复 → 完整验证通过 → 提交推送 → 确认对应提交的 GitHub Actions。

## 应用检查

- Windows，Node.js 24.12.0，Go 1.25.5，Playwright 1.64.0，真实 Microsoft Edge 155.0.4283.45。
- `npm.cmd run check` 通过：JS 语法检查、48 项前端单元测试、22 个 Go 顶级测试、Go vet、32 项桌面/手机浏览器验收。
- Go 测试包括 17 个服务端案例和 5 个命令入口案例；覆盖存活与数据库就绪分离、配置非法值、精确 Host 白名单、低基数指标、写入去重计数和健康检查子命令。
- 浏览器继续验证计时、历史、音效、旧版迁移、离线恢复和 API 同步；增加真实探针与版本指标检查。
- 浏览器验收使用独立端口 4199、4200 和临时数据库，不读写日常使用的 4187 数据。
- 桌面 1440 × 1080、手机 390 × 844 截图已查看，没有文字截断、控件遮挡或横向溢出。记录是隔离测试样例。

截图：[桌面页面](qa/v0.4.0-desktop.png)、[手机页面](qa/v0.4.0-mobile.png)。

## Docker 实际运行

使用 Docker Desktop Linux 引擎，CLI 29.1.3、Compose 2.40.3，实际构建 `tomato-clock:0.4.0`，不是仅检查 Dockerfile 语法。

1. 启动 scratch 镜像，核对实际进程 UID 10001、只读根文件系统、移除全部 capabilities 与禁止提权。
2. 实际尝试在根目录创建数据库，确认被只读文件系统拒绝。
3. 网页、记录 API、三种健康端点及 Prometheus 指标均返回预期内容；镜像自带健康检查达到 `healthy`。
4. 写入一条测试记录，重复提交返回 `saved=0`。
5. 停止并删除第一个容器，用同一临时命名卷启动第二个容器，确认原记录及 ID 保留且没有重复。
6. 测试结束只清理本次随机名称、归属标签核验通过的容器和卷；清理错误列表为空。

实测报告：[容器报告](qa/v0.4.0-container.json)。

## Kubernetes 实际运行

下载并校验官方 kind v0.31.0；节点为 Kubernetes v1.34.3，镜像按 digest 固定。使用随机命名的独立 kind 集群与独立 kubeconfig，不向用户当前集群部署。

1. 引导 Namespace 后，全部 Kustomize 清单通过服务端 dry-run、schema 和 admission 校验。
2. 实际 apply，Deployment rollout 成功、Pod Ready、PVC Bound。
3. 核对单副本 Recreate、非 root、只读根目录、禁止提权、drop ALL、RuntimeDefault seccomp、三类探针和资源限制；执行程序健康检查。
4. 本机端口转发验证网页、API、健康端点与指标；首次写入一条、重复提交不新增。
5. 执行 Deployment rollout restart，确认新 Pod UID 与旧 Pod 不同，PVC UID 不变，原记录及 ID 保留。
6. 结束时关闭端口转发，并核对归属后删除本次 kind 集群与临时 kubeconfig；清理错误列表为空。

实测报告：[Kubernetes 报告](qa/v0.4.0-kubernetes.json)。

## Prometheus 采集与告警

实际运行官方 `prom/prometheus:v3.15.0`，使用随机 Compose 项目、随机回环端口与独立命名卷。

1. Prometheus targets 中 `tomato:4187` 为 `up`，没有采集错误；真实 PromQL 查询 `up{job="tomato"}=1`。
2. 新测试卷中历史为空，写入计数基线为 0。
3. 在运行中的 Prometheus 容器执行 `promtool check config` 和 `promtool test rules`，配置及五组规则测试全部通过：健康无告警、采集失败延迟、数据库错误增加、API 高错误率持续时间、低流量抑制。
4. 查询规则 API，确认三条告警已加载、计算状态正常。
5. 实际 POST 首次返回 `saved=1`，重复返回 `saved=0`；等待下一次采集后，PromQL 写入计数为 1，历史总数也为 1。
6. 核对项目名称与资源归属后清理本次容器、网络和命名卷，确认全部删除；清理错误列表为空。

实测报告：[监控报告](qa/v0.4.0-monitoring.json)。GitHub Actions 使用相同脚本执行实际容器、监控和 kind 验收，上传 JSON 报告。

## 检查中修复的问题

- Kubernetes 服务名称与 Deployment 名称不同，修正端口转发目标为 `service/tomato`。
- 首次部署不能在 Namespace 尚不存在时对全部命名空间资源做 server dry-run；改为先引导 Namespace，再验证完整清单。
- Docker 29 的不存在网络和卷错误文本与旧版本不同，监控验收前置检查曾失败；按资源类型与精确名称识别不存在错误，仍拒绝将 daemon 或权限错误当作资源不存在。
- CI 隐藏目录报告不会默认进入 artifact；启用 hidden files，并只上传 `.qa/validation-*.json`，不包含数据库、kubeconfig 或用户数据。

## 验证边界

Kubernetes 验证发生在独立单节点 kind 实验集群，未验证用户现有 StorageClass、真实多节点故障或生产集群。该方案是单实例 SQLite，升级接受短暂不可用，不提供多副本高可用。

Prometheus 告警用合成时间序列验证规则条件和等待时间；没有接入 Alertmanager 或外部通知，也没有进行长期性能、容量或负载测试。手机使用浏览器视口和触摸模拟，未在实体手机上测试；音效检查实际 Web Audio 节点，未听取扬声器输出。

数据库结构与第三版一致。各部署方式使用独立数据目录，浏览器迁移范围和完整数据库备份要求见 [部署手册](deployment.md)。
