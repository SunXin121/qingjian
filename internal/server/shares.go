package server

import (
	"crypto/hmac"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	shareCookie       = "qj_sh"
	shareCookieMaxAge = 7 * 24 * time.Hour
)

// Share is a read-only public link to a single document or table, a folder (group node,
// with everything below it) or a whole repo.
type Share struct {
	Token       string  `json:"token"`
	TargetType  string  `json:"target_type"` // node | repo
	TargetID    string  `json:"target_id"`
	ViewID      *string `json:"view_id"`
	HasPassword bool    `json:"has_password"`
	ExpiresAt   *int64  `json:"expires_at"`
	Enabled     bool    `json:"enabled"`
	ViewCount   int64   `json:"view_count"`
	CreatedAt   int64   `json:"created_at"`
	UpdatedAt   int64   `json:"updated_at"`

	// resolved from the target
	Title       string `json:"title"`
	NodeType    string `json:"node_type"`
	RepoID      string `json:"repo_id"`
	RepoName    string `json:"repo_name"`
	TargetAlive bool   `json:"target_alive"`

	passwordHash string
}

func (sh *Share) expired() bool {
	return sh.ExpiresAt != nil && *sh.ExpiresAt <= now()
}

const shareSelect = `SELECT s.token, s.target_type, s.target_id, s.view_id, COALESCE(n.type, ''), s.password_hash, s.expires_at, s.enabled, s.view_count, s.created_at, s.updated_at,
  COALESCE(n.title, r.name, ''), COALESCE(n.repo_id, r.id, ''), COALESCE(nr.name, r.name, ''),
  CASE WHEN s.target_type = 'node'
    THEN n.id IS NOT NULL AND n.deleted_at IS NULL AND nr.deleted_at IS NULL
    ELSE r.id IS NOT NULL AND r.deleted_at IS NULL END
FROM shares s
LEFT JOIN nodes n ON s.target_type = 'node' AND n.id = s.target_id
LEFT JOIN repos nr ON nr.id = n.repo_id
LEFT JOIN repos r ON s.target_type = 'repo' AND r.id = s.target_id`

type rowScanner interface{ Scan(...any) error }

func scanShare(row rowScanner) (*Share, error) {
	var sh Share
	var enabled, alive int
	err := row.Scan(&sh.Token, &sh.TargetType, &sh.TargetID, &sh.ViewID, &sh.NodeType, &sh.passwordHash, &sh.ExpiresAt, &enabled, &sh.ViewCount,
		&sh.CreatedAt, &sh.UpdatedAt, &sh.Title, &sh.RepoID, &sh.RepoName, &alive)
	if err != nil {
		return nil, err
	}
	sh.Enabled, sh.TargetAlive, sh.HasPassword = enabled == 1, alive == 1, sh.passwordHash != ""
	return &sh, nil
}

func (s *Server) loadShare(token string) (*Share, error) {
	return scanShare(s.db.QueryRow(shareSelect+` WHERE s.token = ?`, token))
}

// ---------- admin API ----------

func (s *Server) listShares(w http.ResponseWriter, r *http.Request) {
	q := shareSelect
	var args []any
	if tt, tid := r.URL.Query().Get("target_type"), r.URL.Query().Get("target_id"); tt != "" && tid != "" {
		q += ` WHERE s.target_type = ? AND s.target_id = ?`
		args = append(args, tt, tid)
	}
	rows, err := s.db.Query(q+` ORDER BY s.created_at DESC`, args...)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	out := []*Share{}
	for rows.Next() {
		sh, err := scanShare(rows)
		if err != nil {
			httpError(w, 500, err.Error())
			return
		}
		out = append(out, sh)
	}
	writeJSON(w, 200, out)
}

