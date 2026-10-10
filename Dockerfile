# 编译阶段有 Go 工具链；运行镜像只保留应用与网页资源。
FROM golang:1.25.5-alpine AS builder
WORKDIR /src

# 先下载锁定依赖，让仅修改业务代码时复用依赖层。
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/tomato ./cmd/tomato \
    && mkdir -p /out/data /out/tmp \
    && chown 10001:10001 /out/data \
    && chmod 0700 /out/data \
    && chmod 1777 /out/tmp

FROM scratch
WORKDIR /app
# 命名卷第一次挂载时会复制目录内容与权限，非 root 进程可创建 SQLite 数据库。
COPY --from=builder --chown=10001:10001 --chmod=0700 /out/data /data
COPY --from=builder --chmod=1777 /out/tmp /tmp
COPY --from=builder /out/tomato /tomato
COPY index.html style.css app.js timer-core.js sync.js /app/

USER 10001:10001
ENV PORT=4187 \
    BIND_ADDR=0.0.0.0 \
    DB_PATH=/data/tomato.db \
    GOMEMLIMIT=96MiB
EXPOSE 4187
# 直接调用 Go 子命令；scratch 不需要安装 shell、curl 或 wget。
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["/tomato", "healthcheck"]
ENTRYPOINT ["/tomato"]
