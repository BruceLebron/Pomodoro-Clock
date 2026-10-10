# v0.4.0 部署与运维

本版提供本机 Go、Docker Compose 和 Kubernetes 三种运行方式。它们共享相同前端/API，数据目录各自独立。部署默认用于本机或可信集群，不包含账号与公网入口。

## 从数据约束推导部署方案

SQLite 是嵌入当前应用进程的数据库，记录文件与 WAL 必须一起留在可靠卷中。增加 Pod 数量不会自动变成共享数据库；多个独立卷还会产生各自不同的历史。因此本版使用一个副本、一个 PVC，并在升级时采用 `Recreate`，先停止旧实例再启动新实例。

`ReadWriteOnce` 的本质是单节点可读写，它仍允许同一节点上的多个 Pod 使用同一个卷。单实例约束来自副本数与升级方案，不是 RWO 本身。`Recreate` 保证升级顺序；手动删除 Pod 时由 ReplicaSet 补建，不应把它理解为所有场景的分布式锁。[Kubernetes 卷访问模式](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes)、[Deployment Recreate](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#recreate-deployment)。

本版接受升级期间的短暂不可用，浏览器可继续计时并暂存完成记录。需要高可用时，应先迁移到支持多实例访问的数据库，再设计滚动升级和扩容。

## 配置与端口

| 配置 | 本机默认值 | 容器/Pod |
| --- | --- | --- |
| `PORT` | `4187` | `4187` |
| `BIND_ADDR` | `127.0.0.1` | 显式 `0.0.0.0` |
| `DB_PATH` | `data/tomato.db` | `/data/tomato.db` |
| `ALLOWED_HOSTS` | 额外列表为空，始终允许回环名称/IP | Compose 增加 `tomato`，K8s 增加服务 DNS |
| `GOMEMLIMIT` | Go 默认 | `96MiB` 软内存目标，容器硬限制 `128Mi` |

`ALLOWED_HOSTS` 是逗号分隔的精确主机名称/IP，不带端口；拒绝 URL、通配符和非法条目。它用于避免任意 DNS 名称访问本服务，不提供用户身份认证。写入请求仍检查 Origin 与当前 Host 一致。

```powershell
# 原本机方式保持不变
go run ./cmd/tomato
# 检查真实数据库就绪状态
Invoke-RestMethod http://127.0.0.1:4187/readyz
```

## Docker Compose

需要 Docker Linux 引擎。迁移端口与隔离监控测试使用 `!override`，要求 Docker Compose 2.24.4 或以上版本。[Compose 列表覆盖](https://docs.docker.com/reference/compose-file/merge/#replace-value)。

```powershell
# 在项目根目录构建并启动，数据库放在命名卷
docker compose up -d --build
docker compose ps
# 页面使用 http://127.0.0.1:4188
docker compose logs --tail 50 tomato
# 正常停止保留卷
docker compose down
```

镜像编译阶段使用锁定的 Go 依赖，运行阶段为 scratch，只包含程序和网页文件。进程 UID/GID 为 `10001:10001`，没有 shell；健康检查直接执行 `/tomato healthcheck`。应用根文件系统只读，只有 `/data` 持久卷与小型 `/tmp` 临时目录可写。[Docker 多阶段构建](https://docs.docker.com/build/building/multi-stage/)、[Compose 服务配置](https://docs.docker.com/reference/compose-file/services/)。

```powershell
# scratch 不提供 sh；用程序自带命令探测
docker compose exec tomato /tomato healthcheck
```

首次使用新端口 4188 时，浏览器缓存来源和 4187 不同。如果需要让原浏览器历史导入容器：先停止原 4187 Go 服务，在本机创建 Compose override，将应用端口改为 `127.0.0.1:4187:4187`；用支持端口列表覆盖的 Compose `!override`，避免同时发布两个绑定。

```yaml
# compose.local.yaml，仅用于本机迁移，不提交到仓库
services:
  tomato:
    ports: !override
      - "127.0.0.1:4187:4187"
```

```powershell
# 关闭旧标签页，用原浏览器重新打开原地址
docker compose -f compose.yaml -f compose.local.yaml up -d --build
# 确认“记录已备份”后，完成记录已进入容器卷
```

这种迁移上传浏览器缓存里的最近 1000 条。若需要保留数据库中更早的记录，应停止原服务后完整备份数据库，再恢复到应用卷，保持 UID/GID 可写；不要把数据库放进镜像或 Git。

## Kubernetes

清单位于 `deploy/k8s`，包含 Namespace、PVC、Deployment、ClusterIP Service。PVC 使用集群默认 StorageClass；部署前检查目标集群是否有可用动态存储。清单不创建管理员级 PV，也不配置 Ingress。

```powershell
# 明确选择你的测试 kubeconfig，每条命令都指定它
$taskKubeconfig = 'D:\kubeconfig\lab.yaml'
kubectl --kubeconfig $taskKubeconfig config current-context
kubectl --kubeconfig $taskKubeconfig get storageclass
# 渲染清单，无需连接集群
kubectl kustomize deploy/k8s
```

镜像名为 `tomato-clock:0.4.0`。kind 实验环境可先构建并加载；其他集群需要推送到你自己的镜像仓库，再用 Kustomize `images` 改成该仓库地址，建议固定 digest。GitHub 检查只构建测试镜像，不发布到镜像仓库。

```powershell
# 对你明确选择的测试集群部署
kubectl --kubeconfig $taskKubeconfig apply -f deploy/k8s/namespace.yaml
kubectl --kubeconfig $taskKubeconfig apply --dry-run=server -k deploy/k8s
kubectl --kubeconfig $taskKubeconfig apply -k deploy/k8s
kubectl --kubeconfig $taskKubeconfig -n tomato rollout status deployment/tomato-clock
kubectl --kubeconfig $taskKubeconfig -n tomato get pods,pvc,service
# 只在本机打开端口访问
kubectl --kubeconfig $taskKubeconfig -n tomato port-forward service/tomato 4189:4187 --address 127.0.0.1
```

启动探针给进程启动时间，存活探针访问 `/livez`，就绪探针访问 `/readyz`，通过 `SELECT 1` 验证数据库查询链路。查询失败时摘除流量并报警，存活探针仍检查进程；磁盘满或写权限故障可能在查询成功时导致写入失败，需要同时观察数据库错误和 API 错误率。探针指定回环 Host，避免 kubelet 使用 Pod IP 时被应用 Host 白名单拒绝。[Kubernetes 探针](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)。

Pod 配置非 root、只读根文件系统、禁止提权、移除全部 capabilities、RuntimeDefault seccomp、资源 requests/limits，以及不自动挂载 ServiceAccount Token。`fsGroup=10001` 让支持该策略的卷可被应用写入；实际效果仍需与目标 StorageClass 的卷驱动核验。

```powershell
# 更新时保留 PVC，验证新进程仍能读取历史
kubectl --kubeconfig $taskKubeconfig -n tomato rollout restart deployment/tomato-clock
kubectl --kubeconfig $taskKubeconfig -n tomato rollout status deployment/tomato-clock
# 排查启动失败与卷绑定失败
kubectl --kubeconfig $taskKubeconfig -n tomato logs deployment/tomato-clock --tail 100
kubectl --kubeconfig $taskKubeconfig -n tomato describe pvc tomato-data
kubectl --kubeconfig $taskKubeconfig -n tomato get events --sort-by=.lastTimestamp
```

## Prometheus

```powershell
# 独立 profile，日常计时不强制启动监控
docker compose --profile monitoring up -d --build
# Prometheus：http://127.0.0.1:9090
```

采集配置为 `deploy/monitoring/prometheus.yml`，目标 `tomato:4187`。规则为 `rules.yml`：采集连续失败一分钟、五分钟窗口出现数据库错误、记录 API 的 5xx 比例超过 5% 且窗口内至少十次请求。告警只显示在 Prometheus Alerts 页面；本版没有 Alertmanager、邮件或外部通知。

| 指标 | 意义 |
| --- | --- |
| `tomato_http_requests_total` | 请求累计数，标签 method/route/status 使用有限集合 |
| `tomato_http_request_duration_seconds` | 请求延迟直方图，单位秒 |
| `tomato_sessions_saved_total` | 本进程实际新增的唯一完成记录数 |
| `tomato_database_errors_total` | 数据库操作或就绪检查错误次数 |
| `tomato_build_info{version="0.4.0"}` | 当前应用版本 |

计数器在进程重启时归零；用 `rate` 或 `increase` 查看趋势。新记录计数器不等于数据库历史总数。指标不包含任务名称、原始 URL 或用户记录；`/metrics` 自身不计入请求统计。[Prometheus 指标实践](https://prometheus.io/docs/practices/instrumentation/)。

```promql
# 记录 API 请求速率
sum(rate(tomato_http_requests_total{route="/api/sessions"}[5m]))
# 记录 API 的 P95 延迟，聚合时必须保留 le
histogram_quantile(0.95, sum by (le) (rate(tomato_http_request_duration_seconds_bucket{route="/api/sessions"}[5m])))
# 五分钟新增唯一记录
increase(tomato_sessions_saved_total[5m])
```

Kubernetes 已有 Prometheus 时，将同命名空间目标改为 `tomato:4187`，或使用允许的完整 DNS `tomato.tomato.svc.cluster.local:4187`。本版没有绑定特定 Prometheus Operator CRD，按你的监控平台创建采集任务即可。

## 验收、回滚与数据

第四版验收顺序：应用完整检查 → 镜像启动和容器重建 → 独立 kind 集群部署与 Pod 重启 → Prometheus 配置/规则验收 → GitHub 两项 CI 作业。临时验收集群使用独立 kubeconfig，不修改当前 kubeconfig；脚本失败不会被标成通过。

```powershell
npm.cmd run check
npm.cmd run test:container
npm.cmd run test:monitoring
npm.cmd run tools:kind
$env:TOMATO_KIND_NODE_IMAGE = 'kindest/node:v1.34.3@sha256:08497ee19eace7b4b5348db5c6a1591d7752b164530a36f855cb0f2bdcbadd48'
npm.cmd run test:kubernetes
```

本版数据库结构与第三版一致。回滚应用版本前先备份数据，保持同一持久卷，先确认目标镜像支持配置与结构。不要用删除 Namespace、PVC 或 Compose 数据卷作为重启方式；这些操作可能触发真实数据删除。

费曼式复述：**镜像装程序，卷留记录；探针决定是否接流量，指标帮助判断为什么出问题。**