func (s *Server) createShare(w http.ResponseWriter, r *http.Request) {
	var in struct {
		TargetType string  `json:"target_type"`
		TargetID   string  `json:"target_id"`
		Password   string  `json:"password"`
		ExpiresAt  *int64  `json:"expires_at"`
		ViewID     *string `json:"view_id"`
	}
	if err := readJSON(r, &in); err != nil {
		httpError(w, 400, "请求格式错误")
		return
	}
	switch in.TargetType {
	case "node":
		n, err := s.loadNode(s.db, in.TargetID)
		if err != nil {
			httpError(w, 404, "文档不存在")
			return
		}
		if !nodeTypes[n.Type] {
			httpError(w, 400, "只能分享文档、多维表格、分组或知识库")
			return
		}
		if in.ViewID != nil && (*in.ViewID == "" || n.Type != "table") {
			in.ViewID = nil
		}
	case "repo":
		if _, err := s.loadRepo(in.TargetID); err != nil {
			httpError(w, 404, "知识库不存在")
			return
		}
	default:
		httpError(w, 400, "不支持的分享类型")
		return
	}
	hash := ""
	if in.Password != "" {
		h, err := hashPassword(in.Password)
		if err != nil {
			httpError(w, 500, err.Error())
			return
		}
		hash = h
	}
	t := now()
	token := randString(22)
	if in.TargetType != "node" {
		in.ViewID = nil
	}
	if _, err := s.db.Exec(`INSERT INTO shares(token, target_type, target_id, view_id, password_hash, expires_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)`,
		token, in.TargetType, in.TargetID, in.ViewID, hash, in.ExpiresAt, t, t); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	sh, err := s.loadShare(token)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, 201, sh)
}

// updateShare accepts any subset of {password, expires_at, enabled, view_id}.
// password "" removes the password; expires_at null makes the link permanent.
func (s *Server) updateShare(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	var in map[string]json.RawMessage
	if err := readJSON(r, &in); err != nil {
		httpError(w, 400, "请求格式错误")
		return
	}
	if _, err := s.loadShare(token); err != nil {
		httpError(w, 404, "分享不存在")
		return
	}
	sets := []string{}
	args := []any{}
	if raw, ok := in["password"]; ok {
		var pw string
		if json.Unmarshal(raw, &pw) != nil {
			httpError(w, 400, "密码格式错误")
			return
		}
		hash := ""
		if pw != "" {
			h, err := hashPassword(pw)
			if err != nil {
				httpError(w, 500, err.Error())
				return
			}
			hash = h
		}
		sets, args = append(sets, "password_hash = ?"), append(args, hash)
	}
	if raw, ok := in["expires_at"]; ok {
		var exp *int64
		if json.Unmarshal(raw, &exp) != nil {
			httpError(w, 400, "有效期格式错误")
			return
		}
		sets, args = append(sets, "expires_at = ?"), append(args, exp)
	}
	if raw, ok := in["view_id"]; ok {
		var v *string
		if json.Unmarshal(raw, &v) != nil {
			httpError(w, 400, "请求格式错误")
			return
		}
		if v != nil && *v == "" {
			v = nil
		}
		sets, args = append(sets, "view_id = ?"), append(args, v)
	}
	if raw, ok := in["enabled"]; ok {
		var en bool
		if json.Unmarshal(raw, &en) != nil {
			httpError(w, 400, "请求格式错误")
			return
		}
		sets, args = append(sets, "enabled = ?"), append(args, boolInt(en))
	}
	if len(sets) > 0 {
		sets, args = append(sets, "updated_at = ?"), append(args, now())
		if _, err := s.db.Exec(`UPDATE shares SET `+strings.Join(sets, ", ")+` WHERE token = ?`, append(args, token)...); err != nil {
			httpError(w, 500, err.Error())
			return
		}
	}
	sh, err := s.loadShare(token)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, sh)
}

// regenerateShare swaps the token, which invalidates the old link (and visitor cookies).
func (s *Server) regenerateShare(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	next := randString(22)
	res, err := s.db.Exec(`UPDATE shares SET token = ?, updated_at = ? WHERE token = ?`, next, now(), token)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpError(w, 404, "分享不存在")
		return
	}
	sh, err := s.loadShare(next)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, sh)
}

func (s *Server) deleteShare(w http.ResponseWriter, r *http.Request) {
	if _, err := s.db.Exec(`DELETE FROM shares WHERE token = ?`, r.PathValue("token")); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	ok(w)
}

// ---------- public (visitor) API ----------

// activeShare resolves a token for visitors. It writes the error response itself and
// returns nil when the link is unusable or a password is still required.
func (s *Server) activeShare(w http.ResponseWriter, r *http.Request, requireAuth bool) *Share {
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	sh, err := s.loadShare(r.PathValue("token"))
	if err != nil || !sh.Enabled || !sh.TargetAlive {
		httpError(w, 404, "链接不存在或已被关闭")
		return nil
	}
	if sh.expired() {
		httpError(w, 410, "分享链接已过期")
		return nil
	}
	if requireAuth && !s.shareAuthorized(r, sh) {
		writeJSON(w, 401, map[string]any{"error": "需要访问密码", "need_password": true})
		return nil
	}
	return sh
}

