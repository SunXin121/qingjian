package server

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
)

var nodeTypes = map[string]bool{"doc": true, "group": true, "table": true}

func (s *Server) loadNode(q querier, id string) (*Node, error) {
	var n Node
	err := q.QueryRow(`SELECT id, repo_id, parent_id, type, title, sort, created_at, updated_at FROM nodes WHERE id = ? AND deleted_at IS NULL`, id).
		Scan(&n.ID, &n.RepoID, &n.ParentID, &n.Type, &n.Title, &n.Sort, &n.CreatedAt, &n.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &n, nil
}

func (s *Server) createNode(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RepoID   string  `json:"repo_id"`
		ParentID *string `json:"parent_id"`
		Type     string  `json:"type"`
		Title    string  `json:"title"`
		Markdown string  `json:"markdown"`
	}
	if err := readJSON(r, &in); err != nil {
		httpError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if in.Type == "" {
		in.Type = "doc"
	}
	if !nodeTypes[in.Type] {
		httpError(w, http.StatusBadRequest, "不支持的节点类型")
		return
	}
	if _, err := s.loadRepo(in.RepoID); err != nil {
		httpError(w, http.StatusNotFound, "知识库不存在")
		return
	}
	if in.ParentID != nil && *in.ParentID == "" {
		in.ParentID = nil
	}
	n := Node{ID: newID(), RepoID: in.RepoID, ParentID: in.ParentID, Type: in.Type, Title: strings.TrimSpace(in.Title), CreatedAt: now()}
	n.UpdatedAt = n.CreatedAt
	err := s.withTx(func(tx *sql.Tx) error {
		if in.ParentID != nil {
			p, err := s.loadNode(tx, *in.ParentID)
			if err != nil || p.RepoID != in.RepoID {
				return errStatus(http.StatusBadRequest, "父节点不存在")
			}
		}
		if err := tx.QueryRow(`SELECT COALESCE(MAX(sort), 0) + 1 FROM nodes WHERE repo_id = ? AND parent_id IS ?`, n.RepoID, n.ParentID).Scan(&n.Sort); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO nodes(id, repo_id, parent_id, type, title, sort, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)`,
			n.ID, n.RepoID, n.ParentID, n.Type, n.Title, n.Sort, n.CreatedAt, n.UpdatedAt); err != nil {
			return err
		}
		switch n.Type {
		case "doc":
			if _, err := tx.Exec(`INSERT INTO doc_contents(node_id, markdown, updated_at) VALUES(?,?,?)`, n.ID, in.Markdown, n.UpdatedAt); err != nil {
				return err
			}
			if err := indexDoc(tx, n.ID, n.Title, in.Markdown, n.CreatedAt); err != nil {
				return err
			}
		case "table":
			if err := initTable(tx, n.ID, n.CreatedAt); err != nil {
				return err
			}
			// tables are found by title in search
			if _, err := tx.Exec(`INSERT INTO docs_fts(node_id, title, body) VALUES(?,?,'')`, n.ID, n.Title); err != nil {
				return err
			}
		}
		return touchRepo(tx, n.RepoID, n.UpdatedAt)
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, n)
}

// touchRepo marks a repo as changed at t.
func touchRepo(tx *sql.Tx, repoID string, t int64) error {
	_, err := tx.Exec(`UPDATE repos SET updated_at = ? WHERE id = ?`, t, repoID)
	return err
}

func (s *Server) updateNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var in struct {
		Title *string `json:"title"`
	}
	if err := readJSON(r, &in); err != nil || in.Title == nil {
		httpError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	title := strings.TrimSpace(*in.Title)
	var n *Node
	err := s.withTx(func(tx *sql.Tx) error {
		var err error
		if n, err = s.loadNode(tx, id); err != nil {
			return errStatus(http.StatusNotFound, "节点不存在")
		}
		if err := renameLinks(tx, id, n.Type, n.Title, title); err != nil {
			return err
		}
		n.Title, n.UpdatedAt = title, now()
		if _, err := tx.Exec(`UPDATE nodes SET title = ?, updated_at = ? WHERE id = ?`, n.Title, n.UpdatedAt, id); err != nil {
			return err
		}
		_, err = tx.Exec(`UPDATE docs_fts SET title = ? WHERE node_id = ?`, n.Title, id)
		return err
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

// moveNode places a node under parent_id (null = root) with the given sort key.
// The client computes sort as the midpoint of its new neighbours.
func (s *Server) moveNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var in struct {
		ParentID *string `json:"parent_id"`
		Sort     float64 `json:"sort"`
	}
	if err := readJSON(r, &in); err != nil {
		httpError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if in.ParentID != nil && *in.ParentID == "" {
		in.ParentID = nil
	}
	err := s.withTx(func(tx *sql.Tx) error {
		n, err := s.loadNode(tx, id)
		if err != nil {
			return errStatus(http.StatusNotFound, "节点不存在")
		}
		if in.ParentID != nil {
			p, err := s.loadNode(tx, *in.ParentID)
			if err != nil || p.RepoID != n.RepoID {
				return errStatus(http.StatusBadRequest, "目标位置不存在")
			}
			// walk up from the new parent; hitting the node itself means a cycle
			for cur := p; cur != nil; {
				if cur.ID == n.ID {
					return errStatus(http.StatusBadRequest, "不能移动到自身的子节点下")
				}
				if cur.ParentID == nil {
					break
				}
				if cur, err = s.loadNode(tx, *cur.ParentID); err != nil {
					break
				}
			}
		}
		_, err = tx.Exec(`UPDATE nodes SET parent_id = ?, sort = ? WHERE id = ?`, in.ParentID, in.Sort, id)
		return err
	})
	if err != nil {
		writeError(w, err)
		return
	}
	ok(w)
}

// descendantIDs returns id plus all descendants (including already-deleted ones when all=true).
func descendantIDs(tx *sql.Tx, id string, onlyAlive bool) ([]string, error) {
	q := `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id`
	if onlyAlive {
		q += ` WHERE n.deleted_at IS NULL`
	}
	q += `) SELECT id FROM sub`
	rows, err := tx.Query(q, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var x string
		if err := rows.Scan(&x); err != nil {
			return nil, err
		}
		ids = append(ids, x)
	}
	return ids, rows.Err()
}

func (s *Server) deleteNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := s.withTx(func(tx *sql.Tx) error {
		if _, err := s.loadNode(tx, id); errors.Is(err, sql.ErrNoRows) {
			return errStatus(http.StatusNotFound, "节点不存在")
		} else if err != nil {
			return err
		}
		ids, err := descendantIDs(tx, id, true)
		if err != nil {
			return err
		}
		t := now()
		for _, x := range ids {
			if _, err := tx.Exec(`UPDATE nodes SET deleted_at = ?, trash_root = ? WHERE id = ?`, t, boolInt(x == id), x); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		writeError(w, err)
		return
	}
	ok(w)
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
