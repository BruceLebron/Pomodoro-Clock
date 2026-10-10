# v0.4.0 API

默认本机地址：`http://127.0.0.1:4187`；Compose 为 `http://127.0.0.1:4188`。容器显式监听所有容器网卡，请求 Host 仍受精确白名单限制，不包含账号体系。响应为 JSON，API 使用 `Cache-Control: no-store`。

## 健康检查

`GET /healthz`

```json
{"status":"ok","version":"0.4.0"}
```

数据库不可连接时返回 HTTP 503。

`GET /livez` 只表示 HTTP 进程存活，不查询数据库；`GET /readyz` 执行数据库 `SELECT 1`，失败返回 503。健康响应均包含当前版本。部署使用 livez 做存活探针、readyz 做就绪探针。

`GET /metrics` 返回 Prometheus 标准指标格式，字段和查询示例见 [部署手册](deployment.md#prometheus)。它不返回任务内容；累计指标在进程重启时归零。

## 读取完成记录

`GET /api/sessions`

```json
{
  "sessions": [
    {"id":"服务端生成的内容哈希","completedAt":1791684000000,"minutes":25,"task":"学习 Go"}
  ],
  "total": 1
}
```

数据库保留全部记录，接口最多返回最近 1000 条，数组按完成时间升序排列。`total` 为数据库总条数，可能大于返回条数。页面的历史、统计、导出都基于这最近 1000 条；本版没有查询更早记录的分页接口。

## 批量上传

`POST /api/sessions`，`Content-Type: application/json`。

```json
{
  "sessions": [
    {"completedAt":1791684000000,"minutes":25,"task":"学习 Go"}
  ]
}
```

- `completedAt`：正整数，完成时刻的 Unix 毫秒时间戳，不超过 JavaScript Date 上限 `8640000000000000`。
- `minutes`：整数，1–180。
- `task`：必填字符串，可为空；前后端统一去掉首尾空白、将连续空白折叠成一个空格，规范化后最多 80 个 UTF-16 单元。
- 每批最多 1000 条，请求正文最多 1 MiB；未知字段、重复 JSON 字段及多段 JSON 正文均被拒绝。
- 可携带 `id`，但服务端忽略此值并重新按内容计算。相同的完成时间、时长、规范化任务视为同一条记录。

成功返回 HTTP 200：

```json
{
  "sessions": [
    {"id":"服务端生成的内容哈希","completedAt":1791684000000,"minutes":25,"task":"学习 Go"}
  ],
  "saved": 1
}
```

`sessions` 按请求输入顺序返回确认结果，包含已存在的重复记录；`saved` 只统计本次新插入的条数。重复提交相同内容时 `saved` 为 0。整批先校验，再用同一事务写入；任一记录非法或数据库写入失败时不会部分保存。

| HTTP 状态 | 含义 |
| --- | --- |
| 400 | JSON 或字段值非法、批次超过 1000 条 |
| 403 | 请求 Host 不在精确白名单，或带有非同源 Origin |
| 404 | 路径不在接口或静态文件白名单中 |
| 405 | 请求方法不支持 |
| 413 | 正文超过 1 MiB |
| 415 | POST Content-Type 不是 application/json |
| 500 | 数据库操作失败 |

错误格式为 `{"error":"说明"}`。浏览器写入必须同源；没有 Origin 的本机命令行请求可用于诊断。数据库文件与 `.git` 不通过 HTTP 提供。

## PowerShell 诊断

```powershell
# 只读检查：服务、数据库与版本
Invoke-RestMethod http://127.0.0.1:4187/healthz
# 查看返回的最新记录与数据库总数
Invoke-RestMethod http://127.0.0.1:4187/api/sessions
```

默认数据库为 `data/tomato.db`，可设置环境变量 `DB_PATH`。备份前先停止服务；记录不随源代码推送 GitHub。
