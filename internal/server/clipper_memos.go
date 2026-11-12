package server

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
)

type clipFailure struct {
	status        int
	code, message string
}

func (e *clipFailure) Error() string                  { return e.message }
func clipFail(status int, code, message string) error { return &clipFailure{status, code, message} }
func clipRespondError(w http.ResponseWriter, err error) {
	var e *clipFailure
	if errors.As(err, &e) {
		clipError(w, e.status, e.code, e.message)
	} else if errors.Is(err, sql.ErrNoRows) {
		clipError(w, 404, "not_found", "Clipper memo or notebook not found")
	} else {
		clipError(w, 500, "storage_error", "Cannot persist clipper data")
	}
}

type clipMemoInput struct {
	NotebookID string   `json:"notebookId"`
	Title      string   `json:"title"`
	Markdown   string   `json:"contentMarkdown"`
	Tags       []string `json:"tags"`
}
type clipMemo struct {
	ID          string   `json:"id"`
	NotebookID  string   `json:"notebookId"`
	Title       string   `json:"title"`
	Markdown    string   `json:"contentMarkdown"`
	Tags        []string `json:"tags"`
	Revision    int64    `json:"revision"`
	ContentHash string   `json:"contentHash"`
	CreatedAt   int64    `json:"createdAt"`
	UpdatedAt   int64    `json:"updatedAt"`
	nativeHash  string
}

func (s *Server) clipperNotebooks(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(`SELECT id,name FROM repos WHERE deleted_at IS NULL ORDER BY sort,created_at,id`)
	if err != nil {
		clipRespondError(w, err)
		return
	}
	defer rows.Close()
	out := []map[string]string{}
	for rows.Next() {
		var id, name string
		if err = rows.Scan(&id, &name); err != nil {
			clipRespondError(w, err)
			return
		}
		n := map[string]string{"id": id, "name": name}
		if len(out) == 0 {
			n["slug"] = "inbox"
		}
		out = append(out, n)
	}
	if err = rows.Err(); err != nil {
		clipRespondError(w, err)
		return
	}
	rows.Close()
	// Groups are native directory destinations; IDs retain their repository context.
	groups, err := s.db.Query(`SELECT n.repo_id,n.id,r.name,n.title FROM nodes n JOIN repos r ON r.id=n.repo_id WHERE n.type='group' AND n.deleted_at IS NULL AND r.deleted_at IS NULL ORDER BY r.sort,n.sort,n.id`)
	if err != nil {
		clipRespondError(w, err)
		return
	}
	defer groups.Close()
	for groups.Next() {
		var repo, id, name, title string
		if err = groups.Scan(&repo, &id, &name, &title); err != nil {
			clipRespondError(w, err)
			return
		}
		out = append(out, map[string]string{"id": repo + ":" + id, "name": name + " / " + title})
	}
	if err = groups.Err(); err != nil {
		clipRespondError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"notebooks": out})
}
func clipNormalizeInput(in *clipMemoInput) error {
	in.Title = strings.TrimSpace(in.Title)
	if len(in.Title) > 1000 || len(in.Markdown) > 16<<20 || len(in.Tags) > 100 {
		return clipFail(400, "invalid_request", "Memo or tags exceed size limits")
	}
	tags := []string{}
	seen := map[string]bool{}
	for _, tag := range in.Tags {
		tag = strings.TrimSpace(tag)
		if len(tag) > 200 {
			return clipFail(400, "invalid_request", "Tag exceeds size limit")
		}
		if tag != "" && !seen[tag] {
			tags = append(tags, tag)
			seen[tag] = true
		}
	}
	in.Tags = tags
	return nil
}
func clipDestination(tx *sql.Tx, id string) (string, *string, error) {
	repo, parent, hasParent := strings.Cut(id, ":")
	var exists string
	if err := tx.QueryRow(`SELECT id FROM repos WHERE id=? AND deleted_at IS NULL`, repo).Scan(&exists); err != nil {
		return "", nil, err
	}
	if hasParent {
		if err := tx.QueryRow(`SELECT id FROM nodes WHERE id=? AND repo_id=? AND type='group' AND deleted_at IS NULL`, parent, repo).Scan(&exists); err != nil {
			return "", nil, err
		}
		return repo, &parent, nil
	}
	return repo, nil, nil
}

