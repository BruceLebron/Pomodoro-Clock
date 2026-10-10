// tomato 使用 Go 标准库提供 HTTP 服务，SQLite 负责跨浏览器持久化记录。
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/BruceLebron/Pomodoro-Clock/internal/server"
)

type config struct {
	bindAddr     string
	port         string
	dbPath       string
	allowedHosts []string
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := execute(os.Args[1:], logger); err != nil {
		logger.Error("command_failed", "error", err)
		os.Exit(1)
	}
}

func execute(args []string, logger *slog.Logger) error {
	if len(args) > 1 || len(args) == 1 && args[0] != "healthcheck" {
		return fmt.Errorf("usage: tomato [healthcheck]")
	}
	configuration, err := readConfig()
	if err != nil {
		return err
	}
	if len(args) == 1 {
		return healthcheck(configuration)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return serve(ctx, logger, configuration)
}

func readConfig() (config, error) {
	c := config{bindAddr: os.Getenv("BIND_ADDR"), port: os.Getenv("PORT"), dbPath: os.Getenv("DB_PATH")}
	if c.bindAddr == "" {
		c.bindAddr = "127.0.0.1"
	}
	switch c.bindAddr {
	case "127.0.0.1", "0.0.0.0", "::1", "::":
	default:
		return config{}, fmt.Errorf("BIND_ADDR must be 127.0.0.1, 0.0.0.0, ::1 or ::")
	}
	if c.port == "" {
		c.port = "4187"
	}
	for _, digit := range c.port {
		if digit < '0' || digit > '9' {
			return config{}, fmt.Errorf("PORT must contain only digits")
		}
	}
	portNumber, err := strconv.Atoi(c.port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return config{}, fmt.Errorf("PORT must be an integer between 1 and 65535")
	}
	c.port = strconv.Itoa(portNumber)
	if c.dbPath == "" {
		c.dbPath = filepath.Join("data", "tomato.db")
	}
	c.allowedHosts, err = server.ParseAllowedHosts(os.Getenv("ALLOWED_HOSTS"))
	if err != nil {
		return config{}, err
	}
	return c, nil
}

// healthcheck 是单次就绪探测，可直接作为 scratch 容器的 HEALTHCHECK argv。
func healthcheck(c config) error {
	host := "127.0.0.1"
	if c.bindAddr == "::" || c.bindAddr == "::1" {
		host = "::1"
	}
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get("http://" + net.JoinHostPort(host, c.port) + "/readyz")
	if err != nil {
		return fmt.Errorf("readiness check failed: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("readiness check returned HTTP %d", response.StatusCode)
	}
	return nil
}

func serve(ctx context.Context, logger *slog.Logger, c config) error {
	app, err := server.New(server.Config{DBPath: c.dbPath, StaticDir: ".", Logger: logger, AllowedHosts: c.allowedHosts})
	if err != nil {
		return err
	}
	defer app.Close()
	httpServer := &http.Server{Addr: net.JoinHostPort(c.bindAddr, c.port), Handler: app, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	listener, err := net.Listen("tcp", httpServer.Addr)
	if err != nil {
		return fmt.Errorf("listen HTTP: %w", err)
	}
	result := make(chan error, 1)
	go func() { result <- httpServer.Serve(listener) }()
	logger.Info("server_started", "address", "http://"+httpServer.Addr, "version", server.Version)
	select {
	case err := <-result:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		logger.Info("server_shutting_down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			httpServer.Close()
			return fmt.Errorf("shutdown HTTP server: %w", err)
		}
		return nil
	}
}
