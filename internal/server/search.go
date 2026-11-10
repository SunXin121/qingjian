package server

import (
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

var (
	reDrawingBlock = regexp.MustCompile("(?s)```(?:excalidraw|drawio|mindmap|table)\\n.*?\\n```")
	reMdURL        = regexp.MustCompile(`\]\([^)]*\)`)
)

// searchableText strips parts of markdown that only add noise to the full-text index.
func searchableText(md string) string {
	md = reDrawingBlock.ReplaceAllString(md, " ")
	md = reMdURL.ReplaceAllString(md, "]")
	return md
}

type SearchHit struct {
	ID        string `json:"id"`
	RepoID    string `json:"repo_id"`
	RepoName  string `json:"repo_name"`
	Title     string `json:"title"`
	Type      string `json:"type"`
	Snippet   string `json:"snippet"`
	UpdatedAt int64  `json:"updated_at"`
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	out := []SearchHit{}
	if q == "" {
		writeJSON(w, 200, out)
		return
	}
	if len(q) > 200 {
		q = q[:200]
	}
	var hits []SearchHit
	var err error
	// trigram tokenizer needs >= 3 characters per term; fall back to LIKE for short queries
	if minTermLen(q) >= 3 {
		hits, err = s.searchFTS(q)
	} else {
		hits, err = s.searchLike(q)
	}
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	if hits != nil {
		out = hits
	}
	writeJSON(w, 200, out)
}

func minTermLen(q string) int {
	min := 1 << 30
	for _, t := range strings.Fields(q) {
		if n := utf8.RuneCountInString(t); n < min {
			min = n
		}
	}
	return min
}

const searchJoin = ` JOIN nodes n ON n.id = f.node_id JOIN repos r ON r.id = n.repo_id
WHERE n.deleted_at IS NULL AND r.deleted_at IS NULL`

func (s *Server) searchFTS(q string) ([]SearchHit, error) {
	var terms []string
	for _, t := range strings.Fields(q) {
		terms = append(terms, `"`+strings.ReplaceAll(t, `"`, `""`)+`"`)
	}
	rows, err := s.db.Query(`SELECT n.id, n.repo_id, r.name, n.title, n.type,
  snippet(docs_fts, 2, char(1), char(2), '…', 24), n.updated_at
FROM docs_fts f`+searchJoin+` AND docs_fts MATCH ? ORDER BY bm25(docs_fts, 0, 8, 1) LIMIT 50`, strings.Join(terms, " "))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SearchHit
	for rows.Next() {
		var h SearchHit
		rows.Scan(&h.ID, &h.RepoID, &h.RepoName, &h.Title, &h.Type, &h.Snippet, &h.UpdatedAt)
		out = append(out, h)
	}
	return out, rows.Err()
}

func (s *Server) searchLike(q string) ([]SearchHit, error) {
	terms := strings.Fields(q)
	where := ""
	args := []any{}
	for _, t := range terms {
		esc := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(t)
		where += ` AND (f.title LIKE ? ESCAPE '\' OR f.body LIKE ? ESCAPE '\')`
		args = append(args, "%"+esc+"%", "%"+esc+"%")
	}
	rows, err := s.db.Query(`SELECT n.id, n.repo_id, r.name, n.title, n.type, f.body, n.updated_at FROM docs_fts f`+searchJoin+where+
		` ORDER BY (f.title LIKE ? ESCAPE '\') DESC, n.updated_at DESC LIMIT 50`, append(args, args[0])...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SearchHit
	for rows.Next() {
		var h SearchHit
		var body string
		rows.Scan(&h.ID, &h.RepoID, &h.RepoName, &h.Title, &h.Type, &body, &h.UpdatedAt)
		h.Snippet = makeSnippet(body, terms[0])
		out = append(out, h)
	}
	return out, rows.Err()
}

// makeSnippet mirrors FTS5 snippet(): highlights are wrapped in \x01 ... \x02.
func makeSnippet(body, term string) string {
	body = strings.Join(strings.Fields(body), " ")
	idx := strings.Index(strings.ToLower(body), strings.ToLower(term))
	if idx < 0 {
		r := []rune(body)
		if len(r) > 60 {
			return string(r[:60]) + "…"
		}
		return body
	}
	before := []rune(body[:idx])
	after := []rune(body[idx+len(term):])
	prefix := ""
	if len(before) > 24 {
		before, prefix = before[len(before)-24:], "…"
	}
	suffix := ""
	if len(after) > 40 {
		after, suffix = after[:40], "…"
	}
	return prefix + string(before) + "\x01" + body[idx:idx+len(term)] + "\x02" + string(after) + suffix
}
