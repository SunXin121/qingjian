package server

// Importing markdown (导入): one or many .md files, a folder (each file sent with its
// relative path), or a zip such as the one exportRepo writes.
//
//   - Folders become groups; when a.md sits next to a folder a/, the folder's documents
//     become children of a.md instead (the layout exportRepo writes). Folders without any
//     markdown in them (assets/, images/) are not created.
//   - Relative links between imported files become document links, so backlinks work;
//     referenced images and other files become attachments. Obsidian [[wikilinks]] and
//     ![[embeds]] are resolved by file name.
//   - The title is the file name (front matter title: wins); a leading "# heading" equal to
//     the title is dropped, since the page shows the title already. Notion's 32-hex id
//     suffixes are removed from names.
//   - Files are decoded from UTF-8, UTF-16 (with BOM) or GB18030 (GBK); zip entry names
//     written by Windows in GBK are decoded too.

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
	xunicode "golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

const (
	importMaxFiles    = 10000
	importMaxDocBytes = 16 << 20  // one markdown file
	importMaxMDBytes  = 128 << 20 // all markdown of one import
	importMaxMissing  = 50
)

var mdExts = map[string]bool{".md": true, ".markdown": true, ".mdown": true, ".mkd": true}

func isMarkdownName(p string) bool { return mdExts[strings.ToLower(path.Ext(p))] }

type importFile struct {
	path string // slash-separated, relative, cleaned
	md   string // markdown files: decoded content
	open func() (io.ReadCloser, error)
}

type importSet struct {
	files   map[string]*importFile
	lower   map[string]*importFile   // case-insensitive fallback
	byBase  map[string][]*importFile // lower-case base name → files, for [[wikilinks]]
	order   []*importFile
	mdBytes int
	tmpDir  string
	closers []io.Closer
	seq     int
}

func newImportSet(tmpDir string) *importSet {
	return &importSet{files: map[string]*importFile{}, lower: map[string]*importFile{}, byBase: map[string][]*importFile{}, tmpDir: tmpDir}
}

func (set *importSet) close() {
	for _, c := range set.closers {
		c.Close()
	}
}

type importError struct {
	status int
	msg    string
}

func (e *importError) Error() string { return e.msg }

// cleanImportPath normalises a client or zip path; "" means skip the file (hidden files,
// OS metadata, paths escaping the root).
func cleanImportPath(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimLeft(path.Clean("/"+p), "/")
	if p == "" || p == "." {
		return ""
	}
	for _, seg := range strings.Split(p, "/") {
		if strings.HasPrefix(seg, ".") || seg == "__MACOSX" || strings.EqualFold(seg, "Thumbs.db") || strings.EqualFold(seg, "desktop.ini") {
			return ""
		}
	}
	return p
}

func (set *importSet) add(f *importFile) error {
	if _, dup := set.files[f.path]; dup {
		return nil
	}
	if len(set.order) >= importMaxFiles {
		return &importError{400, fmt.Sprintf("文件太多（最多 %d 个）", importMaxFiles)}
	}
	set.files[f.path] = f
	if _, ok := set.lower[strings.ToLower(f.path)]; !ok {
		set.lower[strings.ToLower(f.path)] = f
	}
	base := strings.ToLower(path.Base(f.path))
	set.byBase[base] = append(set.byBase[base], f)
	if isMarkdownName(f.path) {
		stem := strings.TrimSuffix(base, path.Ext(base))
		set.byBase[stem] = append(set.byBase[stem], f)
	}
	set.order = append(set.order, f)
	return nil
}

func (set *importSet) addMarkdown(p string, r io.Reader) error {
	data, err := io.ReadAll(io.LimitReader(r, importMaxDocBytes+1))
	if err != nil {
		return err
	}
	if len(data) > importMaxDocBytes {
		return &importError{http.StatusRequestEntityTooLarge, fmt.Sprintf("「%s」超过 %dMB", p, importMaxDocBytes>>20)}
	}
	set.mdBytes += len(data)
	if set.mdBytes > importMaxMDBytes {
		return &importError{http.StatusRequestEntityTooLarge, fmt.Sprintf("Markdown 总量超过 %dMB", importMaxMDBytes>>20)}
	}
	return set.add(&importFile{path: p, md: decodeText(data)})
}

