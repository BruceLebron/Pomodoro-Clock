package server

import (
	"bytes"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLivenessAndReadinessHaveSeparateFailureSemantics(t *testing.T) {
	app, _ := newTestServer(t)
	for _, path := range []string{"/livez", "/readyz", "/healthz"} {
		if w := request(t, app, "GET", path, ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"version":"0.4.0"`) {
			t.Fatalf("healthy %s = %d %s", path, w.Code, w.Body.String())
		}
		if w := request(t, app, "POST", path, ""); w.Code != 405 {
			t.Fatalf("wrong method %s = %d", path, w.Code)
		}
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	if w := request(t, app, "GET", "/livez", ""); w.Code != 200 {
		t.Fatalf("liveness relies on DB: %d", w.Code)
	}
	for _, path := range []string{"/readyz", "/healthz"} {
		if w := request(t, app, "GET", path, ""); w.Code != 503 {
			t.Fatalf("unready %s = %d", path, w.Code)
		}
	}
}

func TestPrometheusMetricsCountFailuresAndUniqueCommits(t *testing.T) {
	app, _ := newTestServer(t)
	w := post(t, app, []Session{{CompletedAt: 1, Minutes: 25, Task: "private-task"}})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	post(t, app, []Session{{CompletedAt: 1, Minutes: 25, Task: "private-task"}})
	if w := request(t, app, "POST", "/api/sessions", `{"sessions":[{"completedAt":2,"minutes":0,"task":"invalid"}]}`); w.Code != 400 {
		t.Fatal(w.Body.String())
	}
	if _, err := app.db.Exec(`CREATE TRIGGER fail_write BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'test failure'); END`); err != nil {
		t.Fatal(err)
	}
	if w := post(t, app, []Session{{CompletedAt: 2, Minutes: 25, Task: "will-rollback"}}); w.Code != 500 {
		t.Fatalf("expected failed write: %d", w.Code)
	}
	request(t, app, "MY-SECRET-METHOD", "/private-task-path?query=private-task", "")
	w = request(t, app, "GET", "/metrics", "")
	if w.Code != 200 {
		t.Fatalf("metrics = %d %s", w.Code, w.Body.String())
	}
	for _, line := range []string{
		`tomato_build_info{version="0.4.0"} 1`,
		`tomato_sessions_saved_total 1`,
		`tomato_database_errors_total 1`,
		`tomato_http_requests_total{method="POST",route="/api/sessions",status="200"} 2`,
		`tomato_http_requests_total{method="POST",route="/api/sessions",status="400"} 1`,
		`tomato_http_requests_total{method="POST",route="/api/sessions",status="500"} 1`,
		`tomato_http_requests_total{method="other",route="unknown",status="404"} 1`,
		`tomato_http_request_duration_seconds_count{method="POST",route="/api/sessions",status="500"} 1`,
	} {
		if !strings.Contains(w.Body.String(), line) {
			t.Fatalf("missing metric %s:\n%s", line, w.Body.String())
		}
	}
	if strings.Contains(w.Body.String(), "private-task") || strings.Contains(w.Body.String(), "MY-SECRET-METHOD") || strings.Contains(w.Body.String(), `route="/metrics"`) {
		t.Fatal("metrics expose arbitrary request data or observe themselves")
	}
	second := request(t, app, "GET", "/metrics", "")
	if w.Body.String() != second.Body.String() {
		t.Fatal("scraping metrics modified application metrics")
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	request(t, app, "GET", "/readyz", "")
	request(t, app, "GET", "/livez", "")
	w = request(t, app, "GET", "/metrics", "")
	for _, line := range []string{`tomato_database_errors_total 2`, `tomato_http_requests_total{method="GET",route="/readyz",status="503"} 1`, `tomato_http_requests_total{method="GET",route="/livez",status="200"} 1`} {
		if !strings.Contains(w.Body.String(), line) {
			t.Fatalf("missing unhealthy metric %s", line)
		}
	}
}

func TestMetricsRegistriesAreIsolated(t *testing.T) {
	first, _ := newTestServer(t)
	second, _ := newTestServer(t)
	post(t, first, []Session{{CompletedAt: 1, Minutes: 25, Task: "only-first"}})
	if w := request(t, second, "GET", "/metrics", ""); !strings.Contains(w.Body.String(), "tomato_sessions_saved_total 0") || strings.Contains(w.Body.String(), `route="/api/sessions"`) {
		t.Fatal("metrics leaked between Server instances")
	}
}

func TestLogsUseBoundedLabelsWithoutOriginalRequestData(t *testing.T) {
	app, _ := newTestServer(t)
	var output bytes.Buffer
	app.logger = slog.New(slog.NewJSONHandler(&output, nil))
	request(t, app, "PRIVATE-METHOD", "/private-task-name?task=private-task-name", "")
	if strings.Contains(output.String(), "private-task-name") || strings.Contains(output.String(), "PRIVATE-METHOD") || !strings.Contains(output.String(), `"route":"unknown"`) {
		t.Fatalf("unbounded or sensitive log: %s", output.String())
	}
}

func TestAllowedHostConfigurationIsExactAndSafe(t *testing.T) {
	hosts, err := ParseAllowedHosts("tomato, tomato.tomato.svc.cluster.local, TOMATO,[::1]")
	if err != nil {
		t.Fatal(err)
	}
	if len(hosts) != 3 {
		t.Fatalf("duplicates not removed: %#v", hosts)
	}
	_, config := newTestServer(t)
	config.AllowedHosts = hosts
	app, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	for _, host := range []string{"tomato:4187", "TOMATO:4187", "tomato.tomato.svc.cluster.local:4187", "127.0.0.1:4187", "localhost:4187", "[::1]:4187"} {
		r := httptest.NewRequest("GET", "http://127.0.0.1:4187/readyz", nil)
		r.Host = host
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("allowed host %q = %d", host, w.Code)
		}
	}
	for _, host := range []string{"evil.tomato:4187", "tomato.evil.example:4187", "evil.example:4187"} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:4187/api/sessions", strings.NewReader(`{"sessions":[]}`))
		r.Host = host
		r.Header.Set("Origin", "http://"+host)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("unconfigured host %q = %d", host, w.Code)
		}
	}
	// 额外可信 Host 仍然受 Origin 同源校验保护。
	r := httptest.NewRequest("POST", "http://tomato:4187/api/sessions", strings.NewReader(`{"sessions":[]}`))
	r.Header.Set("Origin", "http://evil.example:4187")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	app.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("cross-origin on allowed host = %d", w.Code)
	}
	for _, raw := range []string{"https://tomato", "tomato:4187", "*.example.com", "tomato,", "tomato,,localhost", "bad_name", "-bad", "bad-", "bad..name", "tomato/path", "tomato@evil.example", " ", "[::1]:4187", strings.Repeat("a", 64)} {
		if _, err := ParseAllowedHosts(raw); err == nil {
			t.Fatalf("invalid ALLOWED_HOSTS accepted %q", raw)
		}
	}
	config.AllowedHosts = []string{"*.example.com"}
	config.Logger = slog.New(slog.NewJSONHandler(io.Discard, nil))
	if _, err := New(config); err == nil {
		t.Fatal("invalid Config.AllowedHosts accepted")
	}
}
