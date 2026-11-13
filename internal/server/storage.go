package server

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// Attachments are referenced from markdown either by URL (/files/<id>/name) or, for
// drawing blocks, by bare id inside the block JSON ({"scene":"<id>","svg":"<id>"}).
var (
	reAttURL     = regexp.MustCompile(`/files/([0-9a-z]{20})`)
	reDrawingRef = regexp.MustCompile(`"(?:scene|svg)"\s*:\s*"([0-9a-z]{20})"`)
)

// Freshly uploaded files are not yet saved into any document; leave them alone for a while.
const cleanupGrace = 24 * time.Hour

func collectRefs(md string, refs map[string]bool) {
	for _, m := range reAttURL.FindAllStringSubmatch(md, -1) {
		refs[m[1]] = true
	}
	for _, m := range reDrawingRef.FindAllStringSubmatch(md, -1) {
		refs[m[1]] = true
	}
}

// referencedAttachments includes repo icons, trashed content and all history
// versions, so restoring a knowledge base or version never yields a broken image.
func (s *Server) referencedAttachments() (map[string]bool, error) {
	refs := map[string]bool{}
	for _, q := range []string{`SELECT icon FROM repos`, `SELECT markdown FROM doc_contents`, `SELECT markdown FROM doc_versions`, `SELECT data FROM bt_records`} {
		rows, err := s.db.Query(q)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var md string
			if err := rows.Scan(&md); err != nil {
				rows.Close()
				return nil, err
			}
			collectRefs(md, refs)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return refs, nil
}

type attRow struct {
	id, sha   string
	size      int64
	createdAt int64
}

type orphanPlan struct {
	attachments []attRow         // rows to delete
	blobs       map[string]int64 // sha → size, blobs left without any row afterwards
	total       []attRow
}

func (s *Server) planCleanup() (*orphanPlan, error) {
	refs, err := s.referencedAttachments()
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(`SELECT id, sha256, size, created_at FROM attachments`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	plan := &orphanPlan{blobs: map[string]int64{}}
	keep := map[string]bool{} // sha256 still used by a surviving row
	cutoff := time.Now().Add(-cleanupGrace).UnixMilli()
	for rows.Next() {
		var a attRow
		if err := rows.Scan(&a.id, &a.sha, &a.size, &a.createdAt); err != nil {
			return nil, err
		}
		plan.total = append(plan.total, a)
		if !refs[a.id] && a.createdAt < cutoff {
			plan.attachments = append(plan.attachments, a)
			if !keep[a.sha] {
				plan.blobs[a.sha] = a.size
			}
		} else {
			keep[a.sha] = true
			delete(plan.blobs, a.sha)
		}
	}
	return plan, rows.Err()
}

func fileSize(p string) int64 {
	if st, err := os.Stat(p); err == nil {
		return st.Size()
	}
	return 0
}

func (s *Server) storageStats(w http.ResponseWriter, r *http.Request) {
	plan, err := s.planCleanup()
	if err != nil {
		serverError(w, err)
		return
	}
	blobs := map[string]int64{}
	var logical int64
	for _, a := range plan.total {
		blobs[a.sha] = a.size
		logical += a.size
	}
	var stored, freed int64
	for _, n := range blobs {
		stored += n
	}
	for _, n := range plan.blobs {
		freed += n
	}
	var docs, versions int
	if err := s.db.QueryRow(`SELECT (SELECT COUNT(*) FROM doc_contents), (SELECT COUNT(*) FROM doc_versions)`).Scan(&docs, &versions); err != nil {
		serverError(w, err)
		return
	}
	dbPath := filepath.Join(s.cfg.DataDir, "qingjian.db")
	writeJSON(w, http.StatusOK, map[string]any{
		"attachments":        len(plan.total),
		"blobs":              len(blobs),
		"logical_bytes":      logical,
		"stored_bytes":       stored,
		"unreferenced":       len(plan.attachments),
		"unreferenced_bytes": freed,
		"docs":               docs,
		"versions":           versions,
		"db_bytes":           fileSize(dbPath) + fileSize(dbPath+"-wal"),
		"grace_hours":        int(cleanupGrace.Hours()),
	})
}

// cleanupAttachments removes attachment rows that no repo, document or version references
// (and that are older than the grace period), then deletes blobs no row points to.
func (s *Server) cleanupAttachments() (removed int, freed int64, err error) {
	s.blobMu.Lock()
	defer s.blobMu.Unlock()
	plan, err := s.planCleanup()
	if err != nil {
		return 0, 0, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()
	for _, a := range plan.attachments {
		if _, err := tx.Exec(`DELETE FROM attachments WHERE id = ?`, a.id); err != nil {
			return 0, 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	for sha, size := range plan.blobs {
		if err := os.Remove(s.blobPath(sha)); err == nil {
			freed += size
		}
	}
	// stale partial uploads
	if entries, err := os.ReadDir(filepath.Join(s.filesDir, "tmp")); err == nil {
		for _, e := range entries {
			if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > cleanupGrace {
				os.Remove(filepath.Join(s.filesDir, "tmp", e.Name()))
			}
		}
	}
	return len(plan.attachments), freed, nil
}

func (s *Server) cleanupFiles(w http.ResponseWriter, r *http.Request) {
	removed, freed, err := s.cleanupAttachments()
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"removed": removed, "freed_bytes": freed})
}
