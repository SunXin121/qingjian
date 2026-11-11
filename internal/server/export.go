package server

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"regexp"
	"strings"
	"time"
)

var (
	// A drawing block: the fence may carry trailing spaces and CRLF line endings.
	reDrawing = regexp.MustCompile("(?s)```[ \\t]*(excalidraw|drawio|mindmap)[ \\t]*\\r?\\n(.*?)\\r?\\n[ \\t]*```")
	// Attachment links, relative (/files/id/name) or absolute (https://host/files/id/name).
	reFileRef = regexp.MustCompile(`(?:https?://[^/\s)"'<>]+)?/files/([0-9a-z]{20})(?:/[^)\s"'<>]*)?`)
	// Milkdown serializes preserved empty paragraphs as standalone HTML breaks.
	reEmptyParagraph = regexp.MustCompile(`(?i)^ {0,3}<br[ \t]*/?>[ \t]*$`)
	reQuotePrefix    = regexp.MustCompile(`^(?: {0,3}>[ \t]?)+`)
	reCodeFence      = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})(.*)$")
)

var drawingAlt = map[string]string{"excalidraw": "画板", "drawio": "流程图", "mindmap": "思维导图"}

// drawingRef is the JSON body of a drawing block: the editable source and its SVG preview,
// both stored as attachments.
type drawingRef struct {
	Scene string `json:"scene"`
	SVG   string `json:"svg"`
}

// portableMarkdown converts editor-only blocks into standard markdown:
// ```excalidraw|drawio|mindmap {"scene":..,"svg":..}``` → ![](svg url), and
// ```table {"table":..,"view":..}``` → a markdown table.
// Blocks without a rendered image (never-drawn drawings) are dropped: their JSON body
// means nothing outside the editor.
func (s *Server) portableMarkdown(md string) string {
	md = stripEmptyParagraphs(md)
	md = s.embedMarkdown(md)
	return reDrawing.ReplaceAllStringFunc(md, func(block string) string {
		m := reDrawing.FindStringSubmatch(block)
		var ref drawingRef
		if json.Unmarshal([]byte(strings.TrimSpace(m[2])), &ref) != nil {
			return block
		}
		if ref.SVG == "" {
			return ""
		}
		a, err := s.loadAttachment(ref.SVG)
		if err != nil {
			return ""
		}
		return "![" + drawingAlt[m[1]] + "](" + a.URL + ")"
	})
}

// stripEmptyParagraphs turns editor spacing placeholders into blank lines while
// preserving line endings, quote containers, inline breaks and code examples.
func stripEmptyParagraphs(md string) string {
	lines := strings.SplitAfter(md, "\n")
	var fence string
	for i, line := range lines {
		body := strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		prefix := reQuotePrefix.FindString(body)
		content := strings.TrimPrefix(body, prefix)
		if m := reCodeFence.FindStringSubmatch(content); m != nil {
			if fence == "" {
				// Backtick fence info strings cannot contain backticks.
				if m[1][0] != '`' || !strings.Contains(m[2], "`") {
					fence = m[1]
				}
			} else if m[1][0] == fence[0] && len(m[1]) >= len(fence) && strings.TrimSpace(m[2]) == "" {
				fence = ""
			}
			continue
		}
		if fence == "" && reEmptyParagraph.MatchString(content) {
			lines[i] = prefix + line[len(body):]
		}
	}
	return strings.Join(lines, "")
}

// exportBundle collects attachments referenced by exported documents so they can be
// written into the zip under assets/ with readable, unique file names — or, when
// exporting to the image host, links them to their uploaded copies instead.
type exportBundle struct {
	s      *Server
	paths  map[string]string // attachment id → zip path
	used   map[string]bool   // zip paths taken
	order  []string          // attachment ids in first-seen order
	nodes  map[string]string // exported node id → zip path (links between them become relative)
	remote map[string]string // attachment id → image host URL (set by uploadRemote)
}

func (s *Server) newExportBundle() *exportBundle {
	return &exportBundle{s: s, paths: map[string]string{}, used: map[string]bool{}}
}

