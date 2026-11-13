package server

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRandStringAlphabet(t *testing.T) {
	for _, n := range []int{1, 12, 22, 64} {
		s := randString(n)
		if len(s) != n {
			t.Fatalf("len %d, want %d", len(s), n)
		}
		for _, c := range s {
			if !strings.ContainsRune(idAlphabet, c) {
				t.Fatalf("unexpected char %q", c)
			}
		}
	}
}

func TestSameOriginForwardedHost(t *testing.T) {
	r := httptest.NewRequest("POST", "http://internal:8080/api/x", nil)
	r.Header.Set("Origin", "https://note.example.com")
	r.Header.Set("X-Forwarded-Host", "note.example.com")
	direct := &Server{cfg: Config{}}
	if direct.sameOrigin(r) {
		t.Fatal("X-Forwarded-Host must be ignored without a trusted proxy")
	}
	proxied := &Server{cfg: Config{TrustProxy: true}}
	if !proxied.sameOrigin(r) {
		t.Fatal("X-Forwarded-Host should be honoured behind a trusted proxy")
	}
}

func TestCheckPasswordCachesVerifiedHash(t *testing.T) {
	h, err := hashPassword("secret")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{secret: []byte("k"), storedHash: h}
	if s.checkPassword("wrong") {
		t.Fatal("wrong password accepted")
	}
	if !s.checkPassword("secret") || s.pwVerified.Load() == nil {
		t.Fatal("correct password not accepted / cached")
	}
	if !s.checkPassword("secret") || s.checkPassword("secreT") {
		t.Fatal("cached verification mismatch")
	}
}

func TestWriteErrorHidesInternalErrors(t *testing.T) {
	rec := httptest.NewRecorder()
	writeError(rec, errors.New("SQL logic error: no such table: secret_stuff"))
	if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "secret_stuff") {
		t.Fatalf("internal error leaked: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	writeError(rec, fmt.Errorf("wrapped: %w", errStatus(http.StatusNotFound, "节点不存在")))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "节点不存在") {
		t.Fatalf("api error not passed through: %d %s", rec.Code, rec.Body.String())
	}
}
