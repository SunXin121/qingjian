package server

import (
	"cmp"
	"database/sql"
	"math"
	"net/http"
	"slices"
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
	err := scanRows(s.db, func(rows *sql.Rows) error {
		it := TrashItem{Kind: "repo", Type: "repo"}
		if err := rows.Scan(&it.ID, &it.Title, &it.DeletedAt); err != nil {
			return err
		}
		it.RepoID, it.RepoName = it.ID, it.Title
		out = append(out, it)
		return nil
	}, `SELECT id, name, deleted_at FROM repos WHERE deleted_at IS NOT NULL`)
	if err == nil {
		err = scanRows(s.db, func(rows *sql.Rows) error {
			it := TrashItem{Kind: "node"}
			if err := rows.Scan(&it.ID, &it.Type, &it.Title, &it.RepoID, &it.RepoName, &it.DeletedAt); err != nil {
				return err
			}
			out = append(out, it)
			return nil
		}, `SELECT n.id, n.type, n.title, n.repo_id, r.name, n.deleted_at FROM nodes n JOIN repos r ON r.id = n.repo_id
WHERE n.trash_root = 1 AND n.deleted_at IS NOT NULL AND r.deleted_at IS NULL`)
	}
	if err != nil {
		serverError(w, err)
		return
	}
	// newest first
	slices.SortStableFunc(out, func(a, b TrashItem) int { return cmp.Compare(b.DeletedAt, a.DeletedAt) })
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) restoreTrash(w http.ResponseWriter, r *http.Request) {
	kind, id := r.PathValue("kind"), r.PathValue("id")
	err := s.withTx(func(tx *sql.Tx) error {
		switch kind {
		case "repo":
			_, err := tx.Exec(`UPDATE repos SET deleted_at = NULL WHERE id = ?`, id)
			return err
		case "node":
			return restoreNode(tx, id)
		default:
			return errStatus(http.StatusBadRequest, "未知类型")
		}
	})
	if err != nil {
		writeError(w, err)
		return
	}
	ok(w)
}

// restoreNode revives a trashed node with the descendants deleted together with it.
func restoreNode(tx *sql.Tx, id string) error {
	var deletedAt int64
	var parentID *string
	if err := tx.QueryRow(`SELECT deleted_at, parent_id FROM nodes WHERE id = ? AND trash_root = 1`, id).Scan(&deletedAt, &parentID); err != nil {
		return errStatus(http.StatusNotFound, "条目不存在")
	}
	ids, err := descendantIDs(tx, id, false)
	if err != nil {
		return err
	}
	for _, x := range ids {
		// only revive descendants deleted together with the root
		if _, err := tx.Exec(`UPDATE nodes SET deleted_at = NULL, trash_root = 0 WHERE id = ? AND deleted_at = ?`, x, deletedAt); err != nil {
			return err
		}
	}
	// if the original parent is gone, put it back at the root
	if parentID == nil {
		return nil
	}
	var alive int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM nodes WHERE id = ? AND deleted_at IS NULL`, *parentID).Scan(&alive); err != nil {
		return err
	}
	if alive == 0 {
		_, err = tx.Exec(`UPDATE nodes SET parent_id = NULL WHERE id = ?`, id)
	}
	return err
}

func (s *Server) purgeTrash(w http.ResponseWriter, r *http.Request) {
	err := s.withTx(func(tx *sql.Tx) error { return purgeItem(tx, r.PathValue("kind"), r.PathValue("id")) })
	if err != nil {
		writeError(w, err)
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
		if _, err := tx.Exec(`DELETE FROM shares WHERE (target_type = 'repo' AND target_id = ?)
  OR (target_type = 'node' AND target_id IN (SELECT id FROM nodes WHERE repo_id = ?))`, id, id); err != nil {
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
			for _, q := range []string{
				`DELETE FROM docs_fts WHERE node_id = ?`,
				`DELETE FROM fts_pending WHERE node_id = ?`,
				`DELETE FROM shares WHERE target_type = 'node' AND target_id = ?`,
				`DELETE FROM nodes WHERE id = ?`,
			} {
				if _, err := tx.Exec(q, x); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// emptyTrash deletes everything in the trash for good.
func (s *Server) emptyTrash(w http.ResponseWriter, r *http.Request) {
	var n int
	err := s.withTx(func(tx *sql.Tx) (err error) {
		n, err = purgeTrashedBefore(tx, math.MaxInt64)
		return err
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"purged": n})
}

func (s *Server) purgeExpiredTrash(age time.Duration) (int, error) {
	cutoff := time.Now().Add(-age).UnixMilli()
	var n int
	err := s.withTx(func(tx *sql.Tx) (err error) {
		if n, err = purgeTrashedBefore(tx, cutoff); err != nil {
			return err
		}
		// deleted records stay restorable through undo only briefly; their log goes with the trash
		return purgeDeletedRecordHistory(tx, cutoff)
	})
	return n, err
}

// purgeTrashedBefore deletes the repos and trashed nodes deleted before cutoff (unix ms).
func purgeTrashedBefore(tx *sql.Tx, cutoff int64) (int, error) {
	type item struct{ kind, id string }
	var items []item
	err := scanRows(tx, func(rows *sql.Rows) error {
		var it item
		if err := rows.Scan(&it.kind, &it.id); err != nil {
			return err
		}
		items = append(items, it)
		return nil
	}, `SELECT 'repo', id FROM repos WHERE deleted_at < ? UNION ALL SELECT 'node', id FROM nodes WHERE trash_root = 1 AND deleted_at < ?`, cutoff, cutoff)
	if err != nil {
		return 0, err
	}
	for _, it := range items {
		if err := purgeItem(tx, it.kind, it.id); err != nil {
			return 0, err
		}
	}
	return len(items), nil
}