// assetPath returns the zip path for an attachment, assigning one on first use.
func (b *exportBundle) assetPath(a *Attachment) string {
	if p, ok := b.paths[a.ID]; ok {
		return p
	}
	name := sanitizeName(nonEmpty(a.Name, a.ID))
	ext := path.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	p := "assets/" + name
	for i := 2; b.used[strings.ToLower(p)]; i++ {
		p = fmt.Sprintf("assets/%s-%d%s", stem, i, ext)
	}
	b.used[strings.ToLower(p)] = true
	b.paths[a.ID] = p
	b.order = append(b.order, a.ID)
	return p
}

// markdown turns a document into self-contained markdown for a file located `depth`
// folders below the zip root: drawings become images and every attachment link points
// at its copy under assets/.
func (b *exportBundle) markdown(md string, depth int) string {
	md = b.s.portableMarkdown(md)
	md = reFileRef.ReplaceAllStringFunc(md, func(ref string) string {
		id := reFileRef.FindStringSubmatch(ref)[1]
		if b.remote != nil {
			if link, ok := b.remote[id]; ok {
				return urlEscaper.Replace(link)
			}
			return ref
		}
		a, err := b.s.loadAttachment(id)
		if err != nil {
			return ref
		}
		return strings.Repeat("../", depth) + mdPathEscape(b.assetPath(a))
	})
	if len(b.nodes) == 0 {
		return md
	}
	// links to documents / tables exported alongside point at their files
	return reNodeLink.ReplaceAllStringFunc(md, func(link string) string {
		p, ok := b.nodes[reNodeLink.FindStringSubmatch(link)[1]]
		if !ok {
			return link
		}
		return "](" + strings.Repeat("../", depth) + mdPathEscape(p) + ")"
	})
}

// uploadRemote uploads every attachment the documents reference to the image host;
// markdown then links to the uploaded copies and nothing is written under assets/.
func (b *exportBundle) uploadRemote(ctx context.Context, docs []string) error {
	up, err := b.s.newImgbedUploader()
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	var atts []*Attachment
	for _, md := range docs {
		for _, m := range reFileRef.FindAllStringSubmatch(b.s.portableMarkdown(md), -1) {
			if seen[m[1]] {
				continue
			}
			seen[m[1]] = true
			if a, err := b.s.loadAttachment(m[1]); err == nil {
				atts = append(atts, a)
			}
		}
	}
	b.remote, err = up.uploadAll(ctx, atts)
	return err
}

// writeAssets copies every collected attachment into the zip.
func (b *exportBundle) writeAssets(zw *zip.Writer) {
	for _, id := range b.order {
		a, err := b.s.loadAttachment(id)
		if err != nil {
			continue
		}
		f, err := os.Open(b.s.blobPath(a.SHA256))
		if err != nil {
			continue
		}
		if fw, err := zw.CreateHeader(&zip.FileHeader{Name: b.paths[id], Method: zip.Deflate, Modified: time.UnixMilli(a.CreatedAt)}); err == nil {
			io.Copy(fw, f)
		}
		f.Close()
	}
}

// urlEscaper makes an absolute URL safe as a markdown link target.
var urlEscaper = strings.NewReplacer(" ", "%20", "(", "%28", ")", "%29", "<", "%3C", ">", "%3E")

// mdPathEscape escapes only what breaks a markdown link target, keeping CJK names readable.
func mdPathEscape(p string) string {
	return strings.NewReplacer("%", "%25", " ", "%20", "(", "%28", ")", "%29", "<", "%3C", ">", "%3E").Replace(p)
}

func writeZipText(zw *zip.Writer, name, text string, modified int64) {
	if fw, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: time.UnixMilli(modified)}); err == nil {
		io.WriteString(fw, text)
	}
}

func attachmentHeader(w http.ResponseWriter, filename string) {
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
}

