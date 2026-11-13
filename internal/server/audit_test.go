package server

import (
	"bytes"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClipperRejectsCrossSiteBeforeAuthentication(t *testing.T) {
	s := &Server{cfg: Config{AdminPassword: "pw"}, limiter: newLoginLimiter()}
	for _, tc := range []struct {
		name, origin, fetchSite string
		want                    int
	}{
		{"native client", "", "", http.StatusNoContent},
		{"same origin", "http://notes.example", "same-origin", http.StatusNoContent},
		{"chrome extension", "chrome-extension://abcdefghijklmnopabcdefghijklmnop", "cross-site", http.StatusNoContent},
		{"firefox extension", "moz-extension://12345678-1234-1234-1234-123456789abc", "cross-site", http.StatusNoContent},
		{"extension lookalike", "https://chrome-extension.example", "cross-site", http.StatusForbidden},
		{"malformed extension origin", "chrome-extension://id/path", "cross-site", http.StatusForbidden},
		{"foreign origin", "http://evil.example", "", http.StatusForbidden},
		{"foreign scheme", "https://notes.example", "", http.StatusForbidden},
		{"fetch metadata", "", "cross-site", http.StatusForbidden},
		{"opaque origin", "null", "", http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "http://notes.example/api/v1/memos", nil)
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Sec-Fetch-Site", tc.fetchSite)
			r.SetBasicAuth("admin", "pw")
			w := httptest.NewRecorder()
			s.requireClipperPassword(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }).ServeHTTP(w, r)
			if w.Code != tc.want || w.Header().Get("WWW-Authenticate") != "" {
				t.Fatalf("status=%d challenge=%q body=%s", w.Code, w.Header().Get("WWW-Authenticate"), w.Body.String())
			}
		})
	}
	r := httptest.NewRequest(http.MethodGet, "http://notes.example/api/v1/notebooks", nil)
	w := httptest.NewRecorder()
	s.requireClipperPassword(func(http.ResponseWriter, *http.Request) { t.Fatal("unauthenticated handler called") }).ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized || w.Header().Get("WWW-Authenticate") != "" {
		t.Fatalf("unauthorized response: %d %v", w.Code, w.Header())
	}
}

func TestLogoutCookieTransport(t *testing.T) {
	for _, tc := range []struct {
		name, target             string
		trust, forwarded, secure bool
	}{
		{"direct http", "http://notes.example", false, false, false},
		{"direct tls", "https://notes.example", false, false, true},
		{"untrusted proxy", "http://internal", false, true, false},
		{"trusted proxy", "http://internal", true, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{cfg: Config{TrustProxy: tc.trust}}
			r := httptest.NewRequest(http.MethodPost, tc.target, nil)
			if tc.forwarded {
				r.Header.Set("X-Forwarded-Proto", "https")
			}
			w := httptest.NewRecorder()
			s.handleLogout(w, r)
			cookies := w.Result().Cookies()
			if len(cookies) != 1 {
				t.Fatalf("cookies=%v", cookies)
			}
			c := cookies[0]
			if c.Name != sessionCookie || c.Secure != tc.secure || c.MaxAge != -1 || !c.HttpOnly || c.Path != "/" || c.SameSite != http.SameSiteLaxMode {
				t.Fatalf("logout cookie=%+v", c)
			}
		})
	}
}

func TestServerErrorLogsRouteWithoutRequestSecrets(t *testing.T) {
	var logs bytes.Buffer
	old := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(old)
	r := httptest.NewRequest(http.MethodGet, "http://notes.example/api/s/private-token?password=private-password", nil)
	r.Pattern = "GET /api/s/{token}"
	w := httptest.NewRecorder()
	serverError(w, r, errors.New("database detail"))
	if w.Code != http.StatusInternalServerError || strings.Contains(w.Body.String(), "database detail") {
		t.Fatalf("response=%d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(logs.String(), r.Pattern) || !strings.Contains(logs.String(), "database detail") || strings.Contains(logs.String(), "private-token") || strings.Contains(logs.String(), "private-password") {
		t.Fatalf("log=%s", logs.String())
	}
}

func TestRecordValuesDistinguishesMissingFromDatabaseFailure(t *testing.T) {
	db, err := openDB(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	data, err := recordValues(db, "missing-table", "missing-record")
	if err != nil || data != nil {
		t.Fatalf("missing record: %v %v", data, err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if _, err := recordValues(tx, "table", "record"); !errors.Is(err, sql.ErrTxDone) {
		t.Fatalf("transaction failure swallowed: %v", err)
	}
	links := &linkSync{tx: tx, tableID: "table"}
	if err := links.mirror(pairInfo{"other", "pair"}, "target", "source", true); !errors.Is(err, sql.ErrTxDone) {
		t.Fatalf("mirror failure swallowed: %v", err)
	}
}

func TestCloseStopsHousekeepingAndWorkers(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir(), AdminPassword: "pw", TrashDays: 30}, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not stop background workers")
	}
	select {
	case <-s.indexDone:
	default:
		t.Fatal("Close returned before index worker exited")
	}
	if err := s.db.Ping(); err == nil {
		t.Fatal("database remains open after Close")
	}
}

func TestScanRowsReportsIterationFailure(t *testing.T) {
	db, err := openDB(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	seen := 0
	err = scanRows(db, func(rows *sql.Rows) error {
		var n int
		if err := rows.Scan(&n); err != nil {
			return err
		}
		seen++
		return nil
	}, `SELECT json_extract(value, '$.n') FROM (SELECT '{"n":1}' AS value UNION ALL SELECT 'invalid json')`)
	if seen != 1 || err == nil {
		t.Fatalf("partial query accepted: seen=%d err=%v", seen, err)
	}
}
