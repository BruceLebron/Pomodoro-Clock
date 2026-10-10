// Package server 提供本机番茄时钟服务和 SQLite 专注记录存储。
package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"

	_ "modernc.org/sqlite"
)

const (
	Version             = "0.4.0"
	MaxSessions         = 1000
	MaxBodyBytes        = 1 << 20
	maxDateMillis int64 = 8640000000000000
)

type Config struct {
	DBPath       string
	StaticDir    string
	Logger       *slog.Logger
	AllowedHosts []string
}

type Server struct {
	db           *sql.DB
	staticDir    string
	logger       *slog.Logger
	allowedHosts map[string]bool
	metrics      *metrics
}

type Session struct {
	ID          string `json:"id"`
	CompletedAt int64  `json:"completedAt"`
	Minutes     int    `json:"minutes"`
	Task        string `json:"task"`
}

type inputSession struct {
	ID          *string `json:"id,omitempty"`
	CompletedAt int64   `json:"completedAt"`
	Minutes     int     `json:"minutes"`
	Task        *string `json:"task"`
}

// New 创建数据库目录，并把 WAL 与忙等待策略应用于唯一数据库连接。
func New(config Config) (*Server, error) {
	allowedHosts := map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true}
	for _, name := range config.AllowedHosts {
		host, err := configuredHostname(name)
		if err != nil {
			return nil, fmt.Errorf("invalid allowed hostname %q: %w", name, err)
		}
		allowedHosts[host] = true
	}
	if config.DBPath == "" {
		config.DBPath = filepath.Join("data", "tomato.db")
	}
	if config.StaticDir == "" {
		config.StaticDir = "."
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	staticDir, err := filepath.Abs(config.StaticDir)
	if err != nil {
		return nil, fmt.Errorf("resolve static directory: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(config.DBPath), 0700); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}
	db, err := sql.Open("sqlite", config.DBPath)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	// 单连接保证每次请求使用已经设置 PRAGMA 的连接，也避免连接间写锁竞争。
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, query := range []string{
		"PRAGMA busy_timeout = 5000",
		"PRAGMA journal_mode = WAL",
		`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			completed_at INTEGER NOT NULL CHECK(completed_at > 0 AND completed_at <= 8640000000000000),
			minutes INTEGER NOT NULL CHECK(minutes BETWEEN 1 AND 180),
			task TEXT NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS sessions_completed_at ON sessions(completed_at, id)",
	} {
		if _, err := db.ExecContext(ctx, query); err != nil {
			db.Close()
			return nil, fmt.Errorf("initialize database: %w", err)
		}
	}
	return &Server{db: db, staticDir: staticDir, logger: config.Logger, allowedHosts: allowedHosts, metrics: newMetrics()}, nil
}

func (s *Server) Close() error { return s.db.Close() }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	method, route := metricMethod(r.Method), metricRoute(r.URL.Path)
	defer func() {
		elapsed := time.Since(started)
		s.metrics.observe(method, route, recorder.status, elapsed)
		s.logger.Info("http_request", "method", method, "route", route, "status", recorder.status, "duration_ms", elapsed.Milliseconds())
	}()
	// 即使 TCP 连接落在本机，也拒绝外部域名的 Host，阻断 DNS rebinding 读取或写入。
	if !s.allowedHost(r.Host) {
		writeError(recorder, http.StatusForbidden, "Host is not allowed")
		return
	}
	switch r.URL.Path {
	case "/livez":
		if r.Method != http.MethodGet {
			methodNotAllowed(recorder, http.MethodGet)
			return
		}
		writeJSON(recorder, http.StatusOK, map[string]string{"status": "ok", "version": Version})
	case "/healthz", "/readyz":
		if r.Method != http.MethodGet {
			methodNotAllowed(recorder, http.MethodGet)
			return
		}
		var ready int
		if err := s.db.QueryRowContext(r.Context(), "SELECT 1").Scan(&ready); err != nil {
			s.metrics.databaseErrors.Inc()
			s.logger.Error("database_health_failed", "error", err)
			writeError(recorder, http.StatusServiceUnavailable, "database unavailable")
			return
		}
		writeJSON(recorder, http.StatusOK, map[string]string{"status": "ok", "version": Version})
	case "/metrics":
		if r.Method != http.MethodGet {
			methodNotAllowed(recorder, http.MethodGet)
			return
		}
		s.metrics.handler.ServeHTTP(recorder, r)
	case "/api/sessions":
		switch r.Method {
		case http.MethodGet:
			s.listSessions(recorder, r)
		case http.MethodPost:
			s.saveSessions(recorder, r)
		default:
			methodNotAllowed(recorder, "GET, POST")
		}
	default:
		s.serveStatic(recorder, r)
	}
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	// 单个读事务使 total 与记录列表来自同一数据库快照。
	tx, err := s.db.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer tx.Rollback()
	var total int
	if err := tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM sessions").Scan(&total); err != nil {
		s.databaseError(w, err)
		return
	}
	rows, err := tx.QueryContext(r.Context(), `SELECT id, completed_at, minutes, task FROM (
		SELECT id, completed_at, minutes, task FROM sessions ORDER BY completed_at DESC, id DESC LIMIT 1000
	) ORDER BY completed_at ASC, id ASC`)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	sessions := make([]Session, 0)
	for rows.Next() {
		var session Session
		if err := rows.Scan(&session.ID, &session.CompletedAt, &session.Minutes, &session.Task); err != nil {
			rows.Close()
			s.databaseError(w, err)
			return
		}
		sessions = append(sessions, session)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		s.databaseError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		s.databaseError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Sessions []Session `json:"sessions"`
		Total    int       `json:"total"`
	}{sessions, total})
}

func (s *Server) saveSessions(w http.ResponseWriter, r *http.Request) {
	// 浏览器必须同源；无 Origin 的命令行请求仍可用于诊断和备份。
	if origin := r.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Scheme != "http" || parsed.User != nil || !strings.EqualFold(parsed.Host, r.Host) || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			writeError(w, http.StatusForbidden, "cross-origin writes are not allowed")
			return
		}
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "Content-Type must be application/json")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)
	defer r.Body.Close()
	rawBody, err := io.ReadAll(r.Body)
	if err != nil {
		decodeError(w, err)
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(rawBody))
	decoder.DisallowUnknownFields()
	var body struct {
		Sessions *[]inputSession `json:"sessions"`
	}
	if err := decoder.Decode(&body); err != nil {
		decodeError(w, err)
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			writeError(w, http.StatusBadRequest, "request must contain exactly one JSON object")
		} else {
			decodeError(w, err)
		}
		return
	}
	// 标准库默认允许重复对象字段；明确拒绝它们，避免同一请求有多种解释。
	if err := checkUniqueJSONKeys(json.NewDecoder(bytes.NewReader(rawBody))); err != nil {
		writeError(w, http.StatusBadRequest, "duplicate JSON object fields are not allowed")
		return
	}
	if body.Sessions == nil {
		writeError(w, http.StatusBadRequest, "sessions must be an array")
		return
	}
	if len(*body.Sessions) > MaxSessions {
		writeError(w, http.StatusBadRequest, "at most 1000 sessions are allowed")
		return
	}
	sessions := make([]Session, 0, len(*body.Sessions))
	// 先验证整个批次，再开启事务；坏记录不会造成前面的记录部分写入。
	for i, input := range *body.Sessions {
		if input.CompletedAt <= 0 || input.CompletedAt > maxDateMillis || input.Minutes < 1 || input.Minutes > 180 || input.Task == nil {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid session at index %d", i))
			return
		}
		task := normalizeTask(*input.Task)
		if len(utf16.Encode([]rune(task))) > 80 {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("task exceeds 80 UTF-16 code units at index %d", i))
			return
		}
		session := Session{CompletedAt: input.CompletedAt, Minutes: input.Minutes, Task: task}
		session.ID = sessionID(session)
		sessions = append(sessions, session)
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer tx.Rollback()
	saved := 0
	for _, session := range sessions {
		result, err := tx.ExecContext(r.Context(), "INSERT INTO sessions(id, completed_at, minutes, task) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING", session.ID, session.CompletedAt, session.Minutes, session.Task)
		if err != nil {
			s.databaseError(w, err)
			return
		}
		count, err := result.RowsAffected()
		if err != nil {
			s.databaseError(w, err)
			return
		}
		saved += int(count)
	}
	if err := tx.Commit(); err != nil {
		s.databaseError(w, err)
		return
	}
	s.metrics.saved.Add(float64(saved))
	writeJSON(w, http.StatusOK, struct {
		Sessions []Session `json:"sessions"`
		Saved    int       `json:"saved"`
	}{sessions, saved})
}

// normalizeTask 使用 JavaScript \s 的空白集合，保持前后端任务名称一致。
func normalizeTask(task string) string {
	return strings.Join(strings.FieldsFunc(task, func(r rune) bool {
		return r == '\t' || r == '\n' || r == '\v' || r == '\f' || r == '\r' || r == ' ' || r == 0xA0 || r == 0x1680 || (r >= 0x2000 && r <= 0x200A) || r == 0x2028 || r == 0x2029 || r == 0x202F || r == 0x205F || r == 0x3000 || r == 0xFEFF
	}), " ")
}

// ID 由服务端根据规范化内容计算；客户端伪造 ID 不会覆盖另一条记录。
func sessionID(session Session) string {
	var canonical bytes.Buffer
	encoder := json.NewEncoder(&canonical)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode([]any{session.CompletedAt, session.Minutes, session.Task})
	digest := sha256.Sum256(bytes.TrimSuffix(canonical.Bytes(), []byte("\n")))
	return hex.EncodeToString(digest[:])
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	files := map[string]string{"/": "index.html", "/index.html": "index.html", "/style.css": "style.css", "/app.js": "app.js", "/timer-core.js": "timer-core.js", "/sync.js": "sync.js"}
	filename, allowed := files[r.URL.Path]
	if !allowed {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, "GET, HEAD")
		return
	}
	file, err := os.Open(filepath.Join(s.staticDir, filename))
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, filename, info.ModTime(), file)
}

func (s *Server) databaseError(w http.ResponseWriter, err error) {
	s.metrics.databaseErrors.Inc()
	s.logger.Error("database_request_failed", "error", err)
	writeError(w, http.StatusInternalServerError, "database operation failed")
}

func decodeError(w http.ResponseWriter, err error) {
	var limitError *http.MaxBytesError
	if errors.As(err, &limitError) {
		writeError(w, http.StatusRequestEntityTooLarge, "request body exceeds 1 MiB")
		return
	}
	writeError(w, http.StatusBadRequest, "invalid JSON request")
}

func checkUniqueJSONKeys(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, isContainer := token.(json.Delim)
	if !isContainer {
		return nil
	}
	switch delimiter {
	case '{':
		keys := make(map[string]bool)
		for decoder.More() {
			token, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := token.(string)
			if !ok {
				return errors.New("invalid object key")
			}
			if keys[key] {
				return errors.New("duplicate object key")
			}
			keys[key] = true
			if err := checkUniqueJSONKeys(decoder); err != nil {
				return err
			}
		}
	case '[':
		for decoder.More() {
			if err := checkUniqueJSONKeys(decoder); err != nil {
				return err
			}
		}
	default:
		return errors.New("unexpected closing delimiter")
	}
	_, err = decoder.Token()
	return err
}

func methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	writeError(w, http.StatusMethodNotAllowed, "method not allowed")
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}