// exportDoc streams a zip holding the document as markdown plus its images and
// attachments under assets/, linked relatively so it opens in any markdown editor.
// With ?imgbed=1 the files go to the image host and the response is the bare .md file.
func (s *Server) exportDoc(w http.ResponseWriter, r *http.Request) {
	d, err := s.loadDoc(r.PathValue("id"))
	if err != nil {
		httpError(w, 404, "文档不存在")
		return
	}
	base := sanitizeName(nonEmpty(d.Title, "未命名文档"))
	b := s.newExportBundle()
	if r.URL.Query().Get("imgbed") == "1" {
		if err := b.uploadRemote(r.Context(), []string{d.Markdown}); err != nil {
			httpError(w, 502, err.Error())
			return
		}
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": base + ".md"}))
		io.WriteString(w, b.markdown(d.Markdown, 0))
		return
	}
	md := b.markdown(d.Markdown, 0)

	attachmentHeader(w, base+".zip")
	zw := zip.NewWriter(w)
	defer zw.Close()
	writeZipText(zw, base+".md", md, d.ContentUpdatedAt)
	b.writeAssets(zw)
}

func nonEmpty(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

// exportRepo streams a zip: folders mirror the tree, attachments go to assets/ with
// links rewritten to relative paths (with ?imgbed=1: to the image host, no assets/).
func (s *Server) exportRepo(w http.ResponseWriter, r *http.Request) {
	repo, err := s.loadRepo(r.PathValue("id"))
	if err != nil {
		httpError(w, 404, "知识库不存在")
		return
	}
	nodes, err := s.treeNodes(repo.ID)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	children := map[string][]Node{}
	for _, n := range nodes {
		key := ""
		if n.ParentID != nil {
			key = *n.ParentID
		}
		children[key] = append(children[key], n)
	}

	b := s.newExportBundle()
	// file names first, so links between the exported documents can be made relative
	type entry struct {
		n    Node
		path string
	}
	var entries []entry
	b.nodes = map[string]string{}
	// "assets" is reserved at the root for attachments
	reserved := map[string]bool{"assets": true}
	var walk func(parent, dir string)
	walk = func(parent, dir string) {
		used := map[string]int{}
		for _, n := range children[parent] {
			base := sanitizeName(nonEmpty(n.Title, "未命名"))
			if dir == "" && reserved[strings.ToLower(base)] {
				base += "_"
			}
			if c := used[base]; c > 0 {
				base = fmt.Sprintf("%s (%d)", base, c+1)
			}
			used[base]++
			switch n.Type {
			case "doc":
				entries = append(entries, entry{n, dir + base + ".md"})
			case "table":
				entries = append(entries, entry{n, dir + base + ".csv"})
			}
			if p := len(entries); p > 0 && entries[p-1].n.ID == n.ID {
				b.nodes[n.ID] = entries[p-1].path
			}
			if len(children[n.ID]) > 0 {
				walk(n.ID, dir+base+"/")
			}
		}
	}
	walk("", "")

	docs := map[string]string{} // node id → markdown, loaded up front when uploading
	if r.URL.Query().Get("imgbed") == "1" {
		var mds []string
		for _, e := range entries {
			if e.n.Type == "doc" {
				if d, err := s.loadDoc(e.n.ID); err == nil {
					docs[e.n.ID] = d.Markdown
					mds = append(mds, d.Markdown)
				}
			}
		}
		if err := b.uploadRemote(r.Context(), mds); err != nil {
			httpError(w, 502, err.Error())
			return
		}
	}

	attachmentHeader(w, sanitizeName(repo.Name)+".zip")
	zw := zip.NewWriter(w)
	defer zw.Close()
	for _, e := range entries {
		switch e.n.Type {
		case "doc":
			md, ok := docs[e.n.ID]
			if !ok {
				d, err := s.loadDoc(e.n.ID)
				if err != nil {
					continue
				}
				md = d.Markdown
			}
			writeZipText(zw, e.path, b.markdown(md, strings.Count(e.path, "/")), e.n.UpdatedAt)
		case "table":
			if t, err := s.loadTableData(s.db, e.n.ID); err == nil {
				writeZipText(zw, e.path, s.withLinked(t).csv(), e.n.UpdatedAt)
			}
		}
	}
	b.writeAssets(zw)
}
