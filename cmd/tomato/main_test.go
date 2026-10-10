package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func cleanEnv(t *testing.T) {
	t.Helper()
	for _, name := range []string{"PORT", "BIND_ADDR", "DB_PATH", "ALLOWED_HOSTS"} {
		t.Setenv(name, "")
	}
}

func TestEnvironmentDefaultsAndExplicitContainerConfiguration(t *testing.T) {
	cleanEnv(t)
	c, err := readConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.bindAddr != "127.0.0.1" || c.port != "4187" || c.dbPath != filepath.Join("data", "tomato.db") || len(c.allowedHosts) != 0 {
		t.Fatalf("incorrect defaults: %+v", c)
	}
	t.Setenv("BIND_ADDR", "0.0.0.0")
	t.Setenv("PORT", "4188")
	t.Setenv("DB_PATH", "/data/tomato.db")
	t.Setenv("ALLOWED_HOSTS", "tomato,tomato.tomato.svc.cluster.local")
	c, err = readConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.bindAddr != "0.0.0.0" || c.port != "4188" || c.dbPath != "/data/tomato.db" || len(c.allowedHosts) != 2 {
		t.Fatalf("incorrect configured values: %+v", c)
	}
	for _, bind := range []string{"::", "::1"} {
		t.Setenv("BIND_ADDR", bind)
		if _, err := readConfig(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestInvalidEnvironmentFailsBeforeStarting(t *testing.T) {
	for _, test := range []struct{ name, value string }{{"PORT", "0"}, {"PORT", "65536"}, {"PORT", "abc"}, {"PORT", "+4187"}, {"BIND_ADDR", "localhost"}, {"BIND_ADDR", "0.0.0.0:4187"}, {"BIND_ADDR", "https://example.com"}, {"ALLOWED_HOSTS", "*.example.com"}, {"ALLOWED_HOSTS", "tomato:4187"}} {
		t.Run(test.name+"="+test.value, func(t *testing.T) {
			cleanEnv(t)
			t.Setenv(test.name, test.value)
			if _, err := readConfig(); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}

func TestHealthcheckUsesReadyzAndRejectsFailureAndRedirect(t *testing.T) {
	for _, status := range []int{200, 503, 302} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/readyz" {
					t.Errorf("wrong healthcheck endpoint %s", r.URL.Path)
				}
				w.Header().Set("Location", "http://example.com")
				w.WriteHeader(status)
			}))
			defer app.Close()
			_, port, err := net.SplitHostPort(strings.TrimPrefix(app.URL, "http://"))
			if err != nil {
				t.Fatal(err)
			}
			err = healthcheck(config{bindAddr: "0.0.0.0", port: port})
			if (err == nil) != (status == 200) {
				t.Fatalf("healthcheck status %d => %v", status, err)
			}
		})
	}
	app := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(app.URL, "http://"))
	app.Close()
	if err := healthcheck(config{bindAddr: "127.0.0.1", port: port}); err == nil {
		t.Fatal("unreachable server reported healthy")
	}
}

func TestServeShutsDownWhenContextIsCancelled(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- serve(ctx, slog.New(slog.NewJSONHandler(io.Discard, nil)), config{bindAddr: "127.0.0.1", port: port, dbPath: filepath.Join(t.TempDir(), "tomato.db")})
	}()
	deadline := time.Now().Add(5 * time.Second)
	ready := false
	for time.Now().Before(deadline) {
		if healthcheck(config{bindAddr: "127.0.0.1", port: port}) == nil {
			ready = true
			break
		}
		select {
		case err := <-result:
			t.Fatalf("server exited before readiness: %v", err)
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !ready {
		t.Fatal("server did not become ready")
	}
	cancel()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("graceful shutdown timed out")
	}
	if err := healthcheck(config{bindAddr: "127.0.0.1", port: port}); err == nil {
		t.Fatal("server still listening after shutdown")
	}
}

func TestUnknownCommandIsRejected(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	for _, args := range [][]string{{"unexpected"}, {"healthcheck", "extra"}} {
		if err := execute(args, logger); err == nil {
			t.Fatal("unknown command accepted")
		}
	}
}
