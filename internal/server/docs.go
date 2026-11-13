package server

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	versionInterval = 60 * 1000 // ms between automatic snapshots
	maxVersions     = 300
)

type Doc struct {
	Node
	Markdown         string `json:"markdown"`
	ContentUpdatedAt int64  `json:"content_updated_at"`
}

func (s *Server) loadDoc(id string) (*Doc, error) {
	n, err := s.loadNode(s.db, id)
	if err != nil {
		return nil, err
	}
	if n.Type != "doc" {
		return nil, sql.ErrNoRows
	}
	d := &Doc{Node: *n}
	err = s.db.QueryRow(`SELECT markdown, updated_at FROM doc_contents WHERE node_id = ?`, id).Scan(&d.Markdown, &d.ContentUpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return d, err
}

func (s *Server) getDoc(w http.ResponseWriter, r *http.Request) {
	d, err := s.loadDoc(r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		httpError(w, http.StatusNotFound, "文档不存在")
		return
	} else if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// saveDoc stores markdown (and optionally title). If base_updated_at is given and does not
// match the stored value, it returns 409 unless force is set — protects against editing
// the same document from two tabs.
func (s *Server) saveDoc(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var in struct {
		Markdown      *string `json:"markdown"`
		Title         *string `json:"title"`
		BaseUpdatedAt *int64  `json:"base_updated_at"`
		Force         bool    `json:"force"`
		Snapshot      bool    `json:"snapshot"`
	}
	if err := readJSON(r, &in); err != nil {
		httpError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	errConflict := errors.New("conflict")
	var n *Node
	var t, conflictAt int64
	err := s.withTx(func(tx *sql.Tx) error {
		var err error
		if n, err = s.loadNode(tx, id); err != nil || n.Type != "doc" {
			return errStatus(http.StatusNotFound, "文档不存在")
		}
		var md string
		var contentUpdated int64
		if err := tx.QueryRow(`SELECT markdown, updated_at FROM doc_contents WHERE node_id = ?`, id).Scan(&md, &contentUpdated); err != nil {
			return err
		}
		if in.BaseUpdatedAt != nil && *in.BaseUpdatedAt != contentUpdated && !in.Force {
			conflictAt = contentUpdated
			return errConflict
		}
		t = now()
		if t <= contentUpdated {
			t = contentUpdated + 1 // keep updated_at strictly increasing for conflict detection
		}
		oldTitle := n.Title
		if in.Title != nil {
			n.Title = strings.TrimSpace(*in.Title)
		}
		if in.Markdown != nil {
			md = *in.Markdown
		}
		if err := renameLinks(tx, id, n.Type, oldTitle, n.Title); err != nil {
			return err
		}
		n.UpdatedAt = t
		if _, err := tx.Exec(`UPDATE nodes SET title = ?, updated_at = ? WHERE id = ?`, n.Title, t, id); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE doc_contents SET markdown = ?, updated_at = ? WHERE node_id = ?`, md, t, id); err != nil {
			return err
		}
		if err := indexDoc(tx, id, n.Title, md, t); err != nil {
			return err
		}
		if err := touchRepo(tx, n.RepoID, t); err != nil {
			return err
		}
		// snapshot: only rebuild / compare content when one is due
		_, lastAt, _, verr := latestVersion(tx, id)
		if verr != nil && !errors.Is(verr, sql.ErrNoRows) {
			return verr
		}
		if in.Snapshot || errors.Is(verr, sql.ErrNoRows) || t-lastAt >= versionInterval {
			same, err := sameAsLatest(tx, id, md)
			if err == nil && !same {
				err = addVersion(tx, id, n.Title, md, t)
			}
			return err
		}
		return nil
	})
	if errors.Is(err, errConflict) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "文档已在其他地方被修改", "updated_at": conflictAt})
		return
	} else if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"updated_at": t, "title": n.Title})
}

type Version struct {
	ID        int64  `json:"id"`
	NodeID    string `json:"node_id"`
	Title     string `json:"title"`
	Markdown  string `json:"markdown,omitempty"`
	Size      int    `json:"size"`
	CreatedAt int64  `json:"created_at"`
}

func (s *Server) listVersions(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(`SELECT id, node_id, title, size, created_at FROM doc_versions WHERE node_id = ? ORDER BY id DESC`, r.PathValue("id"))
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	out := []Version{}
	for rows.Next() {
		var v Version
		if err := rows.Scan(&v.ID, &v.NodeID, &v.Title, &v.Size, &v.CreatedAt); err != nil {
			serverError(w, err)
			return
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) loadVersion(r *http.Request) (*Version, error) {
	vid, err := strconv.ParseInt(r.PathValue("vid"), 10, 64)
	if err != nil {
		return nil, sql.ErrNoRows
	}
	var v Version
	if err := s.db.QueryRow(`SELECT id, node_id, title, created_at FROM doc_versions WHERE id = ?`, vid).
		Scan(&v.ID, &v.NodeID, &v.Title, &v.CreatedAt); err != nil {
		return nil, err
	}
	if v.Markdown, err = versionText(s.db, vid); err != nil {
		return nil, err
	}
	v.Size = utf8.RuneCountInString(v.Markdown)
	return &v, nil
}

func (s *Server) getVersion(w http.ResponseWriter, r *http.Request) {
	v, err := s.loadVersion(r)
	if err != nil {
		httpError(w, http.StatusNotFound, "版本不存在")
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) restoreVersion(w http.ResponseWriter, r *http.Request) {
	v, err := s.loadVersion(r)
	if err != nil {
		httpError(w, http.StatusNotFound, "版本不存在")
		return
	}
	d, err := s.loadDoc(v.NodeID)
	if err != nil {
		httpError(w, http.StatusNotFound, "文档不存在")
		return
	}
	t := now()
	if t <= d.ContentUpdatedAt {
		t = d.ContentUpdatedAt + 1
	}
	err = s.withTx(func(tx *sql.Tx) error {
		// snapshot the current content first so the restore itself is undoable
		if err := addVersion(tx, d.ID, d.Title, d.Markdown, t-1); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE nodes SET title = ?, updated_at = ? WHERE id = ?`, v.Title, t, d.ID); err != nil {
			return err
		}
		if err := renameLinks(tx, d.ID, "doc", d.Title, v.Title); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE doc_contents SET markdown = ?, updated_at = ? WHERE node_id = ?`, v.Markdown, t, d.ID); err != nil {
			return err
		}
		if err := indexDoc(tx, d.ID, v.Title, v.Markdown, t); err != nil {
			return err
		}
		return addVersion(tx, d.ID, v.Title, v.Markdown, t)
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"updated_at": t})
}

type RecentDoc struct {
	ID        string `json:"id"`
	RepoID    string `json:"repo_id"`
	RepoName  string `json:"repo_name"`
	Title     string `json:"title"`
	Type      string `json:"type"`
	UpdatedAt int64  `json:"updated_at"`
}

func (s *Server) recentDocs(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(`SELECT n.id, n.repo_id, r.name, n.title, n.type, n.updated_at FROM nodes n JOIN repos r ON r.id = n.repo_id
WHERE n.type IN ('doc', 'table') AND n.deleted_at IS NULL AND r.deleted_at IS NULL ORDER BY n.updated_at DESC LIMIT 30`)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	out := []RecentDoc{}
	for rows.Next() {
		var d RecentDoc
		if err := rows.Scan(&d.ID, &d.RepoID, &d.RepoName, &d.Title, &d.Type, &d.UpdatedAt); err != nil {
			serverError(w, err)
			return
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
