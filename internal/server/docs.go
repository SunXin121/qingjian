package server

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

const (
	versionInterval = 10 * 60 * 1000 // ms between automatic snapshots
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
		httpError(w, 404, "文档不存在")
		return
	} else if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, d)
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
		httpError(w, 400, "请求格式错误")
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer tx.Rollback()
	n, err := s.loadNode(tx, id)
	if err != nil || n.Type != "doc" {
		httpError(w, 404, "文档不存在")
		return
	}
	var md string
	var contentUpdated int64
	if err := tx.QueryRow(`SELECT markdown, updated_at FROM doc_contents WHERE node_id = ?`, id).Scan(&md, &contentUpdated); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	if in.BaseUpdatedAt != nil && *in.BaseUpdatedAt != contentUpdated && !in.Force {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "文档已在其他地方被修改", "updated_at": contentUpdated})
		return
	}
	t := now()
	if t <= contentUpdated {
		t = contentUpdated + 1 // keep updated_at strictly increasing for conflict detection
	}
	if in.Title != nil {
		n.Title = strings.TrimSpace(*in.Title)
	}
	if in.Markdown != nil {
		md = *in.Markdown
	}
	n.UpdatedAt = t
	if _, err := tx.Exec(`UPDATE nodes SET title = ?, updated_at = ? WHERE id = ?`, n.Title, t, id); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	if _, err := tx.Exec(`UPDATE doc_contents SET markdown = ?, updated_at = ? WHERE node_id = ?`, md, t, id); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	tx.Exec(`DELETE FROM docs_fts WHERE node_id = ?`, id)
	tx.Exec(`INSERT INTO docs_fts(node_id, title, body) VALUES(?,?,?)`, id, n.Title, searchableText(md))
	tx.Exec(`UPDATE repos SET updated_at = ? WHERE id = ?`, t, n.RepoID)

	// snapshot
	var lastAt int64
	var lastMD string
	verr := tx.QueryRow(`SELECT created_at, markdown FROM doc_versions WHERE node_id = ? ORDER BY id DESC LIMIT 1`, id).Scan(&lastAt, &lastMD)
	if (in.Snapshot || errors.Is(verr, sql.ErrNoRows) || t-lastAt >= versionInterval) && lastMD != md {
		tx.Exec(`INSERT INTO doc_versions(node_id, title, markdown, created_at) VALUES(?,?,?,?)`, id, n.Title, md, t)
		tx.Exec(`DELETE FROM doc_versions WHERE node_id = ? AND id NOT IN (SELECT id FROM doc_versions WHERE node_id = ? ORDER BY id DESC LIMIT ?)`, id, id, maxVersions)
	}
	if err := tx.Commit(); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"updated_at": t, "title": n.Title})
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
	rows, err := s.db.Query(`SELECT id, node_id, title, length(markdown), created_at FROM doc_versions WHERE node_id = ? ORDER BY id DESC`, r.PathValue("id"))
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	out := []Version{}
	for rows.Next() {
		var v Version
		rows.Scan(&v.ID, &v.NodeID, &v.Title, &v.Size, &v.CreatedAt)
		out = append(out, v)
	}
	writeJSON(w, 200, out)
}

func (s *Server) loadVersion(r *http.Request) (*Version, error) {
	vid, err := strconv.ParseInt(r.PathValue("vid"), 10, 64)
	if err != nil {
		return nil, sql.ErrNoRows
	}
	var v Version
	err = s.db.QueryRow(`SELECT id, node_id, title, markdown, created_at FROM doc_versions WHERE id = ?`, vid).
		Scan(&v.ID, &v.NodeID, &v.Title, &v.Markdown, &v.CreatedAt)
	v.Size = len(v.Markdown)
	return &v, err
}

func (s *Server) getVersion(w http.ResponseWriter, r *http.Request) {
	v, err := s.loadVersion(r)
	if err != nil {
		httpError(w, 404, "版本不存在")
		return
	}
	writeJSON(w, 200, v)
}

func (s *Server) restoreVersion(w http.ResponseWriter, r *http.Request) {
	v, err := s.loadVersion(r)
	if err != nil {
		httpError(w, 404, "版本不存在")
		return
	}
	d, err := s.loadDoc(v.NodeID)
	if err != nil {
		httpError(w, 404, "文档不存在")
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer tx.Rollback()
	t := now()
	if t <= d.ContentUpdatedAt {
		t = d.ContentUpdatedAt + 1
	}
	// snapshot the current content first so the restore itself is undoable
	tx.Exec(`INSERT INTO doc_versions(node_id, title, markdown, created_at) VALUES(?,?,?,?)`, d.ID, d.Title, d.Markdown, t-1)
	tx.Exec(`UPDATE nodes SET title = ?, updated_at = ? WHERE id = ?`, v.Title, t, d.ID)
	tx.Exec(`UPDATE doc_contents SET markdown = ?, updated_at = ? WHERE node_id = ?`, v.Markdown, t, d.ID)
	tx.Exec(`DELETE FROM docs_fts WHERE node_id = ?`, d.ID)
	tx.Exec(`INSERT INTO docs_fts(node_id, title, body) VALUES(?,?,?)`, d.ID, v.Title, searchableText(v.Markdown))
	tx.Exec(`INSERT INTO doc_versions(node_id, title, markdown, created_at) VALUES(?,?,?,?)`, d.ID, v.Title, v.Markdown, t)
	if err := tx.Commit(); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"updated_at": t})
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
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	out := []RecentDoc{}
	for rows.Next() {
		var d RecentDoc
		rows.Scan(&d.ID, &d.RepoID, &d.RepoName, &d.Title, &d.Type, &d.UpdatedAt)
		out = append(out, d)
	}
	writeJSON(w, 200, out)
}
