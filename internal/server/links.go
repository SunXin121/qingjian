package server

// Links between documents (双链). A link to another document or table is an ordinary
// markdown link to its page, /r/<repo>/d/<id> or /r/<repo>/t/<id> (relative, or absolute
// when pasted from the address bar). doc_links records them on every save so each page
// can list the documents linking to it (backlinks).

import (
	"database/sql"
	"log"
	"net/http"
	"regexp"
	"strings"
)

var (
	// the target of a markdown link to a node page; group 1 is the node id
	reNodeLink = regexp.MustCompile(`\]\(\s*<?(?:https?://[^/\s)<>]+)?/r/[0-9a-z]+/[dt]/([0-9a-z]+)[^)\s]*\)`)
	// [text](target) → text, for snippets
	reMdLink   = regexp.MustCompile(`!?\[([^\]]*)\]\([^)]*\)`)
	reLineMark = regexp.MustCompile(`^(?:\s*(?:>|[-*+]|\d+[.)]|#{1,6}|\[[ xX]\])\s+)+`)
)

// linkTargets returns the distinct node ids md links to.
func linkTargets(md string) []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range reNodeLink.FindAllStringSubmatch(md, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			out = append(out, m[1])
		}
	}
	return out
}

// updateLinks replaces the outgoing links recorded for document id.
func updateLinks(tx *sql.Tx, id, md string) error {
	if _, err := tx.Exec(`DELETE FROM doc_links WHERE src = ?`, id); err != nil {
		return err
	}
	for _, dst := range linkTargets(md) {
		if dst == id {
			continue
		}
		if _, err := tx.Exec(`INSERT INTO doc_links(src, dst) VALUES(?, ?)`, id, dst); err != nil {
			return err
		}
	}
	return nil
}

