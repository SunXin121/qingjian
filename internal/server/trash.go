package server

import (
	"database/sql"
	"net/http"
	"time"
)

type TrashItem struct {
	Kind      string `json:"kind"` // repo | node
	ID        string `json:"id"`
	Type      string `json:"type"`
	Title     string `json:"title"`
	RepoID    string `json:"repo_id"`
	RepoName  string `json:"repo_name"`
	DeletedAt int64  `json:"deleted_at"`
}

func (s *Server) listTrash(w http.ResponseWriter, r *http.Request) {
	out := []TrashItem{}
	rows, err := s.db.Query(`SELECT id, name, deleted_at FROM repos WHERE deleted_at IS NOT NULL`)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	for rows.Next() {
		it := TrashItem{Kind: "repo", Type: "repo"}
		rows.Scan(&it.ID, &it.Title, &it.DeletedAt)
		it.RepoID, it.RepoName = it.ID, it.Title
		out = append(out, it)
	}
	rows.Close()
	rows, err = s.db.Query(`SELECT n.id, n.type, n.title, n.repo_id, r.name, n.deleted_at FROM nodes n JOIN repos r ON r.id = n.repo_id
WHERE n.trash_root = 1 AND n.deleted_at IS NOT NULL AND r.deleted_at IS NULL`)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	for rows.Next() {
		it := TrashItem{Kind: "node"}
		rows.Scan(&it.ID, &it.Type, &it.Title, &it.RepoID, &it.RepoName, &it.DeletedAt)
		out = append(out, it)
	}
	rows.Close()
	// newest first
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].DeletedAt > out[j-1].DeletedAt; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	writeJSON(w, 200, out)
}

func (s *Server) restoreTrash(w http.ResponseWriter, r *http.Request) {
	kind, id := r.PathValue("kind"), r.PathValue("id")
	tx, err := s.db.Begin()
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer tx.Rollback()
	switch kind {
	case "repo":
		tx.Exec(`UPDATE repos SET deleted_at = NULL WHERE id = ?`, id)
	case "node":
		var deletedAt int64
		var parentID *string
		if err := tx.QueryRow(`SELECT deleted_at, parent_id FROM nodes WHERE id = ? AND trash_root = 1`, id).Scan(&deletedAt, &parentID); err != nil {
			httpError(w, 404, "条目不存在")
			return
		}
		ids, err := descendantIDs(tx, id, false)
		if err != nil {
			httpError(w, 500, err.Error())
			return
		}
		for _, x := range ids {
			// only revive descendants deleted together with the root
			tx.Exec(`UPDATE nodes SET deleted_at = NULL, trash_root = 0 WHERE id = ? AND deleted_at = ?`, x, deletedAt)
		}
		// if the original parent is gone, put it back at the root
		if parentID != nil {
			var alive int
			tx.QueryRow(`SELECT COUNT(*) FROM nodes WHERE id = ? AND deleted_at IS NULL`, *parentID).Scan(&alive)
			if alive == 0 {
				tx.Exec(`UPDATE nodes SET parent_id = NULL WHERE id = ?`, id)
			}
		}
	default:
		httpError(w, 400, "未知类型")
		return
	}
	if err := tx.Commit(); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	ok(w)
}

func (s *Server) purgeTrash(w http.ResponseWriter, r *http.Request) {
	tx, err := s.db.Begin()
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer tx.Rollback()
	if err := purgeItem(tx, r.PathValue("kind"), r.PathValue("id")); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	if err := tx.Commit(); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	ok(w)
}

func purgeItem(tx *sql.Tx, kind, id string) error {
	switch kind {
	case "repo":
		if _, err := tx.Exec(`DELETE FROM docs_fts WHERE node_id IN (SELECT id FROM nodes WHERE repo_id = ?)`, id); err != nil {
			return err
		}
		_, err := tx.Exec(`DELETE FROM repos WHERE id = ? AND deleted_at IS NOT NULL`, id)
		return err
	case "node":
		ids, err := descendantIDs(tx, id, false)
		if err != nil {
			return err
		}
		for _, x := range ids {
			tx.Exec(`DELETE FROM docs_fts WHERE node_id = ?`, x)
			tx.Exec(`DELETE FROM nodes WHERE id = ?`, x)
		}
	}
	return nil
}

func (s *Server) purgeExpiredTrash(age time.Duration) (int, error) {
	cutoff := time.Now().Add(-age).UnixMilli()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	type item struct{ kind, id string }
	var items []item
	rows, err := tx.Query(`SELECT 'repo', id FROM repos WHERE deleted_at < ? UNION ALL SELECT 'node', id FROM nodes WHERE trash_root = 1 AND deleted_at < ?`, cutoff, cutoff)
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var it item
		rows.Scan(&it.kind, &it.id)
		items = append(items, it)
	}
	rows.Close()
	for _, it := range items {
		if err := purgeItem(tx, it.kind, it.id); err != nil {
			return 0, err
		}
	}
	return len(items), tx.Commit()
}
