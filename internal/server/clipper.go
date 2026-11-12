package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
)

const clipperTokenKey = "clipper_token"

type clipperToken struct {
	Hash        string `json:"hash"`
	Fingerprint string `json:"fingerprint"`
	AllowAI     bool   `json:"allow_ai"`
}
type clipperAuthKey struct{}

func clipHash(text string) string { h := sha256.Sum256([]byte(text)); return hex.EncodeToString(h[:]) }
func clipRandom() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func clipError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"message": message, "code": code}})
}
func (s *Server) clipToken() clipperToken {
	var t clipperToken
	v, _ := s.getSetting(clipperTokenKey)
	json.Unmarshal([]byte(v), &t)
	return t
}
func (s *Server) clipTokenValid(t clipperToken) bool {
	return len(t.Hash) == 64 && subtle.ConstantTimeCompare([]byte(t.Fingerprint), []byte(hex.EncodeToString(s.pwFingerprint))) == 1
}
func (s *Server) requireClipper(h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Fields(r.Header.Get("Authorization"))
		t := s.clipToken()
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || !s.clipTokenValid(t) || subtle.ConstantTimeCompare([]byte(clipHash(parts[1])), []byte(t.Hash)) != 1 {
			clipError(w, 401, "unauthorized", "A valid clipper Bearer token is required")
			return
		}
		h(w, r.WithContext(context.WithValue(r.Context(), clipperAuthKey{}, t)))
	})
}

// Keep the existing cookie and origin guard, converting its errors to the extension envelope.
type clipperAdminWriter struct {
	http.ResponseWriter
	status int
}

func (w *clipperAdminWriter) WriteHeader(status int) {
	w.status = status
	if status < 400 {
		w.ResponseWriter.WriteHeader(status)
	}
}
func (w *clipperAdminWriter) Write(b []byte) (int, error) {
	if w.status >= 400 {
		var e struct {
			Error json.RawMessage `json:"error"`
		}
		var message string
		if json.Unmarshal(b, &e) == nil && json.Unmarshal(e.Error, &message) == nil {
			clipError(w.ResponseWriter, w.status, "request_rejected", message)
			return len(b), nil
		}
		w.ResponseWriter.WriteHeader(w.status)
	}
	return w.ResponseWriter.Write(b)
}
func (s *Server) clipperAdmin(h http.HandlerFunc) http.Handler {
	guarded := s.requireAdmin(h)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		guarded.ServeHTTP(&clipperAdminWriter{ResponseWriter: w}, r)
	})
}
func (s *Server) clipperRotateToken(w http.ResponseWriter, r *http.Request) {
	var in struct {
		AllowAI bool `json:"allow_ai"`
	}
	if readJSON(r, &in) != nil {
		clipError(w, 400, "invalid_request", "Invalid token settings")
		return
	}
	token := clipRandom()
	t := clipperToken{Hash: clipHash(token), Fingerprint: hex.EncodeToString(s.pwFingerprint), AllowAI: in.AllowAI}
	b, _ := json.Marshal(t)
	tx, err := s.db.Begin()
	if err != nil {
		clipError(w, 500, "storage_error", "Cannot rotate token")
		return
	}
	defer tx.Rollback()
	_, err = tx.Exec(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, clipperTokenKey, string(b))
	if err == nil {
		_, err = tx.Exec(`DELETE FROM clipper_edit_sessions`)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		clipError(w, 500, "storage_error", "Cannot rotate token")
		return
	}
	writeJSON(w, 200, map[string]any{"token": token, "allow_ai": in.AllowAI})
}
func (s *Server) clipperRevokeToken(w http.ResponseWriter, r *http.Request) {
	tx, err := s.db.Begin()
	if err != nil {
		clipError(w, 500, "storage_error", "Cannot revoke token")
		return
	}
	defer tx.Rollback()
	_, err = tx.Exec(`DELETE FROM settings WHERE key=?`, clipperTokenKey)
	if err == nil {
		_, err = tx.Exec(`DELETE FROM clipper_edit_sessions`)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		clipError(w, 500, "storage_error", "Cannot revoke token")
		return
	}
	ok(w)
}
func (s *Server) registerClipper(mux *http.ServeMux) {
	a := s.clipperAdmin
	b := s.requireClipper
	mux.Handle("GET /api/clipper/settings", a(s.clipperGetSettings))
	mux.Handle("PUT /api/clipper/settings", a(s.clipperPutSettings))
	mux.Handle("POST /api/clipper/token", a(s.clipperRotateToken))
	mux.Handle("DELETE /api/clipper/token", a(s.clipperRevokeToken))
	mux.Handle("GET /api/v1/notebooks", b(s.clipperNotebooks))
	mux.Handle("POST /api/v1/memos", b(s.clipperCreate))
	mux.Handle("POST /api/v1/memos/with-image", b(s.clipperCreateImage))
	mux.Handle("GET /api/v1/memos/{id}", b(s.clipperGet))
	mux.Handle("DELETE /api/v1/memos/{id}", b(s.clipperDelete))
	mux.Handle("POST /api/v1/memos/{id}/resources", b(s.clipperUpload))
	mux.Handle("POST /api/v1/memos/{id}/edit-sessions", b(s.clipperEditSession))
	mux.Handle("POST /api/v1/memos/{id}/save", b(s.clipperSave))
	mux.Handle("GET /api/v1/resources/{id}/blob", b(s.clipperBlob))
	mux.Handle("POST /api/v1/ai/video-outline/prepare", b(s.clipperPrepareAI))
	mux.HandleFunc("/api/v1/", func(w http.ResponseWriter, r *http.Request) {
		clipError(w, 404, "not_found", "Unknown clipper endpoint")
	})
}

// Used by bounded multipart image validation without trusting the supplied MIME header.
func clipImageType(b []byte) string {
	mt := http.DetectContentType(b)
	switch mt {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-icon":
		return mt
	}
	if len(b) >= 12 && bytes.Equal(b[4:8], []byte("ftyp")) && (bytes.Equal(b[8:12], []byte("avif")) || bytes.Equal(b[8:12], []byte("avis"))) {
		return "image/avif"
	}
	return ""
}