// backfillLinks records the links of documents saved before doc_links existed.
func (s *Server) backfillLinks() error {
	if v, _ := s.getSetting("links_indexed"); v == "1" {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT node_id, markdown FROM doc_contents`)
	if err != nil {
		return err
	}
	type doc struct{ id, md string }
	var docs []doc
	for rows.Next() {
		var d doc
		if err := rows.Scan(&d.id, &d.md); err != nil {
			rows.Close()
			return err
		}
		docs = append(docs, d)
	}
	rows.Close()
	for _, d := range docs {
		if err := updateLinks(tx, d.id, d.md); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`INSERT INTO settings(key, value) VALUES('links_indexed', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if len(docs) > 0 {
		log.Printf("links: indexed %d documents", len(docs))
	}
	return nil
}

type Backlink struct {
	ID        string `json:"id"`
	RepoID    string `json:"repo_id"`
	RepoName  string `json:"repo_name"`
	Title     string `json:"title"`
	UpdatedAt int64  `json:"updated_at"`
	// the text around the first link to the node
	Snippet string `json:"snippet"`
}

// backlinks lists the documents (not in the trash) linking to a node.
func (s *Server) backlinks(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	rows, err := s.db.Query(`SELECT n.id, n.repo_id, rp.name, n.title, n.updated_at, c.markdown
FROM doc_links l
JOIN nodes n ON n.id = l.src
JOIN repos rp ON rp.id = n.repo_id
JOIN doc_contents c ON c.node_id = n.id
WHERE l.dst = ? AND n.deleted_at IS NULL AND rp.deleted_at IS NULL
ORDER BY n.updated_at DESC LIMIT 500`, id)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	out := []Backlink{}
	for rows.Next() {
		var b Backlink
		var md string
		if err := rows.Scan(&b.ID, &b.RepoID, &b.RepoName, &b.Title, &b.UpdatedAt, &md); err != nil {
			httpError(w, 500, err.Error())
			return
		}
		b.Snippet = linkSnippet(md, id)
		out = append(out, b)
	}
	writeJSON(w, 200, out)
}

// linkSnippet is the plain text around the first link of md to id.
func linkSnippet(md, id string) string {
	for _, line := range strings.Split(md, "\n") {
		at := -1
		for _, m := range reNodeLink.FindAllStringSubmatchIndex(line, -1) {
			if line[m[2]:m[3]] == id {
				// back to the "[" opening the link text
				at = strings.LastIndex(line[:m[0]], "[")
				if at < 0 {
					at = m[0]
				}
				break
			}
		}
		if at < 0 {
			continue
		}
		before := []rune(strings.TrimLeft(plainLine(reLineMark.ReplaceAllString(line[:at], "")), " "))
		after := []rune(strings.TrimRight(plainLine(line[at:]), " "))
		prefix := ""
		if len(before) > 40 {
			before = before[len(before)-40:]
			prefix = "…"
		}
		suffix := ""
		if len(after) > 100 {
			after = after[:100]
			suffix = "…"
		}
		return prefix + string(before) + string(after) + suffix
	}
	return ""
}

func plainLine(s string) string {
	s = reMdLink.ReplaceAllString(s, "$1")
	return strings.NewReplacer("**", "", "__", "", "~~", "", "`", "", "\r", "").Replace(s)
}

type NodeRef struct {
	ID        string `json:"id"`
	RepoID    string `json:"repo_id"`
	RepoName  string `json:"repo_name"`
	Type      string `json:"type"`
	Title     string `json:"title"`
	UpdatedAt int64  `json:"updated_at"`
}

// findNodes looks up documents and tables by title for linking ([[ in the editor):
// titles starting with the query first, then the most recently edited.
func (s *Server) findNodes(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	esc := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(strings.ToLower(q))
	rows, err := s.db.Query(`SELECT n.id, n.repo_id, rp.name, n.type, n.title, n.updated_at
FROM nodes n JOIN repos rp ON rp.id = n.repo_id
WHERE n.type IN ('doc', 'table') AND n.deleted_at IS NULL AND rp.deleted_at IS NULL
  AND lower(n.title) LIKE ? ESCAPE '\'
ORDER BY (lower(n.title) LIKE ? ESCAPE '\') DESC, n.updated_at DESC LIMIT 30`, "%"+esc+"%", esc+"%")
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	out := []NodeRef{}
	for rows.Next() {
		var n NodeRef
		if err := rows.Scan(&n.ID, &n.RepoID, &n.RepoName, &n.Type, &n.Title, &n.UpdatedAt); err != nil {
			httpError(w, 500, err.Error())
			return
		}
		out = append(out, n)
	}
	writeJSON(w, 200, out)
}

// linkLabel is the text a link to a node shows by default (see docLinks.tsx).
func linkLabel(title, typ string) string {
	if t := strings.TrimSpace(title); t != "" {
		return t
	}
	if typ == "table" {
		return "未命名表格"
	}
	return "无标题文档"
}

var (
	reMdUnescape = regexp.MustCompile(`\\([!-/:-@\[-` + "`" + `{-~])`)
	mdLinkEscape = strings.NewReplacer(`\`, `\\`, `[`, `\[`, `]`, `\]`, `*`, `\*`, `_`, `\_`, "`", "\\`")
)

// renameLinks follows a node's rename in the documents linking to it: links whose text
// still is the old title get the new one; links with text of their own are kept.
// The documents' content timestamps stay as they are, so an editor that has one of them
// open does not run into a conflict (it updates its own copy, see Editor.tsx).
func renameLinks(tx *sql.Tx, id, typ, oldTitle, newTitle string) error {
	oldText, newText := linkLabel(oldTitle, typ), linkLabel(newTitle, typ)
	if oldText == newText {
		return nil
	}
	re, err := regexp.Compile(`\[((?:\\.|[^\]\\\n])*)\](\(\s*<?(?:https?://[^/\s)<>]+)?/r/[0-9a-z]+/[dt]/` + regexp.QuoteMeta(id) + `(?:[?#][^)\s]*)?>?\))`)
	if err != nil {
		return err
	}
	rows, err := tx.Query(`SELECT n.id, n.title, c.markdown FROM doc_links l
JOIN nodes n ON n.id = l.src JOIN doc_contents c ON c.node_id = n.id WHERE l.dst = ?`, id)
	if err != nil {
		return err
	}
	type doc struct{ id, title, md string }
	var changed []doc
	for rows.Next() {
		var d doc
		if err := rows.Scan(&d.id, &d.title, &d.md); err != nil {
			rows.Close()
			return err
		}
		md := re.ReplaceAllStringFunc(d.md, func(link string) string {
			m := re.FindStringSubmatch(link)
			if reMdUnescape.ReplaceAllString(m[1], "$1") != oldText {
				return link
			}
			return "[" + mdLinkEscape.Replace(newText) + "]" + m[2]
		})
		if md != d.md {
			d.md = md
			changed = append(changed, d)
		}
	}
	rows.Close()
	t := now()
	for _, d := range changed {
		if _, err := tx.Exec(`UPDATE doc_contents SET markdown = ? WHERE node_id = ?`, d.md, d.id); err != nil {
			return err
		}
		if err := indexDoc(tx, d.id, d.title, d.md, t); err != nil {
			return err
		}
	}
	return nil
}