func (s *Server) shareSig(sh *Share, exp string) string {
	return s.sign("share|" + sh.Token + "|" + sh.passwordHash + "|" + exp)
}

func (s *Server) shareAuthorized(r *http.Request, sh *Share) bool {
	if !sh.HasPassword || s.isAdmin(r) {
		return true
	}
	c, err := r.Cookie(shareCookie)
	if err != nil {
		return false
	}
	exp, sig, found := strings.Cut(c.Value, ".")
	if !found || !hmac.Equal([]byte(sig), []byte(s.shareSig(sh, exp))) {
		return false
	}
	t, err := strconv.ParseInt(exp, 10, 64)
	return err == nil && time.Now().Unix() < t
}

func (s *Server) shareAuth(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		httpError(w, http.StatusForbidden, "跨站请求被拒绝")
		return
	}
	sh := s.activeShare(w, r, false)
	if sh == nil {
		return
	}
	ip := "share:" + s.clientIP(r)
	if blocked, d := s.limiter.blocked(ip); blocked {
		httpError(w, http.StatusTooManyRequests, fmt.Sprintf("尝试次数过多，请 %d 分钟后再试", int(d.Minutes())+1))
		return
	}
	var in struct {
		Password string `json:"password"`
	}
	if err := readJSON(r, &in); err != nil {
		httpError(w, 400, "请求格式错误")
		return
	}
	if sh.HasPassword && !verifyHash(in.Password, sh.passwordHash) {
		s.limiter.fail(ip)
		time.Sleep(400 * time.Millisecond)
		httpError(w, 401, "密码错误")
		return
	}
	s.limiter.reset(ip)
	exp := time.Now().Add(shareCookieMaxAge)
	if sh.ExpiresAt != nil && time.UnixMilli(*sh.ExpiresAt).Before(exp) {
		exp = time.UnixMilli(*sh.ExpiresAt)
	}
	payload := strconv.FormatInt(exp.Unix(), 10)
	http.SetCookie(w, &http.Cookie{
		Name:     shareCookie,
		Value:    payload + "." + s.shareSig(sh, payload),
		Path:     "/api/s/" + sh.Token,
		Expires:  exp,
		HttpOnly: true,
		Secure:   s.isSecure(r),
		SameSite: http.SameSiteLaxMode,
	})
	ok(w)
}

type publicNode struct {
	ID        string  `json:"id"`
	ParentID  *string `json:"parent_id"`
	Type      string  `json:"type"`
	Title     string  `json:"title"`
	Sort      float64 `json:"sort"`
	UpdatedAt int64   `json:"updated_at"`
}

func (s *Server) shareInfo(w http.ResponseWriter, r *http.Request) {
	sh := s.activeShare(w, r, true)
	if sh == nil {
		return
	}
	s.db.Exec(`UPDATE shares SET view_count = view_count + 1 WHERE token = ?`, sh.Token)
	out := map[string]any{"token": sh.Token, "type": sh.TargetType, "title": sh.Title, "expires_at": sh.ExpiresAt}
	if sh.TargetType == "repo" {
		repo, err := s.loadRepo(sh.TargetID)
		if err != nil {
			httpError(w, 404, "知识库不存在")
			return
		}
		out["repo"] = map[string]any{"name": repo.Name, "description": repo.Description, "updated_at": repo.UpdatedAt}
	} else if sh.NodeType == "group" {
		out["node_type"] = sh.NodeType
	} else {
		out["doc_id"] = sh.TargetID
		out["node_type"] = sh.NodeType
	}
	writeJSON(w, 200, out)
}

func (s *Server) shareTree(w http.ResponseWriter, r *http.Request) {
	sh := s.activeShare(w, r, true)
	if sh == nil {
		return
	}
	folder := sh.TargetType == "node" && sh.NodeType == "group"
	if sh.TargetType != "repo" && !folder {
		httpError(w, 404, "not found")
		return
	}
	nodes, err := s.treeNodes(sh.RepoID)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	if folder {
		nodes = subtree(nodes, sh.TargetID)
	}
	out := make([]publicNode, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, publicNode{n.ID, n.ParentID, n.Type, n.Title, n.Sort, n.UpdatedAt})
	}
	writeJSON(w, 200, out)
}

