package server

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

func now() int64 { return time.Now().UnixMilli() }

const idAlphabet = "0123456789abcdefghijklmnopqrstuvwxyz"

// newID returns a 12-char random lowercase id (~62 bits).
func newID() string { return randString(12) }

func randString(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	for i := range b {
		b[i] = idAlphabet[int(b[i])%len(idAlphabet)]
	}
	return string(b)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	if r.Body == nil {
		return errors.New("empty body")
	}
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 32<<20))
	return dec.Decode(v)
}

func ok(w http.ResponseWriter) { writeJSON(w, http.StatusOK, map[string]bool{"ok": true}) }