// addUpload takes one uploaded file: markdown is read, a .zip at the top level is opened
// as an archive, anything else is kept in a temporary file until a document references it.
func (set *importSet) addUpload(src io.Reader, rawPath string, limit int64) error {
	p := cleanImportPath(rawPath)
	if p == "" {
		_, err := io.Copy(io.Discard, src)
		return err
	}
	if isMarkdownName(p) {
		return set.addMarkdown(p, src)
	}
	set.seq++
	tmp, err := os.Create(filepath.Join(set.tmpDir, fmt.Sprint(set.seq)))
	if err != nil {
		return err
	}
	n, err := io.Copy(tmp, io.LimitReader(src, limit+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if n > limit {
		return &importError{http.StatusRequestEntityTooLarge, fmt.Sprintf("「%s」超过上传限制", p)}
	}
	name := tmp.Name()
	if strings.EqualFold(path.Ext(p), ".zip") && !strings.Contains(p, "/") {
		return set.addZip(name, limit)
	}
	return set.add(&importFile{path: p, open: func() (io.ReadCloser, error) { return os.Open(name) }})
}

func (set *importSet) addZip(name string, limit int64) error {
	zr, err := zip.OpenReader(name)
	if err != nil {
		return &importError{400, "无法读取 zip 文件"}
	}
	set.closers = append(set.closers, zr)
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		raw := f.Name
		if f.NonUTF8 || !utf8.ValidString(raw) {
			if s, err := simplifiedchinese.GB18030.NewDecoder().String(raw); err == nil {
				raw = s
			}
		}
		p := cleanImportPath(raw)
		if p == "" {
			continue
		}
		if isMarkdownName(p) {
			rc, err := f.Open()
			if err != nil {
				return &importError{400, "zip 文件损坏：" + p}
			}
			err = set.addMarkdown(p, rc)
			rc.Close()
			if err != nil {
				return err
			}
			continue
		}
		if int64(f.UncompressedSize64) > limit {
			continue // reported as missing if a document needs it
		}
		if err := set.add(&importFile{path: p, open: f.Open}); err != nil {
			return err
		}
	}
	return nil
}

// decodeText turns file bytes into UTF-8 text with \n line endings.
func decodeText(b []byte) string {
	var s string
	switch {
	case bytes.HasPrefix(b, []byte{0xEF, 0xBB, 0xBF}):
		s = string(b[3:])
	case bytes.HasPrefix(b, []byte{0xFF, 0xFE}), bytes.HasPrefix(b, []byte{0xFE, 0xFF}):
		dec := xunicode.UTF16(xunicode.LittleEndian, xunicode.UseBOM).NewDecoder()
		if out, _, err := transform.Bytes(dec, b); err == nil {
			s = string(out)
		} else {
			s = string(b)
		}
	case utf8.Valid(b):
		s = string(b)
	default:
		if out, _, err := transform.Bytes(simplifiedchinese.GB18030.NewDecoder(), b); err == nil {
			s = string(out)
		} else {
			s = strings.ToValidUTF8(string(b), "�")
		}
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\r", "\n")
}

// ---- plan: the tree of nodes to create ----

type importNode struct {
	id       string
	typ      string // doc | group
	title    string
	name     string // for ordering
	file     *importFile
	children []*importNode
}

var reNotionID = regexp.MustCompile(`\s+[0-9a-f]{32}$`)

func importTitle(name string) string {
	return strings.TrimSpace(reNotionID.ReplaceAllString(name, ""))
}

// planImport arranges the markdown files into a tree and returns its roots plus the node
// of every markdown file.
func planImport(set *importSet) ([]*importNode, map[*importFile]*importNode) {
	var mds []*importFile
	for _, f := range set.order {
		if f.open == nil {
			mds = append(mds, f)
		}
	}
	// shallow paths first so a.md is seen before a/b.md, then by name
	slices.SortFunc(mds, func(a, b *importFile) int {
		if d := strings.Count(a.path, "/") - strings.Count(b.path, "/"); d != 0 {
			return d
		}
		return naturalCompare(a.path, b.path)
	})
	var roots []*importNode
	byKey := map[string]*importNode{}
	docs := map[*importFile]*importNode{}
	attach := func(parent, n *importNode) {
		if parent == nil {
			roots = append(roots, n)
		} else {
			parent.children = append(parent.children, n)
		}
	}
	var dir func(d string) *importNode
	dir = func(d string) *importNode {
		if d == "." || d == "" {
			return nil
		}
		if n := byKey[d]; n != nil {
			return n
		}
		parent := dir(path.Dir(d))
		base := path.Base(d)
		n := &importNode{id: newID(), typ: "group", title: importTitle(base), name: base}
		byKey[d] = n
		attach(parent, n)
		return n
	}
	for _, f := range mds {
		key := strings.TrimSuffix(f.path, path.Ext(f.path))
		stem := path.Base(key)
		n := byKey[key]
		switch {
		case n != nil && n.typ == "group" && n.file == nil:
			// a folder named like this file: the folder's documents are its children
			n.typ, n.file = "doc", f
		default:
			parent := dir(path.Dir(key))
			n = &importNode{id: newID(), typ: "doc", title: importTitle(stem), name: stem, file: f}
			if byKey[key] == nil {
				byKey[key] = n
			}
			attach(parent, n)
		}
		docs[f] = n
	}
	var sortAll func(list []*importNode)
	sortAll = func(list []*importNode) {
		slices.SortStableFunc(list, func(a, b *importNode) int { return naturalCompare(a.name, b.name) })
		for _, n := range list {
			sortAll(n.children)
		}
	}
	sortAll(roots)
	return roots, docs
}

// naturalCompare orders "2 b" before "10 a", case-insensitively.
func naturalCompare(a, b string) int {
	ar, br := []rune(strings.ToLower(a)), []rune(strings.ToLower(b))
	i, j := 0, 0
	for i < len(ar) && j < len(br) {
		if unicode.IsDigit(ar[i]) && unicode.IsDigit(br[j]) {
			si, sj := i, j
			for i < len(ar) && unicode.IsDigit(ar[i]) {
				i++
			}
			for j < len(br) && unicode.IsDigit(br[j]) {
				j++
			}
			na := strings.TrimLeft(string(ar[si:i]), "0")
			nb := strings.TrimLeft(string(br[sj:j]), "0")
			if len(na) != len(nb) {
				return len(na) - len(nb)
			}
			if c := strings.Compare(na, nb); c != 0 {
				return c
			}
			continue
		}
		if ar[i] != br[j] {
			if ar[i] < br[j] {
				return -1
			}
			return 1
		}
		i++
		j++
	}
	return (len(ar) - i) - (len(br) - j)
}

// ---- markdown rewriting ----

var (
	reFrontMatter = regexp.MustCompile(`^---[ \t]*\n((?s:.*?))\n(?:---|\.\.\.)[ \t]*(?:\n|$)`)
	reFMKey       = regexp.MustCompile(`^\s*[A-Za-z_][\w.-]*[ \t]*:`)
	reFMTitle     = regexp.MustCompile(`(?m)^title[ \t]*:[ \t]*(.*?)[ \t]*$`)
	reLeadingH1   = regexp.MustCompile(`^\s*#[ \t]+(.+?)[ \t#]*(?:\n|$)`)
	// ](target "title") of inline links and images
	reLinkTarget = regexp.MustCompile(`\]\([ \t]*(<[^>\n]*>|[^)\s]+)`)
	// [label]: target of reference definitions
	reRefDef = regexp.MustCompile(`^( {0,3}\[[^\]\n^][^\]\n]*\]:[ \t]*)(<[^>\n]*>|\S+)`)
	// src= / href= of HTML tags
	reHTMLRef    = regexp.MustCompile(`(?i)(<(?:img|a|video|audio|source)\b[^>]*?\s(?:src|href)[ \t]*=[ \t]*)("[^"]*"|'[^']*')`)
	reWikiLink   = regexp.MustCompile(`(!?)\[\[([^\[\]|#\n]+)(#[^\[\]|\n]*)?(?:\|([^\[\]\n]*))?\]\]`)
	reInlineCode = regexp.MustCompile("``[^\n]*?``|`[^`\n]*`")
	reURLScheme  = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*:`)
	reDigits     = regexp.MustCompile(`^\s*\d+(x\d+)?\s*$`)
)

// splitFrontMatter returns the front matter's title, the rest of the front matter as a
// yaml code block (so nothing is lost; "" when there is no more) and the markdown after it.
func splitFrontMatter(md string) (title, meta, rest string) {
	m := reFrontMatter.FindStringSubmatchIndex(md)
	if m == nil {
		return "", "", md
	}
	body := md[m[2]:m[3]]
	if !reFMKey.MatchString(strings.TrimLeft(body, "\n")) {
		return "", "", md // a thematic break, not YAML
	}
	if t := reFMTitle.FindStringSubmatch(body); t != nil {
		title = strings.TrimSpace(strings.Trim(t[1], `"'`))
		body = reFMTitle.ReplaceAllString(body, "")
	}
	if strings.TrimSpace(body) != "" {
		meta = "```yaml\n" + strings.Trim(body, "\n") + "\n```\n\n"
	}
	return title, meta, strings.TrimLeft(md[m[1]:], "\n")
}

// dropTitleHeading removes a first-line "# title" heading that repeats the title.
func dropTitleHeading(md, title string) string {
	m := reLeadingH1.FindStringSubmatchIndex(md)
	if m == nil || strings.TrimSpace(md[m[2]:m[3]]) != title {
		return md
	}
	return strings.TrimLeft(md[m[1]:], "\n")
}

type importRewriter struct {
	s       *Server
	set     *importSet
	docs    map[*importFile]*importNode
	repoID  string
	limit   int64
	stored  map[*importFile]string // attachment url
	failed  map[*importFile]bool
	missing []string
	seen    map[string]bool
	atts    int
}

func (rw *importRewriter) lookup(p string) *importFile {
	if f := rw.set.files[p]; f != nil {
		return f
	}
	if f := rw.set.lower[strings.ToLower(p)]; f != nil {
		return f
	}
	if path.Ext(p) == "" {
		for ext := range mdExts {
			if f := rw.set.lower[strings.ToLower(p+ext)]; f != nil {
				return f
			}
		}
	}
	return nil
}

func (rw *importRewriter) docURL(n *importNode) string {
	return "/r/" + rw.repoID + "/d/" + n.id
}

func (rw *importRewriter) attachmentURL(f *importFile) string {
	if u, ok := rw.stored[f]; ok {
		return u
	}
	if rw.failed[f] {
		return ""
	}
	rc, err := f.open()
	if err == nil {
		var a *Attachment
		a, err = rw.s.storeUpload(rc, path.Base(f.path), "", rw.limit)
		rc.Close()
		if err == nil {
			rw.stored[f] = a.URL
			rw.atts++
			return a.URL
		}
	}
	rw.failed[f] = true
	return ""
}

func (rw *importRewriter) miss(from, target string) {
	key := from + " → " + target
	if rw.seen[key] {
		return
	}
	rw.seen[key] = true
	if len(rw.missing) < importMaxMissing {
		rw.missing = append(rw.missing, key)
	}
}

// target resolves a link target written in the file at `from`; ok=false keeps it as is.
func (rw *importRewriter) target(from, raw string) (string, bool) {
	t := strings.TrimSpace(raw)
	angle := strings.HasPrefix(t, "<") && strings.HasSuffix(t, ">")
	if angle {
		t = t[1 : len(t)-1]
	}
	if t == "" || strings.HasPrefix(t, "#") || strings.HasPrefix(t, "/") || reURLScheme.MatchString(t) {
		return "", false
	}
	suffix := ""
	if i := strings.IndexAny(t, "#?"); i >= 0 {
		t, suffix = t[:i], t[i:]
	}
	dec, err := url.PathUnescape(t)
	if err != nil {
		dec = t
	}
	p := path.Clean(path.Join(path.Dir(from), dec))
	if strings.HasPrefix(p, "../") || p == ".." {
		return "", false
	}
	f := rw.lookup(p)
	if f == nil && dec != t {
		f = rw.lookup(path.Clean(path.Join(path.Dir(from), t)))
	}
	if f == nil {
		rw.miss(from, dec)
		return "", false
	}
	if n := rw.docs[f]; n != nil {
		return rw.docURL(n) + strings.ReplaceAll(suffix, " ", "%20"), true
	}
	if f.open == nil {
		return "", false
	}
	u := rw.attachmentURL(f)
	if u == "" {
		rw.miss(from, dec)
		return "", false
	}
	return u, true
}

// wikiTarget finds the file an Obsidian [[name]] refers to.
func (rw *importRewriter) wikiTarget(from, name string) *importFile {
	name = strings.TrimSpace(name)
	if strings.Contains(name, "/") {
		if f := rw.lookup(path.Clean(name)); f != nil {
			return f
		}
		if f := rw.lookup(path.Clean(path.Join(path.Dir(from), name))); f != nil {
			return f
		}
	}
	cands := rw.set.byBase[strings.ToLower(path.Base(name))]
	if len(cands) == 0 {
		return nil
	}
	// prefer the closest one: same folder, then the shortest path
	best := cands[0]
	for _, c := range cands[1:] {
		if path.Dir(c.path) == path.Dir(from) && path.Dir(best.path) != path.Dir(from) {
			best = c
		} else if path.Dir(best.path) != path.Dir(from) && len(c.path) < len(best.path) {
			best = c
		}
	}
	return best
}

func (rw *importRewriter) rewriteWiki(from, s string) string {
	return reWikiLink.ReplaceAllStringFunc(s, func(m string) string {
		g := reWikiLink.FindStringSubmatch(m)
		embed, name, anchor, alias := g[1] == "!", g[2], g[3], strings.TrimSpace(g[4])
		f := rw.wikiTarget(from, name)
		if f == nil {
			rw.miss(from, name)
			return m
		}
		if n := rw.docs[f]; n != nil {
			label := alias
			if label == "" {
				label = linkLabel(n.title, "doc")
			}
			return "[" + mdLinkEscape.Replace(label) + "](" + rw.docURL(n) + anchor + ")"
		}
		u := rw.attachmentURL(f)
		if u == "" {
			rw.miss(from, name)
			return m
		}
		if reDigits.MatchString(alias) {
			alias = "" // ![[image.png|300]]: a size
		}
		if embed {
			return "![" + mdLinkEscape.Replace(alias) + "](" + u + ")"
		}
		return "[" + mdLinkEscape.Replace(nonEmpty(alias, path.Base(f.path))) + "](" + u + ")"
	})
}

// rewriteLine rewrites the links of one line outside code spans.
func (rw *importRewriter) rewriteLine(from, line string) string {
	line = reRefDef.ReplaceAllStringFunc(line, func(m string) string {
		g := reRefDef.FindStringSubmatch(m)
		if t, ok := rw.target(from, g[2]); ok {
			return g[1] + t
		}
		return m
	})
	var out strings.Builder
	last := 0
	for _, loc := range append(reInlineCode.FindAllStringIndex(line, -1), []int{len(line), len(line)}) {
		seg := line[last:loc[0]]
		seg = rw.rewriteWiki(from, seg)
		seg = reLinkTarget.ReplaceAllStringFunc(seg, func(m string) string {
			g := reLinkTarget.FindStringSubmatch(m)
			if t, ok := rw.target(from, g[1]); ok {
				return "](" + t
			}
			return m
		})
		seg = reHTMLRef.ReplaceAllStringFunc(seg, func(m string) string {
			g := reHTMLRef.FindStringSubmatch(m)
			q := g[2][:1]
			if t, ok := rw.target(from, g[2][1:len(g[2])-1]); ok {
				return g[1] + q + t + q
			}
			return m
		})
		out.WriteString(seg)
		out.WriteString(line[loc[0]:loc[1]])
		last = loc[1]
	}
	return out.String()
}

// rewrite rewrites every link of a document, leaving fenced code blocks alone.
func (rw *importRewriter) rewrite(from, md string) string {
	lines := strings.SplitAfter(md, "\n")
	var fence string
	for i, line := range lines {
		body := strings.TrimSuffix(line, "\n")
		content := strings.TrimPrefix(body, reQuotePrefix.FindString(body))
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
		if fence == "" && strings.ContainsAny(body, "]<") {
			lines[i] = rw.rewriteLine(from, body) + line[len(body):]
		}
	}
	return strings.Join(lines, "")
}

// ---- handler ----

type importResult struct {
	Docs        int      `json:"docs"`
	Groups      int      `json:"groups"`
	Attachments int      `json:"attachments"`
	Missing     []string `json:"missing"`
	First       *Node    `json:"first"`
}

// importDocs: POST /api/repos/{id}/import, multipart with an optional parent_id field and
// any number of files; each file may be preceded by a "path" field holding its relative
// path (the file name's own directory part is dropped by browsers and Go alike).
func (s *Server) importDocs(w http.ResponseWriter, r *http.Request) {
	repoID := r.PathValue("id")
	if _, err := s.loadRepo(repoID); err != nil {
		httpError(w, http.StatusNotFound, "知识库不存在")
		return
	}
	limit := s.cfg.MaxUploadMB << 20
	r.Body = http.MaxBytesReader(w, r.Body, limit+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		httpError(w, http.StatusBadRequest, "需要 multipart/form-data")
		return
	}
	tmpDir, err := os.MkdirTemp(filepath.Join(s.filesDir, "tmp"), "import-*")
	if err != nil {
		serverError(w, err)
		return
	}
	defer os.RemoveAll(tmpDir)
	set := newImportSet(tmpDir)
	defer set.close()

	fail := func(err error) {
		var ie *importError
		var mbe *http.MaxBytesError
		switch {
		case errors.As(err, &ie):
			httpError(w, ie.status, ie.msg)
		case errors.As(err, &mbe):
			httpError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("上传内容超过 %dMB 限制", s.cfg.MaxUploadMB))
		default:
			httpError(w, http.StatusBadRequest, "上传失败："+err.Error())
		}
	}
	var parentID *string
	var nextPath string
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			fail(err)
			return
		}
		switch part.FormName() {
		case "parent_id", "path":
			b, err := io.ReadAll(io.LimitReader(part, 4096))
			if err != nil {
				part.Close()
				fail(err)
				return
			}
			if v := strings.TrimSpace(string(b)); part.FormName() == "path" {
				nextPath = v
			} else if v != "" {
				parentID = &v
			}
		case "file":
			p := nextPath
			nextPath = ""
			if p == "" {
				p = rawFileName(part)
			}
			if err := set.addUpload(part, p, limit); err != nil {
				part.Close()
				fail(err)
				return
			}
		}
		part.Close()
	}

	roots, docs := planImport(set)
	if len(docs) == 0 {
		httpError(w, http.StatusBadRequest, "没有找到 Markdown 文件（.md / .markdown）")
		return
	}
	if parentID != nil {
		p, err := s.loadNode(s.db, *parentID)
		if err != nil || p.RepoID != repoID {
			httpError(w, http.StatusBadRequest, "导入位置不存在")
			return
		}
	}

	// rewrite first: attachments are stored outside the transaction
	rw := &importRewriter{s: s, set: set, docs: docs, repoID: repoID, limit: limit,
		stored: map[*importFile]string{}, failed: map[*importFile]bool{}, seen: map[string]bool{}}
	contents := map[*importNode]string{}
	for f, n := range docs {
		fmTitle, meta, md := splitFrontMatter(f.md)
		if fmTitle != "" {
			n.title = fmTitle
		}
		md = meta + dropTitleHeading(md, n.title)
		contents[n] = rw.rewrite(f.path, md)
	}

	res := importResult{Attachments: rw.atts, Missing: rw.missing}
	if res.Missing == nil {
		res.Missing = []string{}
	}
	t := now()
	err = s.withTx(func(tx *sql.Tx) error {
		if parentID != nil {
			if p, err := s.loadNode(tx, *parentID); err != nil || p.RepoID != repoID {
				return errStatus(http.StatusBadRequest, "导入位置不存在")
			}
		}
		var base float64
		if err := tx.QueryRow(`SELECT COALESCE(MAX(sort), 0) FROM nodes WHERE repo_id = ? AND parent_id IS ? AND deleted_at IS NULL`, repoID, parentID).Scan(&base); err != nil {
			return err
		}
		var insert func(parent *string, list []*importNode, base float64) error
		insert = func(parent *string, list []*importNode, base float64) error {
			for i, in := range list {
				n := Node{ID: in.id, RepoID: repoID, ParentID: parent, Type: in.typ, Title: in.title, Sort: base + float64(i+1), CreatedAt: t, UpdatedAt: t}
				if _, err := tx.Exec(`INSERT INTO nodes(id, repo_id, parent_id, type, title, sort, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)`,
					n.ID, n.RepoID, n.ParentID, n.Type, n.Title, n.Sort, n.CreatedAt, n.UpdatedAt); err != nil {
					return err
				}
				if in.typ == "doc" {
					md := contents[in]
					if _, err := tx.Exec(`INSERT INTO doc_contents(node_id, markdown, updated_at) VALUES(?,?,?)`, n.ID, md, t); err != nil {
						return err
					}
					if err := indexDoc(tx, n.ID, n.Title, md, t); err != nil {
						return err
					}
					res.Docs++
					if res.First == nil {
						res.First = &n
					}
				} else {
					res.Groups++
				}
				if err := insert(&n.ID, in.children, 0); err != nil {
					return err
				}
			}
			return nil
		}
		if err := insert(parentID, roots, base); err != nil {
			return err
		}
		return touchRepo(tx, repoID, t)
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

// rawFileName is the file name as sent, keeping the directory part that
// multipart.Part.FileName strips.
func rawFileName(part *multipart.Part) string {
	if _, params, err := mime.ParseMediaType(part.Header.Get("Content-Disposition")); err == nil && params["filename"] != "" {
		return params["filename"]
	}
	return part.FileName()
}
