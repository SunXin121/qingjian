package server

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"strings"
	"time"
)

var (
	reExcalidraw = regexp.MustCompile("(?s)```excalidraw\\n(.*?)\\n```")
	reFileRef    = regexp.MustCompile(`/files/([0-9a-z]{20})(?:/[^)\s"'>]*)?`)
)

type drawingRef struct {
	Scene string `json:"scene"`
	SVG   string `json:"svg"`
}

// portableMarkdown converts editor-only blocks into standard markdown:
// ```excalidraw {"scene":..,"svg":..}``` → ![](svg url)
func (s *Server) portableMarkdown(md string) string {
	return reExcalidraw.ReplaceAllStringFunc(md, func(block string) string {
		m := reExcalidraw.FindStringSubmatch(block)
		var ref drawingRef
		if json.Unmarshal([]byte(m[1]), &ref) != nil || ref.SVG == "" {
			return block
		}
		a, err := s.loadAttachment(ref.SVG)
		if err != nil {
			return block
		}
		return "![画板](" + a.URL + ")"
	})
}

func (s *Server) exportDoc(w http.ResponseWriter, r *http.Request) {
	d, err := s.loadDoc(r.PathValue("id"))
	if err != nil {
		httpError(w, 404, "文档不存在")
		return
	}
	md := s.portableMarkdown(d.Markdown)
	name := sanitizeName(nonEmpty(d.Title, "未命名文档")) + ".md"
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	io.WriteString(w, md)
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

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": sanitizeName(repo.Name) + ".zip"}))
	zw := zip.NewWriter(w)
	defer zw.Close()

	assets := map[string]string{} // attachment id → zip path
	var walk func(parent, dir string)
	walk = func(parent, dir string) {
		used := map[string]int{}
		for _, n := range children[parent] {
			base := sanitizeName(nonEmpty(n.Title, "未命名"))
			if c := used[base]; c > 0 {
				base = fmt.Sprintf("%s (%d)", base, c+1)
			}
			used[base]++
			if n.Type == "doc" {
				d, err := s.loadDoc(n.ID)
				if err == nil {
					md := s.portableMarkdown(d.Markdown)
					depth := strings.Count(dir, "/")
					md = reFileRef.ReplaceAllStringFunc(md, func(ref string) string {
						id := reFileRef.FindStringSubmatch(ref)[1]
						a, err := s.loadAttachment(id)
						if err != nil {
							return ref
						}
						p, ok := assets[id]
						if !ok {
							p = "assets/" + id + "-" + a.Name
							assets[id] = p
						}
						return strings.Repeat("../", depth) + (&url.URL{Path: p}).EscapedPath()
					})
					if fw, err := zw.CreateHeader(&zip.FileHeader{Name: dir + base + ".md", Method: zip.Deflate, Modified: time.UnixMilli(n.UpdatedAt)}); err == nil {
						io.WriteString(fw, md)
					}
				}
			}
			if len(children[n.ID]) > 0 {
				walk(n.ID, dir+base+"/")
			}
		}
	}
	walk("", "")

	for id, p := range assets {
		a, err := s.loadAttachment(id)
		if err != nil {
			continue
		}
		f, err := os.Open(s.blobPath(a.SHA256))
		if err != nil {
			continue
		}
		if fw, err := zw.CreateHeader(&zip.FileHeader{Name: path.Clean(p), Method: zip.Deflate, Modified: time.UnixMilli(a.CreatedAt)}); err == nil {
			io.Copy(fw, f)
		}
		f.Close()
	}
}
