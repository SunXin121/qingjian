package server

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"runtime"
	"time"
)

func now() int64 { return time.Now().UnixMilli() }

const idAlphabet = "0123456789abcdefghijklmnopqrstuvwxyz"

// newID returns a 12-char random lowercase id (~62 bits).
func newID() string { return randString(12) }

// randString returns n characters drawn uniformly from idAlphabet. Bytes at or above
// the largest multiple of the alphabet size are rejected, so no character is favoured.
func randString(n int) string {
	const limit = 256 - 256%len(idAlphabet)
	out := make([]byte, 0, n)
	buf := make([]byte, n+n/4+1)
	for len(out) < n {
		rand.Read(buf)
		for _, c := range buf {
			if int(c) < limit {
				out = append(out, idAlphabet[int(c)%len(idAlphabet)])
				if len(out) == n {
					break
				}
			}
		}
	}
	return string(out)
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

// apiError is an error whose status and message are meant for the client.
type apiError struct {
	status int
	msg    string
}

func (e *apiError) Error() string { return e.msg }

// errStatus returns an error that writeError answers with the given status and message.
func errStatus(status int, msg string) error { return &apiError{status, msg} }

// writeError answers with err: an apiError as it is, anything else as an internal error,
// which is logged with its call site but never shown to the client (it may quote SQL).
func writeError(w http.ResponseWriter, err error) {
	var ae *apiError
	if errors.As(err, &ae) {
		httpError(w, ae.status, ae.msg)
		return
	}
	logInternal(2, err)
	httpError(w, http.StatusInternalServerError, "服务器内部错误")
}

// serverError logs err and answers 500 without revealing it.
func serverError(w http.ResponseWriter, err error) {
	logInternal(2, err)
	httpError(w, http.StatusInternalServerError, "服务器内部错误")
}

func logInternal(skip int, err error) {
	where := "?"
	if _, file, line, ok := runtime.Caller(skip); ok {
		where = fmt.Sprintf("%s:%d", filepath.Base(file), line)
	}
	log.Printf("internal error (%s): %v", where, err)
}

// querier is what read helpers need, so they work on the database and inside a transaction.
type querier interface {
	QueryRow(string, ...any) *sql.Row
	Query(string, ...any) (*sql.Rows, error)
}

// rowScanner is a *sql.Row or *sql.Rows.
type rowScanner interface{ Scan(...any) error }

// scanRows runs a query and calls each for every row, then reports any iteration error.
func scanRows(q querier, each func(*sql.Rows) error, query string, args ...any) error {
	rows, err := q.Query(query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := each(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

// withTx runs fn in a transaction and commits it when fn returns nil.
func (s *Server) withTx(fn func(tx *sql.Tx) error) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func readJSON(r *http.Request, v any) error {
	if r.Body == nil {
		return errors.New("empty body")
	}
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 32<<20))
	return dec.Decode(v)
}

func ok(w http.ResponseWriter) { writeJSON(w, http.StatusOK, map[string]bool{"ok": true}) }