var (
	clipResourceURL   = regexp.MustCompile(`^/api/v1/resources/([A-Za-z0-9_-]+)/blob$`)
	clipNativeURL     = regexp.MustCompile(`^/files/([0-9a-z]{20})(?:/.*)?$`)
	clipHTMLTag       = regexp.MustCompile(`(?i)<[a-z][a-z0-9:-]*\b[^>]*>`)
	clipHTMLAttribute = regexp.MustCompile(`(?i)(\s(?:src|href)[ \t]*=[ \t]*)("[^"]*"|'[^']*'|[^\s>]+)`)
)

// clipTargets visits destinations, never arbitrary substrings of document text.
// Keep code and all surrounding Markdown formatting byte-for-byte intact.
func clipTargets(md string, target func(string) string) string {
	rewrite := func(re *regexp.Regexp, text string, group int) string {
		return re.ReplaceAllStringFunc(text, func(match string) string {
			loc := re.FindStringSubmatchIndex(match)
			start, end := loc[2*group], loc[2*group+1]
			value := match[start:end]
			if len(value) >= 2 && ((value[0] == '<' && value[len(value)-1] == '>') || (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'')) {
				return match[:start+1] + target(value[1:len(value)-1]) + match[end-1:]
			}
			return match[:start] + target(value) + match[end:]
		})
	}
	lines := strings.SplitAfter(md, "\n")
	var fence string
	for i, line := range lines {
		body := strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		prefix := reQuotePrefix.FindString(body)
		content := strings.TrimPrefix(body, prefix)
		if m := reCodeFence.FindStringSubmatch(content); m != nil {
			if fence == "" {
				if m[1][0] != '`' || !strings.Contains(m[2], "`") {
					fence = m[1]
				}
			} else if m[1][0] == fence[0] && len(m[1]) >= len(fence) && strings.TrimSpace(m[2]) == "" {
				fence = ""
			}
			continue
		}
		if fence != "" {
			continue
		}
		var out strings.Builder
		last := 0
		for _, loc := range append(reInlineCode.FindAllStringIndex(content, -1), []int{len(content), len(content)}) {
			seg := content[last:loc[0]]
			if last == 0 {
				seg = rewrite(reRefDef, seg, 2)
			}
			seg = rewrite(reLinkTarget, seg, 1)
			seg = clipHTMLTag.ReplaceAllStringFunc(seg, func(tag string) string { return rewrite(clipHTMLAttribute, tag, 2) })
			out.WriteString(seg)
			out.WriteString(content[loc[0]:loc[1]])
			last = loc[1]
		}
		lines[i] = prefix + out.String() + line[len(body):]
	}
	return strings.Join(lines, "")
}

// Only root-relative paths belong to this instance; external URLs remain untouched.
func clipTargetPath(target string) (string, string) {
	if cut := strings.IndexAny(target, "?#"); cut >= 0 {
		return target[:cut], target[cut:]
	}
	return target, ""
}

func clipImagePlaceholder(md, id string) (string, bool) {
	found := false
	md = clipTargets(md, func(target string) string {
		path, suffix := clipTargetPath(target)
		if path == "/api/v1/resources/EDGEVERRESOURCEID/blob" {
			found = true
			return "/api/v1/resources/" + id + "/blob" + suffix
		}
		return target
	})
	return md, found
}

