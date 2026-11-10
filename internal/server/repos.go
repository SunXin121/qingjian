package server

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
)

type Repo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Icon        string `json:"icon"`
	Sort        float64 `json:"sort"`
	DocCount    int     `json:"doc_count"`
	CreatedAt   int64   `json:"created_at"`
	UpdatedAt   int64   `json:"updated_at"`
}

type Node struct {
	ID        string  `json:"id"`
	RepoID    string  `json:"repo_id"`
	ParentID  *string `json:"parent_id"`
	Type      string  `json:"type"`
	Title     string  `json:"title"`
	Sort      float64 `json:"sort"`
	CreatedAt int64   `json:"created_at"`
	UpdatedAt int64   `json:"updated_at"`
}

func (s *Server) listRepos(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(`
SELECT r.id, r.name, r.description, r.icon, r.sort, r.created_at, r.updated_at,
  (SELECT COUNT(*) FROM nodes n WHERE n.repo_id = r.id AND n.type = 'doc' AND n.deleted_at IS NULL)
FROM repos r WHERE r.deleted_at IS NULL ORDER BY r.sort, r.created_at`)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	out := []Repo{}
	for rows.Next() {
		var x Repo
		if err := rows.Scan(&x.ID, &x.Name, &x.Description, &x.Icon, &x.Sort, &x.CreatedAt, &x.UpdatedAt, &x.DocCount); err != nil {
			httpError(w, 500, err.Error())
			return
		}
		out = append(out, x)
	}
	writeJSON(w, 200, out)
}

func (s *Server) loadRepo(id string) (*Repo, error) {
	var x Repo
	err := s.db.QueryRow(`SELECT id, name, description, icon, sort, created_at, updated_at FROM repos WHERE id = ? AND deleted_at IS NULL`, id).
		Scan(&x.ID, &x.Name, &x.Description, &x.Icon, &x.Sort, &x.CreatedAt, &x.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &x, nil
}

func (s *Server) getRepo(w http.ResponseWriter, r *http.Request) {
	x, err := s.loadRepo(r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		httpError(w, 404, "知识库不存在")
		return
	} else if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, x)
}

type repoInput struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	Icon        *string `json:"icon"`
}

func (s *Server) createRepo(w http.ResponseWriter, r *http.Request) {
	var in repoInput
	if err := readJSON(r, &in); err != nil || in.Name == nil || strings.TrimSpace(*in.Name) == "" {
		httpError(w, 400, "请填写知识库名称")
		return
	}
	x := Repo{ID: newID(), Name: strings.TrimSpace(*in.Name), CreatedAt: now()}
	x.UpdatedAt = x.CreatedAt
	if in.Description != nil {
		x.Description = *in.Description
	}
	if in.Icon != nil {
		x.Icon = *in.Icon
	}
	s.db.QueryRow(`SELECT COALESCE(MAX(sort), 0) + 1 FROM repos`).Scan(&x.Sort)
	_, err := s.db.Exec(`INSERT INTO repos(id, name, description, icon, sort, created_at, updated_at) VALUES(?,?,?,?,?,?,?)`,
		x.ID, x.Name, x.Description, x.Icon, x.Sort, x.CreatedAt, x.UpdatedAt)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, 201, x)
}

func (s *Server) updateRepo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var in repoInput
	if err := readJSON(r, &in); err != nil {
		httpError(w, 400, "请求格式错误")
		return
	}
	x, err := s.loadRepo(id)
	if err != nil {
		httpError(w, 404, "知识库不存在")
		return
	}
	if in.Name != nil && strings.TrimSpace(*in.Name) != "" {
		x.Name = strings.TrimSpace(*in.Name)
	}
	if in.Description != nil {
		x.Description = *in.Description
	}
	if in.Icon != nil {
		x.Icon = *in.Icon
	}
	x.UpdatedAt = now()
	if _, err := s.db.Exec(`UPDATE repos SET name=?, description=?, icon=?, updated_at=? WHERE id=?`, x.Name, x.Description, x.Icon, x.UpdatedAt, id); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, x)
}

func (s *Server) deleteRepo(w http.ResponseWriter, r *http.Request) {
	res, err := s.db.Exec(`UPDATE repos SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, now(), r.PathValue("id"))
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpError(w, 404, "知识库不存在")
		return
	}
	ok(w)
}

func (s *Server) repoTree(w http.ResponseWriter, r *http.Request) {
	nodes, err := s.treeNodes(r.PathValue("id"))
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, nodes)
}

func (s *Server) treeNodes(repoID string) ([]Node, error) {
	rows, err := s.db.Query(`SELECT id, repo_id, parent_id, type, title, sort, created_at, updated_at FROM nodes
WHERE repo_id = ? AND deleted_at IS NULL ORDER BY sort, created_at`, repoID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Node{}
	for rows.Next() {
		var n Node
		if err := rows.Scan(&n.ID, &n.RepoID, &n.ParentID, &n.Type, &n.Title, &n.Sort, &n.CreatedAt, &n.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
