package server

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
)

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

// Basic authentication uses the native admin password verifier and login limiter.
// No WWW-Authenticate challenge is sent: it would make browsers prompt for and then cache
// the credentials, which they attach to cross-site requests on their own.
func (s *Server) requireClipperPassword(h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, pw, basic := r.BasicAuth()
		ip := s.clientIP(r)
		blocked, _ := s.limiter.blocked(ip)
		if !basic || blocked || !s.checkPassword(pw) {
			if basic && !blocked {
				s.limiter.fail(ip)
			}
			clipError(w, http.StatusUnauthorized, "unauthorized", "The admin password is required")
			return
		}
		s.limiter.reset(ip)
		h(w, r)
	})
}

func (s *Server) registerClipper(mux *http.ServeMux) {
	b := s.requireClipperPassword
	mux.Handle("GET /api/v1/notebooks", b(s.clipperNotebooks))
	mux.Handle("POST /api/v1/memos", b(s.clipperCreate))
	mux.Handle("POST /api/v1/memos/with-image", b(s.clipperCreateImage))
	mux.Handle("GET /api/v1/memos/{id}", b(s.clipperGet))
	mux.Handle("DELETE /api/v1/memos/{id}", b(s.clipperDelete))
	mux.Handle("POST /api/v1/memos/{id}/resources", b(s.clipperUpload))
	mux.Handle("POST /api/v1/memos/{id}/edit-sessions", b(s.clipperEditSession))
	mux.Handle("POST /api/v1/memos/{id}/save", b(s.clipperSave))
	mux.Handle("GET /api/v1/resources/{id}/blob", b(s.clipperBlob))
	mux.Handle("/api/v1/", b(func(w http.ResponseWriter, r *http.Request) {
		clipError(w, http.StatusNotFound, "not_found", "Unknown clipper endpoint")
	}))
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
