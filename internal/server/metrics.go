package server

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type metrics struct {
	requests       *prometheus.CounterVec
	duration       *prometheus.HistogramVec
	saved          prometheus.Counter
	databaseErrors prometheus.Counter
	handler        http.Handler
}

// 每个 Server 有独立 registry，避免测试和多实例重复注册全局指标。
func newMetrics() *metrics {
	registry := prometheus.NewRegistry()
	m := &metrics{
		requests:       prometheus.NewCounterVec(prometheus.CounterOpts{Name: "tomato_http_requests_total", Help: "HTTP requests excluding the metrics endpoint."}, []string{"method", "route", "status"}),
		duration:       prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "tomato_http_request_duration_seconds", Help: "HTTP request duration excluding the metrics endpoint.", Buckets: prometheus.DefBuckets}, []string{"method", "route", "status"}),
		saved:          prometheus.NewCounter(prometheus.CounterOpts{Name: "tomato_sessions_saved_total", Help: "New unique focus sessions committed to SQLite during this process lifetime."}),
		databaseErrors: prometheus.NewCounter(prometheus.CounterOpts{Name: "tomato_database_errors_total", Help: "Database operations and readiness checks that failed."}),
	}
	buildInfo := prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "tomato_build_info", Help: "Application version information."}, []string{"version"})
	buildInfo.WithLabelValues(Version).Set(1)
	registry.MustRegister(m.requests, m.duration, m.saved, m.databaseErrors, buildInfo)
	m.handler = promhttp.HandlerFor(registry, promhttp.HandlerOpts{})
	return m
}

func metricMethod(method string) string {
	switch method {
	case "GET", "POST", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS":
		return method
	default:
		return "other"
	}
}

func metricRoute(path string) string {
	switch path {
	case "/", "/index.html", "/style.css", "/app.js", "/timer-core.js", "/sync.js", "/healthz", "/livez", "/readyz", "/api/sessions", "/metrics":
		return path
	default:
		return "unknown"
	}
}

func (m *metrics) observe(method, route string, status int, elapsed time.Duration) {
	if route == "/metrics" {
		return
	}
	labels := []string{method, route, strconv.Itoa(status)}
	m.requests.WithLabelValues(labels...).Inc()
	m.duration.WithLabelValues(labels...).Observe(elapsed.Seconds())
}
