package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestServer(t *testing.T) (*Server, Config) {
	t.Helper()
	root := t.TempDir()
	for name, content := range map[string]string{"index.html": "<!doctype html><title>Tomato</title>", "app.js": "console.log('tomato');", "sync.js": "// synchronization"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	config := Config{DBPath: filepath.Join(root, "data", "tomato.db"), StaticDir: root, Logger: slog.New(slog.NewJSONHandler(io.Discard, nil))}
	app, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { app.Close() })
	return app, config
}

func request(t *testing.T, app *Server, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "http://127.0.0.1:4187"+path, strings.NewReader(body))
	if method == http.MethodPost {
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	app.ServeHTTP(w, r)
	return w
}

func post(t *testing.T, app *Server, sessions any) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]any{"sessions": sessions})
	if err != nil {
		t.Fatal(err)
	}
	return request(t, app, http.MethodPost, "/api/sessions", string(body))
}

func decodeList(t *testing.T, app *Server) ([]Session, int) {
	t.Helper()
	w := request(t, app, http.MethodGet, "/api/sessions", "")
	if w.Code != http.StatusOK {
		t.Fatalf("GET status %d: %s", w.Code, w.Body.String())
	}
	var response struct {
		Sessions []Session `json:"sessions"`
		Total    int       `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response.Sessions, response.Total
}

func TestHealthAndUnavailableDatabase(t *testing.T) {
	app, _ := newTestServer(t)
	w := request(t, app, "GET", "/healthz", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"ok"`) || !strings.Contains(w.Body.String(), `"version":"0.4.0"`) {
		t.Fatalf("unexpected health: %d %s", w.Code, w.Body.String())
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	w = request(t, app, "GET", "/healthz", "")
	if w.Code != 503 {
		t.Fatalf("closed database health = %d", w.Code)
	}
}

func TestIdempotentRetryAndClientIDCannotOverwrite(t *testing.T) {
	app, _ := newTestServer(t)
	body := `{"sessions":[{"completedAt":1760000000000,"minutes":25,"task":"  学习\t Go  ","id":"client-forged"},{"completedAt":1760000000000,"minutes":25,"task":"学习 Go","id":"other"}]}`
	var response struct {
		Sessions []Session `json:"sessions"`
		Saved    int       `json:"saved"`
	}
	first := request(t, app, "POST", "/api/sessions", body)
	if first.Code != 200 {
		t.Fatalf("first save = %d %s", first.Code, first.Body.String())
	}
	if err := json.Unmarshal(first.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Saved != 1 || len(response.Sessions) != 2 || response.Sessions[0].ID != response.Sessions[1].ID || len(response.Sessions[0].ID) != 64 || response.Sessions[0].Task != "学习 Go" {
		t.Fatalf("unexpected save: %+v", response)
	}
	firstID := response.Sessions[0].ID
	retry := request(t, app, "POST", "/api/sessions", body)
	if err := json.Unmarshal(retry.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if retry.Code != 200 || response.Saved != 0 || response.Sessions[0].ID != firstID {
		t.Fatalf("retry = %d %+v", retry.Code, response)
	}
	other := post(t, app, []map[string]any{{"completedAt": 1760000000000, "minutes": 25, "task": "另一个任务", "id": firstID}})
	if other.Code != 200 {
		t.Fatal(other.Body.String())
	}
	sessions, total := decodeList(t, app)
	if total != 2 || len(sessions) != 2 {
		t.Fatalf("client overwrote a record: %+v", sessions)
	}
}

func TestPersistsAcrossServerRestart(t *testing.T) {
	app, config := newTestServer(t)
	w := post(t, app, []Session{{CompletedAt: 1760000000000, Minutes: 25, Task: "重启前"}})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	sessions, total := decodeList(t, restarted)
	if total != 1 || sessions[0].Task != "重启前" {
		t.Fatalf("lost persisted records: %+v", sessions)
	}
}

func TestInvalidBatchNeverPartiallyWrites(t *testing.T) {
	app, _ := newTestServer(t)
	cases := map[string]string{
		"missing array":             `{}`,
		"null array":                `{"sessions":null}`,
		"not an array":              `{"sessions":{}}`,
		"missing task":              `{"sessions":[{"completedAt":1,"minutes":25}]}`,
		"null task":                 `{"sessions":[{"completedAt":1,"minutes":25,"task":null}]}`,
		"minutes zero":              `{"sessions":[{"completedAt":1,"minutes":0,"task":""}]}`,
		"minutes large":             `{"sessions":[{"completedAt":1,"minutes":181,"task":""}]}`,
		"fractional minutes":        `{"sessions":[{"completedAt":1,"minutes":1.5,"task":""}]}`,
		"date zero":                 `{"sessions":[{"completedAt":0,"minutes":25,"task":""}]}`,
		"date too large":            `{"sessions":[{"completedAt":8640000000000001,"minutes":25,"task":""}]}`,
		"date fractional":           `{"sessions":[{"completedAt":1.5,"minutes":25,"task":""}]}`,
		"unknown root field":        `{"sessions":[],"extra":true}`,
		"unknown nested field":      `{"sessions":[{"completedAt":1,"minutes":25,"task":"","extra":1}]}`,
		"trailing JSON":             `{"sessions":[]} {"sessions":[]}`,
		"malformed JSON":            `{"sessions":`,
		"valid followed by invalid": `{"sessions":[{"completedAt":1,"minutes":25,"task":"valid"},{"completedAt":2,"minutes":0,"task":"invalid"}]}`,
		"overlong task":             fmt.Sprintf(`{"sessions":[{"completedAt":1,"minutes":25,"task":%q}]}`, strings.Repeat("a", 81)),
		"overlong UTF16 task":       fmt.Sprintf(`{"sessions":[{"completedAt":1,"minutes":25,"task":%q}]}`, strings.Repeat("🍅", 41)),
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			w := request(t, app, "POST", "/api/sessions", body)
			if w.Code != 400 {
				t.Fatalf("status = %d: %s", w.Code, w.Body.String())
			}
			_, total := decodeList(t, app)
			if total != 0 {
				t.Fatalf("invalid batch wrote %d records", total)
			}
		})
	}
}

func TestTransactionRollsBackOnDatabaseFailure(t *testing.T) {
	app, _ := newTestServer(t)
	_, err := app.db.Exec(`CREATE TRIGGER fail_second_record BEFORE INSERT ON sessions WHEN NEW.task = 'fail' BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
	if err != nil {
		t.Fatal(err)
	}
	w := post(t, app, []Session{{CompletedAt: 1, Minutes: 25, Task: "first"}, {CompletedAt: 2, Minutes: 25, Task: "fail"}})
	if w.Code != 500 {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	_, total := decodeList(t, app)
	if total != 0 {
		t.Fatalf("transaction partially wrote %d records", total)
	}
}

func TestDuplicateJSONFieldsAreRejected(t *testing.T) {
	app, _ := newTestServer(t)
	for _, body := range []string{
		`{"sessions":[],"sessions":[]}`,
		`{"sessions":[{"completedAt":1,"completedAt":2,"minutes":25,"task":"duplicate"}]}`,
		`{"sessions":[{"completedAt":1,"minutes":25,"task":"first","task":"second"}]}`,
	} {
		w := request(t, app, "POST", "/api/sessions", body)
		if w.Code != 400 {
			t.Fatalf("duplicate field status = %d: %s", w.Code, w.Body.String())
		}
	}
	_, total := decodeList(t, app)
	if total != 0 {
		t.Fatalf("duplicate fields wrote %d records", total)
	}
}

func TestBodyLimitAndBatchLimit(t *testing.T) {
	app, _ := newTestServer(t)
	w := request(t, app, "POST", "/api/sessions", `{"sessions":[],"padding":"`+strings.Repeat("x", MaxBodyBytes)+`"}`)
	// 未知字段本身会被严格 JSON 校验先拒绝；用合法字段验证真正的 body 上限。
	if w.Code != 400 && w.Code != 413 {
		t.Fatalf("unknown huge body = %d", w.Code)
	}
	w = request(t, app, "POST", "/api/sessions", `{"sessions":[{"completedAt":1,"minutes":25,"task":"`+strings.Repeat("x", MaxBodyBytes)+`"}]}`)
	if w.Code != 413 {
		t.Fatalf("huge body status = %d: %s", w.Code, w.Body.String())
	}
	sessions := make([]Session, 1001)
	for i := range sessions {
		sessions[i] = Session{CompletedAt: int64(i + 1), Minutes: 1, Task: ""}
	}
	w = post(t, app, sessions)
	if w.Code != 400 {
		t.Fatalf("huge batch status = %d: %s", w.Code, w.Body.String())
	}
	_, total := decodeList(t, app)
	if total != 0 {
		t.Fatalf("invalid request wrote %d records", total)
	}
}

func TestEmptyBatchAndUTF16Boundary(t *testing.T) {
	app, _ := newTestServer(t)
	w := request(t, app, "POST", "/api/sessions", `{"sessions":[]}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"sessions":[]`) || !strings.Contains(w.Body.String(), `"saved":0`) {
		t.Fatalf("empty batch = %d %s", w.Code, w.Body.String())
	}
	w = post(t, app, []Session{{CompletedAt: maxDateMillis, Minutes: 180, Task: strings.Repeat("🍅", 40)}})
	if w.Code != 200 {
		t.Fatalf("boundary task = %d %s", w.Code, w.Body.String())
	}
	if got := normalizeTask("\uFEFF  学习\u00A0\u2028 Go \t "); got != "学习 Go" {
		t.Fatalf("normalization = %q", got)
	}
}

func TestLatest1000SortedWithAccurateTotal(t *testing.T) {
	app, _ := newTestServer(t)
	sessions := make([]Session, 1000)
	for i := range sessions {
		sessions[i] = Session{CompletedAt: int64(1001 - i), Minutes: 1, Task: fmt.Sprintf("task%d", i)}
	}
	if w := post(t, app, sessions); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w := post(t, app, []Session{{CompletedAt: 1, Minutes: 1, Task: "oldest"}, {CompletedAt: 1002, Minutes: 1, Task: "latest"}}); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	listed, total := decodeList(t, app)
	if total != 1002 || len(listed) != 1000 || listed[0].CompletedAt != 3 || listed[999].CompletedAt != 1002 {
		t.Fatalf("wrong result: total=%d len=%d first=%d last=%d", total, len(listed), listed[0].CompletedAt, listed[len(listed)-1].CompletedAt)
	}
	for i := 1; i < len(listed); i++ {
		if listed[i-1].CompletedAt > listed[i].CompletedAt {
			t.Fatal("records not ascending")
		}
	}
}

func TestStaticWhitelistAndMethods(t *testing.T) {
	app, config := newTestServer(t)
	if err := os.WriteFile(filepath.Join(config.StaticDir, "secret.txt"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/", "/index.html", "/app.js", "/sync.js"} {
		if w := request(t, app, "GET", path, ""); w.Code != 200 {
			t.Fatalf("allowed path %s = %d", path, w.Code)
		}
	}
	for _, path := range []string{"/.git/config", "/data/tomato.db", "/go.mod", "/secret.txt", "/../secret.txt", "/api/sessions/", "/index.html/", "//app.js"} {
		w := request(t, app, "GET", path, "")
		if w.Code != 404 || bytes.Contains(w.Body.Bytes(), []byte("secret")) {
			t.Fatalf("exposed %s: %d %s", path, w.Code, w.Body.String())
		}
	}
	for _, test := range []struct{ method, path, allow string }{{"PUT", "/api/sessions", "GET, POST"}, {"POST", "/healthz", "GET"}, {"DELETE", "/index.html", "GET, HEAD"}} {
		w := request(t, app, test.method, test.path, "")
		if w.Code != 405 || w.Header().Get("Allow") != test.allow {
			t.Fatalf("wrong method result: %+v = %d %q", test, w.Code, w.Header().Get("Allow"))
		}
	}
	w := request(t, app, "HEAD", "/index.html", "")
	if w.Code != 200 || w.Body.Len() != 0 {
		t.Fatalf("HEAD = %d %s", w.Code, w.Body.String())
	}
}

func TestOriginAndContentTypeChecks(t *testing.T) {
	app, _ := newTestServer(t)
	for _, test := range []struct {
		origin, contentType string
		status              int
	}{
		{"", "application/json", 200},
		{"http://127.0.0.1:4187", "application/json; charset=utf-8", 200},
		{"http://127.0.0.1:9999", "application/json", 403},
		{"https://evil.example", "application/json", 403},
		{"null", "application/json", 403},
		{"http://127.0.0.1:4187/path", "application/json", 403},
		{"https://127.0.0.1:4187", "application/json", 403},
		{"", "text/plain", 415},
		{"", "", 415},
	} {
		t.Run(test.origin+" "+test.contentType, func(t *testing.T) {
			r := httptest.NewRequest("POST", "http://127.0.0.1:4187/api/sessions", strings.NewReader(`{"sessions":[]}`))
			r.Header.Set("Origin", test.origin)
			r.Header.Set("Content-Type", test.contentType)
			w := httptest.NewRecorder()
			app.ServeHTTP(w, r)
			if w.Code != test.status {
				t.Fatalf("status %d != %d: %s", w.Code, test.status, w.Body.String())
			}
		})
	}
}

func TestLoopbackHostRestrictionPreventsDNSRebinding(t *testing.T) {
	app, _ := newTestServer(t)
	for _, host := range []string{"127.0.0.1", "127.0.0.1:4187", "localhost", "LOCALHOST:4187", "[::1]", "[::1]:4187"} {
		t.Run("allowed "+host, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://127.0.0.1:4187/healthz", nil)
			r.Host = host
			w := httptest.NewRecorder()
			app.ServeHTTP(w, r)
			if w.Code != http.StatusOK {
				t.Fatalf("loopback Host %q = %d: %s", host, w.Code, w.Body.String())
			}
		})
	}
	for _, host := range []string{"evil.example:4187", "example.com", "localhost.evil.example:4187", "127.0.0.1.evil.example:4187", "127.0.0.2:4187", "127.0.0.1:", "localhost:not-a-port", "localhost:0", "localhost:65536", "localhost:1:2", "localhost@evil.example:4187", "::1", "", " localhost:4187"} {
		for _, method := range []string{"GET", "POST"} {
			t.Run("blocked "+method+" "+host, func(t *testing.T) {
				r := httptest.NewRequest(method, "http://127.0.0.1:4187/api/sessions", strings.NewReader(`{"sessions":[{"completedAt":1,"minutes":25,"task":"evil"}]}`))
				r.Host = host
				r.Header.Set("Content-Type", "application/json")
				// 攻击者使用与恶意 Host 完全相同的 Origin，也必须被入口拒绝。
				r.Header.Set("Origin", "http://"+host)
				w := httptest.NewRecorder()
				app.ServeHTTP(w, r)
				if w.Code != http.StatusForbidden {
					t.Fatalf("Host %q with matching Origin = %d: %s", host, w.Code, w.Body.String())
				}
			})
		}
	}
	_, total := decodeList(t, app)
	if total != 0 {
		t.Fatalf("blocked hosts wrote %d records", total)
	}
	// 无 Origin 的本机 CLI 诊断仍然允许访问和写入。
	if w := post(t, app, []Session{{CompletedAt: 1, Minutes: 25, Task: "local CLI"}}); w.Code != 200 {
		t.Fatalf("local CLI = %d: %s", w.Code, w.Body.String())
	}
}