// subtree keeps the nodes below root (in their order), with root's children made
// top-level: a shared folder shows as a tree of its own.
func subtree(nodes []Node, root string) []Node {
	kids := map[string][]int{}
	for i, n := range nodes {
		if n.ParentID != nil {
			kids[*n.ParentID] = append(kids[*n.ParentID], i)
		}
	}
	keep := map[int]bool{}
	var walk func(id string)
	walk = func(id string) {
		for _, i := range kids[id] {
			keep[i] = true
			walk(nodes[i].ID)
		}
	}
	walk(root)
	out := make([]Node, 0, len(keep))
	for i, n := range nodes {
		if !keep[i] {
			continue
		}
		if *n.ParentID == root {
			n.ParentID = nil
		}
		out = append(out, n)
	}
	return out
}

// shareScope is an SQL condition on `n` (a nodes row) selecting the nodes the share
// exposes: the shared node, everything below a shared folder, or a shared repo's nodes.
func shareScope(sh *Share) (string, []any) {
	switch {
	case sh.TargetType == "repo":
		return `n.repo_id = ?`, []any{sh.TargetID}
	case sh.NodeType == "group":
		return `n.id IN (WITH RECURSIVE sub(id) AS (
  SELECT id FROM nodes WHERE parent_id = ? AND deleted_at IS NULL
  UNION ALL SELECT x.id FROM nodes x JOIN sub ON x.parent_id = sub.id WHERE x.deleted_at IS NULL
) SELECT id FROM sub)`, []any{sh.TargetID}
	default:
		return `n.id = ?`, []any{sh.TargetID}
	}
}

// shareCovers reports whether the node is alive and visible through the share.
func (s *Server) shareCovers(sh *Share, id string) bool {
	cond, args := shareScope(sh)
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM nodes n WHERE n.id = ? AND n.deleted_at IS NULL AND `+cond, append([]any{id}, args...)...).Scan(&n)
	return err == nil && n > 0
}

func (s *Server) shareDoc(w http.ResponseWriter, r *http.Request) {
	sh := s.activeShare(w, r, true)
	if sh == nil {
		return
	}
	id := r.PathValue("id")
	d, err := s.loadDoc(id)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !s.shareCovers(sh, d.ID)) {
		httpError(w, 404, "文档不存在")
		return
	} else if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"id": d.ID, "title": d.Title, "markdown": d.Markdown, "updated_at": d.ContentUpdatedAt})
}

// shareTable serves a table visible through the share: the shared table itself, any
// table of a shared repo or folder, or a table embedded in a shared document.
func (s *Server) shareTable(w http.ResponseWriter, r *http.Request) {
	sh := s.activeShare(w, r, true)
	if sh == nil {
		return
	}
	id := r.PathValue("id")
	t, err := s.loadTableData(s.db, id)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !s.shareCoversTable(sh, &t.Node)) {
		httpError(w, 404, "表格不存在")
		return
	} else if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	// a link to one view of the table exposes only that view
	if sh.TargetType == "node" && sh.TargetID == id && sh.ViewID != nil {
		for _, v := range t.Views {
			if v.ID == *sh.ViewID {
				t.Views = []View{v}
				break
			}
		}
		if len(t.Views) > 1 {
			t.Views = t.Views[:1]
		}
	}
	out := map[string]any{"id": t.ID, "title": t.Title, "updated_at": t.UpdatedAt,
		"fields": t.Fields, "views": t.Views, "records": t.Records}
	// linked tables: only the fields and records the computed fields read
	if linked := s.linkedTables(s.db, t); len(linked) > 0 {
		trimLinked(t, linked)
		lite := map[string]any{}
		for id, lt := range linked {
			lite[id] = map[string]any{"id": lt.ID, "title": lt.Title, "updated_at": lt.UpdatedAt,
				"fields": lt.Fields, "views": []View{}, "records": lt.Records}
		}
		out["linked"] = lite
	}
	writeJSON(w, 200, out)
}

func (s *Server) shareCoversTable(sh *Share, n *Node) bool {
	if s.shareCovers(sh, n.ID) {
		return true
	}
	// embedded in a document the share exposes
	cond, args := shareScope(sh)
	rows, err := s.db.Query(`SELECT d.markdown FROM doc_contents d JOIN nodes n ON n.id = d.node_id
WHERE n.deleted_at IS NULL AND d.markdown LIKE ? AND `+cond, append([]any{"%" + n.ID + "%"}, args...)...)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var md string
		rows.Scan(&md)
		for _, ref := range embeddedTables(md) {
			if ref.Table == n.ID {
				return true
			}
		}
	}
	return false
}