// Canonicalise genuine local references to existing native attachments.
func clipCanonical(tx *sql.Tx, md string) (string, error) {
	var failure error
	md = clipTargets(md, func(target string) string {
		path, suffix := clipTargetPath(target)
		var rid string
		if m := clipResourceURL.FindStringSubmatch(path); m != nil {
			rid = m[1]
		} else if m := clipNativeURL.FindStringSubmatch(path); m != nil {
			rid = m[1]
		} else {
			if strings.HasPrefix(path, "/api/v1/resources/") || strings.HasPrefix(path, "/files/") {
				failure = clipFail(400, "invalid_resource", "Invalid resource reference")
			}
			return target
		}
		var name string
		if err := tx.QueryRow(`SELECT name FROM attachments WHERE id=?`, rid).Scan(&name); err != nil {
			failure = clipFail(400, "invalid_resource", "Resource does not exist")
			return target
		}
		return fileURL(rid, name) + suffix
	})
	if failure != nil {
		return "", failure
	}
	return md, nil
}
func clipProject(tx *sql.Tx, md string) (string, error) {
	var failure error
	md = clipTargets(md, func(target string) string {
		path, suffix := clipTargetPath(target)
		m := clipNativeURL.FindStringSubmatch(path)
		if m == nil {
			return target
		}
		var name string
		err := tx.QueryRow(`SELECT name FROM attachments WHERE id=?`, m[1]).Scan(&name)
		if errors.Is(err, sql.ErrNoRows) {
			return target
		}
		if err != nil {
			failure = err
			return target
		}
		if path == fileURL(m[1], name) {
			return "/api/v1/resources/" + m[1] + "/blob" + suffix
		}
		return target
	})
	return md, failure
}
func clipLoad(tx *sql.Tx, id string) (*clipMemo, error) {
	m := &clipMemo{}
	var tags, md, storedHash, nativeHash string
	var storedRevision int64
	var parent sql.NullString
	err := tx.QueryRow(`SELECT n.id,n.repo_id,n.parent_id,n.title,d.markdown,d.updated_at,n.created_at,COALESCE(c.tags,'[]'),COALESCE(c.upstream_hash,''),COALESCE(c.native_hash,''),COALESCE(c.native_revision,0) FROM nodes n JOIN repos r ON r.id=n.repo_id JOIN doc_contents d ON d.node_id=n.id LEFT JOIN clipper_memos c ON c.node_id=n.id WHERE n.id=? AND n.type='doc' AND n.deleted_at IS NULL AND r.deleted_at IS NULL`, id).Scan(&m.ID, &m.NotebookID, &parent, &m.Title, &md, &m.Revision, &m.CreatedAt, &tags, &storedHash, &nativeHash, &storedRevision)
	if err != nil {
		return nil, err
	}
	if parent.Valid {
		m.NotebookID += ":" + parent.String
	}
	if err = json.Unmarshal([]byte(tags), &m.Tags); err != nil {
		return nil, err
	}
	m.nativeHash = clipHash(md)
	m.Markdown, err = clipProject(tx, md)
	if err != nil {
		return nil, err
	}
	m.ContentHash = clipHash(m.Markdown)
	if m.Revision == storedRevision && m.nativeHash == nativeHash {
		m.ContentHash = storedHash
	}
	m.UpdatedAt = m.Revision
	return m, nil
}
func clipCreateTx(tx *sql.Tx, in clipMemoInput, att *Attachment) (*clipMemo, error) {
	if err := clipNormalizeInput(&in); err != nil {
		return nil, err
	}
	repo, parent, err := clipDestination(tx, in.NotebookID)
	if err != nil {
		return nil, err
	}
	id := newID()
	t := now()
	tags, _ := json.Marshal(in.Tags)
	_, err = tx.Exec(`INSERT INTO nodes(id,repo_id,parent_id,type,title,sort,created_at,updated_at) VALUES(?,?,?,'doc',?,(SELECT COALESCE(MAX(sort),0)+1 FROM nodes WHERE repo_id=? AND parent_id IS ?),?,?)`, id, repo, parent, in.Title, repo, parent, t, t)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(`INSERT INTO clipper_memos(node_id,tags,upstream_hash,native_hash,native_revision) VALUES(?,?,?,'',?)`, id, string(tags), "", t)
	if err != nil {
		return nil, err
	}
	if att != nil {
		_, err = tx.Exec(`INSERT INTO clipper_resources(resource_id,node_id) VALUES(?,?)`, att.ID, id)
		if err != nil {
			return nil, err
		}
		in.Markdown, _ = clipImagePlaceholder(strings.ReplaceAll(in.Markdown, "\r\n", "\n"), att.ID)
	}
	native, err := clipCanonical(tx, in.Markdown)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(`INSERT INTO doc_contents(node_id,markdown,updated_at) VALUES(?,?,?)`, id, native, t); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(`UPDATE clipper_memos SET upstream_hash=?,native_hash=? WHERE node_id=?`, clipHash(in.Markdown), clipHash(native), id); err != nil {
		return nil, err
	}
	if err = indexDoc(tx, id, in.Title, native, t); err != nil {
		return nil, err
	}
	if err = addVersion(tx, id, in.Title, native, t); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(`UPDATE repos SET updated_at=? WHERE id=?`, t, repo); err != nil {
		return nil, err
	}
	return clipLoad(tx, id)
}
func (s *Server) clipperCreate(w http.ResponseWriter, r *http.Request) {
	var in clipMemoInput
	if readJSON(r, &in) != nil {
		clipError(w, 400, "invalid_request", "Invalid memo")
		return
	}
	s.clipCreateResponse(w, in, nil)
}
func (s *Server) clipCreateResponse(w http.ResponseWriter, in clipMemoInput, att *Attachment) {
	success := false
	if att != nil {
		defer func() {
			if !success {
				s.clipDiscardUpload(att)
			}
		}()
	}
	tx, err := s.db.Begin()
	if err != nil {
		clipRespondError(w, err)
		return
	}
	defer tx.Rollback()
	m, err := clipCreateTx(tx, in, att)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		clipRespondError(w, err)
		return
	}
	success = true
	out := map[string]any{"memo": m}
	if att != nil {
		out["resourceId"] = att.ID
	}
	writeJSON(w, 201, out)
}
func (s *Server) clipperGet(w http.ResponseWriter, r *http.Request) {
	tx, err := s.db.Begin()
	if err != nil {
		clipRespondError(w, err)
		return
	}
	defer tx.Rollback()
	m, err := clipLoad(tx, r.PathValue("id"))
	if err != nil {
		clipRespondError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"memo": m})
}
func (s *Server) clipperEditSession(w http.ResponseWriter, r *http.Request) {
	tx, err := s.db.Begin()
	if err != nil {
		clipRespondError(w, err)
		return
	}
	defer tx.Rollback()
	m, err := clipLoad(tx, r.PathValue("id"))
	if err != nil {
		clipRespondError(w, err)
		return
	}
	id := clipRandom()
	_, err = tx.Exec(`DELETE FROM clipper_edit_sessions WHERE expires_at<=?`, now())
	if err == nil {
		_, err = tx.Exec(`INSERT INTO clipper_edit_sessions(id,node_id,revision,content_hash,native_hash,expires_at) VALUES(?,?,?,?,?,?)`, id, m.ID, m.Revision, m.ContentHash, m.nativeHash, now()+30*60*1000)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		clipRespondError(w, err)
		return
	}
	writeJSON(w, 201, map[string]any{"editSession": map[string]any{"id": id, "baseRevision": m.Revision, "baseContentHash": m.ContentHash}})
}
func (s *Server) clipperSave(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Session  string  `json:"editSessionId"`
		Revision int64   `json:"expectedRevision"`
		Hash     string  `json:"expectedContentHash"`
		Markdown *string `json:"contentMarkdown"`
	}
	if readJSON(r, &in) != nil || in.Markdown == nil || len(*in.Markdown) > 16<<20 {
		clipError(w, 400, "invalid_request", "A bounded contentMarkdown and edit session are required")
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		clipRespondError(w, err)
		return
	}
	defer tx.Rollback()
	id := r.PathValue("id")
	m, err := clipLoad(tx, id)
	if err != nil {
		clipRespondError(w, err)
		return
	}
	var revision int64
	var hash, nativeHash string
	err = tx.QueryRow(`SELECT revision,content_hash,native_hash FROM clipper_edit_sessions WHERE id=? AND node_id=? AND expires_at>?`, in.Session, id, now()).Scan(&revision, &hash, &nativeHash)
	if err != nil || revision != in.Revision || hash != in.Hash || m.Revision != revision || m.ContentHash != hash || m.nativeHash != nativeHash {
		clipError(w, 409, "edit_conflict", "Memo changed or edit session expired; reload before saving")
		return
	}
	native, err := clipCanonical(tx, *in.Markdown)
	if err != nil {
		clipRespondError(w, err)
		return
	}
	t := now()
	if t <= m.Revision {
		t = m.Revision + 1
	}
	// Preserve the native version before every extension rewrite, including a recent native edit.
	var previous string
	err = tx.QueryRow(`SELECT markdown FROM doc_contents WHERE node_id=?`, id).Scan(&previous)
	if err == nil {
		same, e := sameAsLatest(tx, id, previous)
		err = e
		if err == nil && !same {
			err = addVersion(tx, id, m.Title, previous, m.Revision)
		}
	}
	if err == nil {
		_, err = tx.Exec(`UPDATE doc_contents SET markdown=?,updated_at=? WHERE node_id=?`, native, t, id)
	}
	if err == nil {
		_, err = tx.Exec(`UPDATE nodes SET updated_at=? WHERE id=?`, t, id)
	}
	if err == nil {
		_, err = tx.Exec(`UPDATE repos SET updated_at=? WHERE id=(SELECT repo_id FROM nodes WHERE id=?)`, t, id)
	}
	if err == nil {
		err = indexDoc(tx, id, m.Title, native, t)
	}
	if err == nil {
		err = addVersion(tx, id, m.Title, native, t)
	}
	if err == nil {
		_, err = tx.Exec(`INSERT INTO clipper_memos(node_id,upstream_hash,native_hash,native_revision) VALUES(?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET upstream_hash=excluded.upstream_hash,native_hash=excluded.native_hash,native_revision=excluded.native_revision`, id, clipHash(*in.Markdown), clipHash(native), t)
	}
	if err == nil {
		_, err = tx.Exec(`DELETE FROM clipper_edit_sessions WHERE node_id=?`, id)
	}
	if err == nil {
		m, err = clipLoad(tx, id)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		clipRespondError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"memo": m})
}
func (s *Server) clipperDelete(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("permanent") != "1" {
		clipError(w, 400, "invalid_request", "permanent=1 is required")
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		clipRespondError(w, err)
		return
	}
	defer tx.Rollback()
	m, err := clipLoad(tx, r.PathValue("id"))
	if err != nil {
		clipRespondError(w, err)
		return
	}
	// Keep the generic parent invariant: deleting a document must not orphan children.
	var children int
	err = tx.QueryRow(`SELECT COUNT(*) FROM nodes WHERE parent_id=?`, m.ID).Scan(&children)
	if err == nil && children > 0 {
		clipError(w, 409, "has_children", "Move child notes before deleting this memo")
		return
	}
	for _, q := range []string{`DELETE FROM docs_fts WHERE node_id=?`, `DELETE FROM fts_pending WHERE node_id=?`, `DELETE FROM shares WHERE target_type='node' AND target_id=?`, `DELETE FROM nodes WHERE id=?`} {
		if err == nil {
			_, err = tx.Exec(q, m.ID)
		}
	}
	if err == nil {
		repo, _, _ := strings.Cut(m.NotebookID, ":")
		_, err = tx.Exec(`UPDATE repos SET updated_at=? WHERE id=?`, now(), repo)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		clipRespondError(w, err)
		return
	}
	ok(w)
}
func (s *Server) clipReadImage(w http.ResponseWriter, r *http.Request) (*Attachment, error) {
	limit := s.cfg.MaxUploadMB << 20
	if limit <= 0 {
		limit = 10 << 20
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit+(2<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		if r.MultipartForm != nil {
			r.MultipartForm.RemoveAll()
		}
		return nil, clipFail(400, "invalid_multipart", "Invalid or oversized image upload")
	}
	defer r.MultipartForm.RemoveAll()
	f, h, err := r.FormFile("file")
	if err != nil {
		return nil, clipFail(400, "missing_file", "Image file is required")
	}
	defer f.Close()
	head := make([]byte, 512)
	n, err := io.ReadFull(f, head)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return nil, err
	}
	head = head[:n]
	mt := clipImageType(head)
	if mt == "" {
		return nil, clipFail(415, "invalid_image", "Unsupported image content")
	}
	digest := sha256.New()
	att, err := s.storeUpload(io.TeeReader(io.MultiReader(bytes.NewReader(head), f), digest), h.Filename, mt, limit)
	if err != nil {
		// storeUpload may have moved a blob before its attachment INSERT failed.
		s.blobMu.Lock()
		sum := hex.EncodeToString(digest.Sum(nil))
		var count int
		if s.db.QueryRow(`SELECT COUNT(*) FROM attachments WHERE sha256=?`, sum).Scan(&count) == nil && count == 0 {
			os.Remove(s.blobPath(sum))
		}
		s.blobMu.Unlock()
	}
	if errors.Is(err, errTooLarge) {
		return nil, clipFail(413, "file_too_large", "Image exceeds upload limit")
	}
	return att, err
}
func (s *Server) clipDiscardUpload(att *Attachment) {
	s.blobMu.Lock()
	defer s.blobMu.Unlock()
	if _, err := s.db.Exec(`DELETE FROM attachments WHERE id=? AND NOT EXISTS(SELECT 1 FROM clipper_resources WHERE resource_id=?)`, att.ID, att.ID); err != nil {
		return
	}
	var count int
	if s.db.QueryRow(`SELECT COUNT(*) FROM attachments WHERE sha256=?`, att.SHA256).Scan(&count) == nil && count == 0 {
		os.Remove(s.blobPath(att.SHA256))
	}
}
func (s *Server) clipperCreateImage(w http.ResponseWriter, r *http.Request) {
	att, err := s.clipReadImage(w, r)
	if err != nil {
		clipRespondError(w, err)
		return
	}
	in := clipMemoInput{NotebookID: r.FormValue("notebookId"), Title: r.FormValue("title"), Markdown: r.FormValue("contentMarkdown")}
	if err = json.Unmarshal([]byte(r.FormValue("tags")), &in.Tags); err != nil {
		s.clipDiscardUpload(att)
		clipError(w, 400, "invalid_request", "tags must be a JSON string array")
		return
	}
	if _, found := clipImagePlaceholder(in.Markdown, att.ID); !found {
		s.clipDiscardUpload(att)
		clipError(w, 400, "invalid_request", "Image markdown must contain EDGEVERRESOURCEID")
		return
	}
	s.clipCreateResponse(w, in, att)
}
func (s *Server) clipperUpload(w http.ResponseWriter, r *http.Request) {
	// Check document existence and type before consuming a large multipart body.
	tx, err := s.db.Begin()
	if err != nil {
		clipRespondError(w, err)
		return
	}
	_, err = clipLoad(tx, r.PathValue("id"))
	tx.Rollback()
	if err != nil {
		clipRespondError(w, err)
		return
	}
	att, err := s.clipReadImage(w, r)
	if err != nil {
		clipRespondError(w, err)
		return
	}
	success := false
	defer func() {
		if !success {
			s.clipDiscardUpload(att)
		}
	}()
	tx, err = s.db.Begin()
	if err != nil {
		clipRespondError(w, err)
		return
	}
	defer tx.Rollback()
	_, err = clipLoad(tx, r.PathValue("id"))
	if err == nil {
		_, err = tx.Exec(`INSERT INTO clipper_resources(resource_id,node_id) VALUES(?,?)`, att.ID, r.PathValue("id"))
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		clipRespondError(w, err)
		return
	}
	success = true
	writeJSON(w, 201, map[string]any{"resource": map[string]any{"id": att.ID, "mimeType": att.Mime, "size": att.Size}})
}
func (s *Server) clipperBlob(w http.ResponseWriter, r *http.Request) {
	var name string
	err := s.db.QueryRow(`SELECT name FROM attachments WHERE id=?`, r.PathValue("id")).Scan(&name)
	if err != nil {
		clipRespondError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, fileURL(r.PathValue("id"), name), http.StatusTemporaryRedirect)
}
