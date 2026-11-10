package server

import (
	"archive/zip"
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
)

var drawingAlt = map[string]string{"excalidraw": "画板", "drawio": "流程图", "mindmap": "思维导图"}

// drawingRef is the JSON body of a drawing block: the editable source and its SVG preview,
// both stored as attachments.
type drawingRef struct {
	Scene string `json:"scene"`
	SVG   string `json:"svg"`
}

// portableMarkdown converts editor-only blocks into standard markdown:
// ```excalidraw|drawio|mindmap {"scene":..,"svg":..}``` → ![](svg url).
// Blocks without a rendered image (never-drawn drawings) are dropped: their JSON body
// means nothing outside the editor.
func (s *Server) portableMarkdown(md string) string {
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

// exportBundle collects attachments referenced by exported documents so they can be
// written into the zip under assets/ with readable, unique file names.
type exportBundle struct {
	s     *Server
	paths map[string]string // attachment id → zip path
	used  map[string]bool   // zip paths taken
	order []string          // attachment ids in first-seen order
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
	return reFileRef.ReplaceAllStringFunc(md, func(ref string) string {
		a, err := b.s.loadAttachment(reFileRef.FindStringSubmatch(ref)[1])
		if err != nil {
			return ref
		}
		return strings.Repeat("../", depth) + mdPathEscape(b.assetPath(a))
	})
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
func (s *Server) exportDoc(w http.ResponseWriter, r *http.Request) {
	d, err := s.loadDoc(r.PathValue("id"))
	if err != nil {
		httpError(w, 404, "文档不存在")
		return
	}
	base := sanitizeName(nonEmpty(d.Title, "未命名文档"))
	b := s.newExportBundle()
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
// links rewritten to relative paths.
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

	attachmentHeader(w, sanitizeName(repo.Name)+".zip")
	zw := zip.NewWriter(w)
	defer zw.Close()

	b := s.newExportBundle()
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
			if n.Type == "doc" {
				if d, err := s.loadDoc(n.ID); err == nil {
					writeZipText(zw, dir+base+".md", b.markdown(d.Markdown, strings.Count(dir, "/")), n.UpdatedAt)
				}
			}
			if len(children[n.ID]) > 0 {
				walk(n.ID, dir+base+"/")
			}
		}
	}
	walk("", "")
	b.writeAssets(zw)
}
