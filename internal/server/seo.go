package server

import (
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io/fs"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	reStripCodeFence = regexp.MustCompile("(?s)```.*?```|~~~.*?~~~")
	reStripImage     = regexp.MustCompile(`!\[([^\]]*)\]\(([^)]+)\)`)
	reFirstImage     = regexp.MustCompile(`!\[[^\]]*\]\((/files/[0-9a-z]{20}/[^)\s"']+)\)`)
	reStripHTMLTag   = regexp.MustCompile(`<[^>]+>`)
	reMultiSpace     = regexp.MustCompile(`\s+`)
)

func (s *Server) requestOrigin(r *http.Request) string {
	scheme := "http"
	if s.isSecure(r) {
		scheme = "https"
	}
	host := r.Host
	if fh := r.Header.Get("X-Forwarded-Host"); s.cfg.TrustProxy && fh != "" {
		host = fh
	}
	if host == "" {
		host = "localhost"
	}
	return scheme + "://" + host
}

// prefersMarkdown reports whether an HTTP client explicitly asked for Markdown via query or Accept.
// Browsers send Accept: text/html,application/xhtml+xml,... and get the SPA HTML.
func prefersMarkdown(r *http.Request) bool {
	if f := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format"))); f == "md" || f == "markdown" {
		return true
	}
	if r.URL.Query().Get("raw") == "1" {
		return true
	}
	accept := strings.ToLower(r.Header.Get("Accept"))
	if accept == "" || !strings.Contains(accept, "text/markdown") {
		return false
	}
	// Compare quality weights if both text/html and text/markdown are listed.
	mdQ, htmlQ := acceptQuality(accept, "text/markdown"), acceptQuality(accept, "text/html")
	return mdQ > 0 && mdQ >= htmlQ
}

func acceptQuality(accept, media string) float64 {
	best := 0.0
	for _, part := range strings.Split(accept, ",") {
		seg := strings.TrimSpace(part)
		name, params, _ := strings.Cut(seg, ";")
		if strings.TrimSpace(name) != media {
			continue
		}
		q := 1.0
		for _, p := range strings.Split(params, ";") {
			k, v, ok := strings.Cut(strings.TrimSpace(p), "=")
			if ok && strings.TrimSpace(k) == "q" {
				if parsed, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
					q = parsed
				}
			}
		}
		if q > best {
			best = q
		}
	}
	return best
}

func writeMarkdown(w http.ResponseWriter, sh *Share, md string) {
	if sh != nil && sh.publicIndexable() {
		w.Header().Set("X-Robots-Tag", "index, follow")
	} else {
		w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	}
	w.Header().Set("Vary", "Accept")
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	// Rough token estimate (~2.5 chars/token mixed CJK & English) for LLM context budgeting
	tokens := max(1, (utf8.RuneCountInString(md)*2+4)/5)
	w.Header().Set("X-Markdown-Tokens", strconv.Itoa(tokens))
	_, _ = w.Write([]byte(md))
}

func yamlQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func markdownExcerpt(md string, maxRunes int) string {
	s := stripEmptyParagraphs(md)
	s = reStripCodeFence.ReplaceAllString(s, " ")
	s = reStripImage.ReplaceAllString(s, "$1")
	s = reMdLink.ReplaceAllString(s, "$1")
	s = reStripHTMLTag.ReplaceAllString(s, " ")
	lines := strings.Split(s, "\n")
	cleaned := make([]string, 0, len(lines))
	for _, ln := range lines {
		ln = strings.TrimSpace(reLineMark.ReplaceAllString(ln, ""))
		ln = strings.NewReplacer("**", "", "__", "", "~~", "", "`", "", "|", " ").Replace(ln)
		if ln != "" && !strings.HasPrefix(ln, "---") && !strings.HasPrefix(ln, "[!") {
			cleaned = append(cleaned, ln)
		}
	}
	joined := strings.TrimSpace(reMultiSpace.ReplaceAllString(strings.Join(cleaned, " "), " "))
	runes := []rune(joined)
	if len(runes) > maxRunes {
		return strings.TrimSpace(string(runes[:maxRunes])) + "…"
	}
	return joined
}

func attachLinkedContext(t *TableData, linked map[string]*TableData) {
	all := map[string]*TableData{t.ID: t}
	for id, lt := range linked {
		all[id] = lt
	}
	for _, x := range all {
		x.ctx = all
	}
}

// sharePortableMarkdown converts editor-specific blocks into clean portable Markdown while
// strictly enforcing the share's scope and view restrictions on embedded tables and internal links.
func (s *Server) sharePortableMarkdown(sh *Share, md string, linkSuffix string) string {
	md = stripEmptyParagraphs(md)
	md = reTableEmbed.ReplaceAllStringFunc(md, func(block string) string {
		m := reTableEmbed.FindStringSubmatch(block)
		var e tableEmbed
		if json.Unmarshal([]byte(strings.TrimSpace(m[1])), &e) != nil || e.Table == "" {
			return ""
		}
		t, err := s.loadTableData(s.db, e.Table)
		if err != nil {
			return ""
		}
		viewID, restricted, err := s.sharedTableView(sh, t, e.View)
		if err != nil {
			return ""
		}
		if restricted && restrictShareView(t, viewID) != nil {
			return ""
		}
		if linked := s.linkedTables(s.db, t); len(linked) > 0 {
			if s.restrictLinkedShare(sh, linked) != nil {
				return ""
			}
			trimLinked(t, linked)
			attachLinkedContext(t, linked)
		}
		title := nonEmpty(t.Title, "未命名表格")
		return "**" + title + "**\n\n" + t.markdown(viewID)
	})
	md = reDrawing.ReplaceAllStringFunc(md, func(block string) string {
		m := reDrawing.FindStringSubmatch(block)
		var ref drawingRef
		if json.Unmarshal([]byte(strings.TrimSpace(m[2])), &ref) != nil || ref.SVG == "" {
			return ""
		}
		a, err := s.loadAttachment(ref.SVG)
		if err != nil {
			return ""
		}
		return "![" + drawingAlt[m[1]] + "](" + a.URL + ")"
	})
	if sh.TargetType == "repo" || sh.NodeType == "group" {
		md = reNodeLink.ReplaceAllStringFunc(md, func(link string) string {
			id := reNodeLink.FindStringSubmatch(link)[1]
			if !s.shareCovers(sh, id) {
				return link
			}
			return "](/s/" + sh.Token + "/" + id + linkSuffix + ")"
		})
	}
	return strings.TrimSpace(md)
}

func (s *Server) renderSharedTableMarkdown(sh *Share, tableID string, queryView string) (title string, updatedAt int64, body string, err error) {
	t, err := s.loadTableData(s.db, tableID)
	if err != nil {
		return "", 0, "", err
	}
	viewID, restricted, err := s.sharedTableView(sh, t, queryView)
	if err != nil {
		return "", 0, "", err
	}
	if restricted {
		if err := restrictShareView(t, viewID); err != nil {
			return "", 0, "", err
		}
	}
	if linked := s.linkedTables(s.db, t); len(linked) > 0 {
		if err := s.restrictLinkedShare(sh, linked); err != nil {
			return "", 0, "", err
		}
		trimLinked(t, linked)
		attachLinkedContext(t, linked)
	}
	return nonEmpty(t.Title, "未命名表格"), t.UpdatedAt, t.markdown(viewID), nil
}

func (s *Server) shareTreeNodes(sh *Share) ([]publicNode, error) {
	nodes, err := s.treeNodes(sh.RepoID)
	if err != nil {
		return nil, err
	}
	if sh.TargetType == "node" && sh.NodeType == "group" {
		nodes = subtree(nodes, sh.TargetID)
	}
	out := make([]publicNode, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, publicNode{n.ID, n.ParentID, n.Type, n.Title, n.Sort, n.UpdatedAt})
	}
	return out, nil
}

func shareNodeDisplayTitle(typ, title string) string {
	if t := strings.TrimSpace(title); t != "" {
		return t
	}
	switch typ {
	case "group":
		return "未命名分组"
	case "table":
		return "未命名表格"
	default:
		return "无标题文档"
	}
}

func (s *Server) buildShareMarkdown(r *http.Request, sh *Share, itemID string) (string, int, string) {
	origin := s.requestOrigin(r)
	isCollection := sh.TargetType == "repo" || sh.NodeType == "group"
	if itemID == "" && !isCollection {
		itemID = sh.TargetID
	}
	if itemID != "" {
		if !s.shareCovers(sh, itemID) {
			return "", http.StatusNotFound, "文档不存在"
		}
		n, err := s.loadNode(s.db, itemID)
		if err != nil {
			return "", http.StatusNotFound, "文档不存在"
		}
		switch n.Type {
		case "doc":
			d, err := s.loadDoc(itemID)
			if err != nil {
				return "", http.StatusNotFound, "文档不存在"
			}
			title := shareNodeDisplayTitle("doc", d.Title)
			canonical := origin + "/s/" + sh.Token
			if isCollection {
				canonical += "/" + d.ID
			}
			body := s.sharePortableMarkdown(sh, d.Markdown, ".md")
			var b strings.Builder
			b.WriteString("---\n")
			b.WriteString("title: " + yamlQuote(title) + "\n")
			b.WriteString("type: document\n")
			b.WriteString("updated_at: " + yamlQuote(time.UnixMilli(d.ContentUpdatedAt).UTC().Format(time.RFC3339)) + "\n")
			b.WriteString("url: " + yamlQuote(canonical) + "\n")
			b.WriteString("---\n\n")
			b.WriteString("# " + title + "\n\n")
			if body != "" {
				b.WriteString(body + "\n")
			}
			return b.String(), http.StatusOK, ""
		case "table":
			title, updatedAt, tblMd, err := s.renderSharedTableMarkdown(sh, itemID, r.URL.Query().Get("view"))
			if errors.Is(err, errShareView) {
				return "", http.StatusUnprocessableEntity, errShareView.Error()
			} else if err != nil {
				return "", http.StatusNotFound, "表格不存在"
			}
			canonical := origin + "/s/" + sh.Token
			if isCollection {
				canonical += "/" + itemID
			}
			var b strings.Builder
			b.WriteString("---\n")
			b.WriteString("title: " + yamlQuote(title) + "\n")
			b.WriteString("type: table\n")
			b.WriteString("updated_at: " + yamlQuote(time.UnixMilli(updatedAt).UTC().Format(time.RFC3339)) + "\n")
			b.WriteString("url: " + yamlQuote(canonical) + "\n")
			b.WriteString("---\n\n")
			b.WriteString("# " + title + "\n\n")
			b.WriteString(tblMd + "\n")
			return b.String(), http.StatusOK, ""
		default:
			return "", http.StatusNotFound, "文档不存在"
		}
	}

	// Collection root (repo or group)
	name := sh.Title
	desc := ""
	updatedAt := sh.UpdatedAt
	if sh.TargetType == "repo" {
		if repo, err := s.loadRepo(sh.TargetID); err == nil {
			name = repo.Name
			desc = repo.Description
			updatedAt = repo.UpdatedAt
		}
	}
	if strings.TrimSpace(name) == "" {
		if sh.TargetType == "repo" {
			name = "未命名知识库"
		} else {
			name = "未命名分组"
		}
	}
	nodes, err := s.shareTreeNodes(sh)
	if err != nil {
		return "", http.StatusInternalServerError, "服务器内部错误"
	}
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("title: " + yamlQuote(name) + "\n")
	b.WriteString("type: " + yamlQuote(sh.TargetType) + "\n")
	b.WriteString("updated_at: " + yamlQuote(time.UnixMilli(updatedAt).UTC().Format(time.RFC3339)) + "\n")
	b.WriteString("url: " + yamlQuote(origin+"/s/"+sh.Token) + "\n")
	b.WriteString("llms_txt: " + yamlQuote(origin+"/s/"+sh.Token+"/llms.txt") + "\n")
	b.WriteString("llms_full_txt: " + yamlQuote(origin+"/s/"+sh.Token+"/llms-full.txt") + "\n")
	b.WriteString("---\n\n")
	b.WriteString("# " + name + "\n\n")
	if strings.TrimSpace(desc) != "" {
		b.WriteString("> " + strings.ReplaceAll(strings.TrimSpace(desc), "\n", "\n> ") + "\n\n")
	}
	b.WriteString("## 目录\n\n")
	writeShareTreeMarkdown(&b, nodes, origin+"/s/"+sh.Token)
	return b.String(), http.StatusOK, ""
}

func writeShareTreeMarkdown(b *strings.Builder, nodes []publicNode, shareBase string) {
	kids := map[string][]publicNode{}
	for _, n := range nodes {
		p := ""
		if n.ParentID != nil {
			p = *n.ParentID
		}
		kids[p] = append(kids[p], n)
	}
	if len(nodes) == 0 {
		b.WriteString("_暂无内容_\n")
		return
	}
	var walk func(parent string, depth int)
	walk = func(parent string, depth int) {
		indent := strings.Repeat("  ", depth)
		for _, n := range kids[parent] {
			title := shareNodeDisplayTitle(n.Type, n.Title)
			if n.Type == "group" {
				b.WriteString(fmt.Sprintf("%s- **%s**（分组）\n", indent, title))
			} else {
				kind := ""
				if n.Type == "table" {
					kind = "（多维表格）"
				}
				b.WriteString(fmt.Sprintf("%s- [%s](%s/%s.md)%s\n", indent, title, shareBase, n.ID, kind))
			}
			walk(n.ID, depth+1)
		}
	}
	walk("", 0)
}

func (s *Server) shareRootMarkdownAPI(w http.ResponseWriter, r *http.Request) {
	sh := s.activeShare(w, r, true)
	if sh == nil {
		return
	}
	md, status, msg := s.buildShareMarkdown(r, sh, "")
	if status != http.StatusOK {
		httpError(w, status, msg)
		return
	}
	writeMarkdown(w, sh, md)
}

func (s *Server) shareNodeMarkdownAPI(w http.ResponseWriter, r *http.Request) {
	sh := s.activeShare(w, r, true)
	if sh == nil {
		return
	}
	md, status, msg := s.buildShareMarkdown(r, sh, r.PathValue("id"))
	if status != http.StatusOK {
		httpError(w, status, msg)
		return
	}
	writeMarkdown(w, sh, md)
}

// shareLLMsTxt implements the llms.txt convention for a shared repo, folder, doc or table.
func (s *Server) shareLLMsTxt(w http.ResponseWriter, r *http.Request) {
	sh := s.activeShare(w, r, true)
	if sh == nil {
		return
	}
	origin := s.requestOrigin(r)
	shareBase := origin + "/s/" + sh.Token
	var b strings.Builder
	isCollection := sh.TargetType == "repo" || sh.NodeType == "group"
	if isCollection {
		name := sh.Title
		desc := "由青简（Qingjian）分享的知识库目录索引。"
		if sh.TargetType == "repo" {
			if repo, err := s.loadRepo(sh.TargetID); err == nil {
				name = nonEmpty(repo.Name, "未命名知识库")
				if strings.TrimSpace(repo.Description) != "" {
					desc = strings.TrimSpace(repo.Description)
				}
			}
		} else {
			name = nonEmpty(name, "未命名分组")
		}
		b.WriteString("# " + name + "\n\n")
		b.WriteString("> " + strings.ReplaceAll(desc, "\n", " ") + "\n\n")
		b.WriteString("支持在任意文档链接后附加 `.md` 或携带 `Accept: text/markdown` 请求头获取纯 Markdown 原文；完整合并上下文请访问 `" + shareBase + "/llms-full.txt`。\n\n")
		b.WriteString("## 文档与表格\n\n")
		nodes, err := s.shareTreeNodes(sh)
		if err != nil {
			serverError(w, r, err)
			return
		}
		writeShareTreeMarkdown(&b, nodes, shareBase)
	} else {
		title := shareNodeDisplayTitle(sh.NodeType, sh.Title)
		b.WriteString("# " + title + "\n\n")
		b.WriteString("> 由青简（Qingjian）分享的只读内容。\n\n")
		b.WriteString("## 内容原文\n\n")
		b.WriteString(fmt.Sprintf("- [%s](%s.md)\n", title, shareBase))
	}
	writeMarkdown(w, sh, b.String())
}

// shareLLMsFullTxt concatenates every document and table in the share into one LLM-ready Markdown stream.
func (s *Server) shareLLMsFullTxt(w http.ResponseWriter, r *http.Request) {
	sh := s.activeShare(w, r, true)
	if sh == nil {
		return
	}
	if sh.TargetType != "repo" && sh.NodeType != "group" {
		md, status, msg := s.buildShareMarkdown(r, sh, sh.TargetID)
		if status != http.StatusOK {
			httpError(w, status, msg)
			return
		}
		writeMarkdown(w, sh, md)
		return
	}
	origin := s.requestOrigin(r)
	shareBase := origin + "/s/" + sh.Token
	nodes, err := s.shareTreeNodes(sh)
	if err != nil {
		serverError(w, r, err)
		return
	}
	name := nonEmpty(sh.Title, "知识库")
	if sh.TargetType == "repo" {
		if repo, err := s.loadRepo(sh.TargetID); err == nil {
			name = nonEmpty(repo.Name, name)
		}
	}
	var b strings.Builder
	b.WriteString("# " + name + "（完整上下文）\n\n")
	b.WriteString("> 来源：" + shareBase + "\n\n")

	kids := map[string][]publicNode{}
	for _, n := range nodes {
		p := ""
		if n.ParentID != nil {
			p = *n.ParentID
		}
		kids[p] = append(kids[p], n)
	}
	var walk func(parent string, pathPrefix []string)
	walk = func(parent string, pathPrefix []string) {
		for _, n := range kids[parent] {
			title := shareNodeDisplayTitle(n.Type, n.Title)
			curPath := append(append([]string{}, pathPrefix...), title)
			if n.Type == "doc" {
				if d, err := s.loadDoc(n.ID); err == nil {
					b.WriteString("\n---\n\n")
					b.WriteString("## " + strings.Join(curPath, " / ") + "\n\n")
					b.WriteString("URL: " + shareBase + "/" + n.ID + "\n\n")
					body := s.sharePortableMarkdown(sh, d.Markdown, ".md")
					if body != "" {
						b.WriteString(body + "\n")
					}
				}
			} else if n.Type == "table" {
				if _, _, tblMd, err := s.renderSharedTableMarkdown(sh, n.ID, ""); err == nil {
					b.WriteString("\n---\n\n")
					b.WriteString("## " + strings.Join(curPath, " / ") + "（多维表格）\n\n")
					b.WriteString("URL: " + shareBase + "/" + n.ID + "\n\n")
					b.WriteString(tblMd + "\n")
				}
			}
			walk(n.ID, curPath)
		}
	}
	walk("", nil)
	writeMarkdown(w, sh, b.String())
}

// serveShareRoute handles /s/{token}, /s/{token}.md, /s/{token}/{id}, and /s/{token}/{id}.md.
// For Agents (Accept: text/markdown, ?format=md, or .md suffix) it serves clean Markdown;
// for browsers and crawlers it serves index.html enriched with dynamic SEO / Open Graph / JSON-LD metadata.
func (s *Server) serveShareRoute(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(r.PathValue("rest"), "/")
	if rest == "" {
		s.serveStatic(w, r)
		return
	}
	parts := strings.Split(rest, "/")
	if len(parts) > 2 {
		s.serveStatic(w, r)
		return
	}
	token := parts[0]
	itemID := ""
	wantMD := prefersMarkdown(r)
	if len(parts) == 2 && (parts[1] == "llms.txt" || parts[1] == "llms-full.txt") {
		r.SetPathValue("token", token)
		if parts[1] == "llms.txt" {
			s.shareLLMsTxt(w, r)
		} else {
			s.shareLLMsFullTxt(w, r)
		}
		return
	}
	if len(parts) == 1 && strings.HasSuffix(token, ".md") {
		token = strings.TrimSuffix(token, ".md")
		wantMD = true
	} else if len(parts) == 2 {
		itemID = parts[1]
		if strings.HasSuffix(itemID, ".md") {
			itemID = strings.TrimSuffix(itemID, ".md")
			wantMD = true
		}
	}

	if wantMD {
		r.SetPathValue("token", token)
		sh := s.activeShare(w, r, true)
		if sh == nil {
			return
		}
		md, status, msg := s.buildShareMarkdown(r, sh, itemID)
		if status != http.StatusOK {
			httpError(w, status, msg)
			return
		}
		writeMarkdown(w, sh, md)
		return
	}

	s.serveShareHTML(w, r, token, itemID)
}

type shareSEOMeta struct {
	Title         string
	Description   string
	CanonicalURL  string
	AlternateMD   string
	AlternateLLMs string
	OGType        string
	OGImage       string
	ModifiedISO   string
	Robots        string
	JSONLD        string
	NoscriptHTML  string
}

func (s *Server) buildShareSEOMeta(r *http.Request, token, itemID string) shareSEOMeta {
	origin := s.requestOrigin(r)
	canonical := origin + "/s/" + html.EscapeString(token)
	if itemID != "" {
		canonical += "/" + html.EscapeString(itemID)
	}
	fallback := shareSEOMeta{
		Title:        "青简 Qingjian",
		Description:  "由青简（Qingjian）提供的在线知识库分享页面。",
		CanonicalURL: canonical,
		OGType:       "website",
		OGImage:      origin + "/icon-512.png",
		Robots:       "noindex, nofollow",
	}

	sh, err := s.loadShare(token)
	if err != nil || !sh.Enabled || !sh.TargetAlive || sh.expired() {
		fallback.Title = "分享不可用 - 青简"
		fallback.Description = "该分享链接不存在、已关闭或已过期。"
		return fallback
	}
	// Never leak any title or content metadata for password-protected shares.
	if sh.HasPassword {
		fallback.Title = "受密码保护的分享 - 青简"
		fallback.Description = "此分享内容受访问密码保护，请输入密码后查看。"
		return fallback
	}

	robots := "noindex, nofollow"
	if sh.publicIndexable() {
		robots = "index, follow"
	}

	isCollection := sh.TargetType == "repo" || sh.NodeType == "group"
	targetNodeID := itemID
	if targetNodeID == "" && !isCollection {
		targetNodeID = sh.TargetID
	}

	if targetNodeID != "" && s.shareCovers(sh, targetNodeID) {
		if n, err := s.loadNode(s.db, targetNodeID); err == nil {
			switch n.Type {
			case "doc":
				if d, err := s.loadDoc(targetNodeID); err == nil {
					title := shareNodeDisplayTitle("doc", d.Title)
					desc := markdownExcerpt(d.Markdown, 155)
					if desc == "" {
						desc = title + " — 由青简知识库分享的文档。"
					}
					ogImg := origin + "/icon-512.png"
					if m := reFirstImage.FindStringSubmatch(d.Markdown); m != nil {
						ogImg = origin + m[1]
					}
					modISO := time.UnixMilli(d.ContentUpdatedAt).UTC().Format(time.RFC3339)
					altMD := "/s/" + sh.Token + ".md"
					if isCollection {
						altMD = "/s/" + sh.Token + "/" + d.ID + ".md"
					}
					altLLMs := ""
					if isCollection {
						altLLMs = "/s/" + sh.Token + "/llms.txt"
					}
					ld, _ := json.Marshal(map[string]any{
						"@context":         "https://schema.org",
						"@type":            "Article",
						"headline":         title,
						"description":      desc,
						"dateModified":     modISO,
						"mainEntityOfPage": canonical,
						"publisher": map[string]any{
							"@type": "Organization",
							"name":  "青简 Qingjian",
						},
					})
					ns := fmt.Sprintf(
						`<noscript><main style="max-width:760px;margin:40px auto;padding:0 20px;font-family:system-ui,sans-serif;line-height:1.7"><article><h1>%s</h1><p>%s</p><p><a href="%s">查看 Markdown 原文</a></p></article></main></noscript>`,
						html.EscapeString(title),
						html.EscapeString(desc),
						html.EscapeString(altMD),
					)
					return shareSEOMeta{
						Title:         title + " - 青简",
						Description:   desc,
						CanonicalURL:  canonical,
						AlternateMD:   altMD,
						AlternateLLMs: altLLMs,
						OGType:        "article",
						OGImage:       ogImg,
						ModifiedISO:   modISO,
						Robots:        robots,
						JSONLD:        string(ld),
						NoscriptHTML:  ns,
					}
				}
			case "table":
				title := shareNodeDisplayTitle("table", n.Title)
				desc := title + " — 由青简知识库分享的多维表格。"
				modISO := time.UnixMilli(n.UpdatedAt).UTC().Format(time.RFC3339)
				altMD := "/s/" + sh.Token + ".md"
				if isCollection {
					altMD = "/s/" + sh.Token + "/" + n.ID + ".md"
				}
				ld, _ := json.Marshal(map[string]any{
					"@context":     "https://schema.org",
					"@type":        "Dataset",
					"name":         title,
					"description":  desc,
					"dateModified": modISO,
					"url":          canonical,
				})
				ns := fmt.Sprintf(
					`<noscript><main style="max-width:760px;margin:40px auto;padding:0 20px;font-family:system-ui,sans-serif;line-height:1.7"><article><h1>%s</h1><p>%s</p><p><a href="%s">查看 Markdown 表格原文</a></p></article></main></noscript>`,
					html.EscapeString(title),
					html.EscapeString(desc),
					html.EscapeString(altMD),
				)
				return shareSEOMeta{
					Title:        title + " - 青简",
					Description:  desc,
					CanonicalURL: canonical,
					AlternateMD:  altMD,
					OGType:       "article",
					OGImage:      origin + "/icon-512.png",
					ModifiedISO:  modISO,
					Robots:       robots,
					JSONLD:       string(ld),
					NoscriptHTML: ns,
				}
			}
		}
	}

	if isCollection {
		name := sh.Title
		desc := ""
		updatedAt := sh.UpdatedAt
		if sh.TargetType == "repo" {
			if repo, err := s.loadRepo(sh.TargetID); err == nil {
				name = repo.Name
				desc = strings.TrimSpace(repo.Description)
				updatedAt = repo.UpdatedAt
			}
			name = nonEmpty(name, "未命名知识库")
		} else {
			name = nonEmpty(name, "未命名分组")
		}
		nodes, _ := s.shareTreeNodes(sh)
		docCount := 0
		var linksHTML strings.Builder
		for _, n := range nodes {
			if n.Type == "doc" || n.Type == "table" {
				docCount++
				if docCount <= 50 {
					t := shareNodeDisplayTitle(n.Type, n.Title)
					linksHTML.WriteString(fmt.Sprintf(`<li><a href="/s/%s/%s">%s</a></li>`, html.EscapeString(sh.Token), html.EscapeString(n.ID), html.EscapeString(t)))
				}
			}
		}
		if desc == "" {
			desc = fmt.Sprintf("%s — 共包含 %d 篇公开文档与表格，由青简知识库分享。", name, docCount)
		}
		modISO := time.UnixMilli(updatedAt).UTC().Format(time.RFC3339)
		ld, _ := json.Marshal(map[string]any{
			"@context":     "https://schema.org",
			"@type":        "CollectionPage",
			"name":         name,
			"description":  desc,
			"dateModified": modISO,
			"url":          canonical,
		})
		ns := fmt.Sprintf(
			`<noscript><main style="max-width:760px;margin:40px auto;padding:0 20px;font-family:system-ui,sans-serif;line-height:1.7"><h1>%s</h1><p>%s</p><p><a href="/s/%s/llms.txt">llms.txt 索引</a> · <a href="/s/%s.md">Markdown 目录</a></p><ul>%s</ul></main></noscript>`,
			html.EscapeString(name),
			html.EscapeString(desc),
			html.EscapeString(sh.Token),
			html.EscapeString(sh.Token),
			linksHTML.String(),
		)
		return shareSEOMeta{
			Title:         name + " - 青简",
			Description:   desc,
			CanonicalURL:  canonical,
			AlternateMD:   "/s/" + sh.Token + ".md",
			AlternateLLMs: "/s/" + sh.Token + "/llms.txt",
			OGType:        "website",
			OGImage:       origin + "/icon-512.png",
			ModifiedISO:   modISO,
			Robots:        robots,
			JSONLD:        string(ld),
			NoscriptHTML:  ns,
		}
	}

	return fallback
}

func (s *Server) serveShareHTML(w http.ResponseWriter, r *http.Request, token, itemID string) {
	if s.static == nil {
		http.NotFound(w, r)
		return
	}
	raw, err := fs.ReadFile(s.static, "index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	meta := s.buildShareSEOMeta(r, token, itemID)
	w.Header().Set("X-Robots-Tag", meta.Robots)
	w.Header().Set("Vary", "Accept")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Security-Policy", s.pageCSP())
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	page := string(raw)
	page = strings.Replace(page, `<meta name="robots" content="noindex, nofollow" />`, `<meta name="robots" content="`+html.EscapeString(meta.Robots)+`" />`, 1)

	var headExtra strings.Builder
	headExtra.WriteString("<title>" + html.EscapeString(meta.Title) + "</title>\n")
	headExtra.WriteString(`    <meta name="description" content="` + html.EscapeString(meta.Description) + `" />` + "\n")
	headExtra.WriteString(`    <link rel="canonical" href="` + html.EscapeString(meta.CanonicalURL) + `" />` + "\n")
	headExtra.WriteString(`    <meta property="og:site_name" content="青简 Qingjian" />` + "\n")
	headExtra.WriteString(`    <meta property="og:locale" content="zh_CN" />` + "\n")
	headExtra.WriteString(`    <meta property="og:type" content="` + html.EscapeString(meta.OGType) + `" />` + "\n")
	headExtra.WriteString(`    <meta property="og:title" content="` + html.EscapeString(meta.Title) + `" />` + "\n")
	headExtra.WriteString(`    <meta property="og:description" content="` + html.EscapeString(meta.Description) + `" />` + "\n")
	headExtra.WriteString(`    <meta property="og:url" content="` + html.EscapeString(meta.CanonicalURL) + `" />` + "\n")
	if meta.OGImage != "" {
		headExtra.WriteString(`    <meta property="og:image" content="` + html.EscapeString(meta.OGImage) + `" />` + "\n")
	}
	if meta.ModifiedISO != "" && meta.OGType == "article" {
		headExtra.WriteString(`    <meta property="article:modified_time" content="` + html.EscapeString(meta.ModifiedISO) + `" />` + "\n")
	}
	headExtra.WriteString(`    <meta name="twitter:card" content="summary" />` + "\n")
	headExtra.WriteString(`    <meta name="twitter:title" content="` + html.EscapeString(meta.Title) + `" />` + "\n")
	headExtra.WriteString(`    <meta name="twitter:description" content="` + html.EscapeString(meta.Description) + `" />` + "\n")
	if meta.AlternateMD != "" {
		headExtra.WriteString(`    <link rel="alternate" type="text/markdown" href="` + html.EscapeString(meta.AlternateMD) + `" title="Markdown 原文" />` + "\n")
	}
	if meta.AlternateLLMs != "" {
		headExtra.WriteString(`    <link rel="alternate" type="text/plain" href="` + html.EscapeString(meta.AlternateLLMs) + `" title="llms.txt 索引" />` + "\n")
	}
	if meta.JSONLD != "" {
		headExtra.WriteString(`    <script type="application/ld+json">` + meta.JSONLD + `</script>`)
	}

	page = strings.Replace(page, "<title>青简 Qingjian</title>", headExtra.String(), 1)
	if meta.NoscriptHTML != "" {
		page = strings.Replace(page, `<div id="root"></div>`, `<div id="root"></div>`+"\n    "+meta.NoscriptHTML, 1)
	}
	_, _ = w.Write([]byte(page))
}

// indexableShares returns active, non-expired, passwordless shares that opted into search indexing.
func (s *Server) indexableShares() ([]*Share, error) {
	rows, err := s.db.Query(shareSelect + ` WHERE s.enabled = 1 AND s.password_hash = '' ORDER BY s.updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Share
	for rows.Next() {
		sh, err := scanShare(rows)
		if err != nil {
			return nil, err
		}
		if sh.publicIndexable() {
			out = append(out, sh)
		}
	}
	return out, rows.Err()
}

func (s *Server) serveRobotsTxt(w http.ResponseWriter, r *http.Request) {
	origin := s.requestOrigin(r)
	w.Header().Set("X-Robots-Tag", "all")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	body := strings.Join([]string{
		"User-agent: *",
		"Allow: /s/",
		"Allow: /llms.txt",
		"Allow: /sitemap.xml",
		"Disallow: /api/",
		"Disallow: /mcp",
		"Disallow: /oauth/",
		"Disallow: /r/",
		"Disallow: /login",
		"Disallow: /settings",
		"Disallow: /shares",
		"Disallow: /trash",
		"Disallow: /files/",
		"",
		"Sitemap: " + origin + "/sitemap.xml",
		"",
	}, "\n")
	_, _ = w.Write([]byte(body))
}

type sitemapURLSet struct {
	XMLName xml.Name     `xml:"urlset"`
	Xmlns   string       `xml:"xmlns,attr"`
	URLs    []sitemapURL `xml:"url"`
}

type sitemapURL struct {
	Loc     string `xml:"loc"`
	LastMod string `xml:"lastmod,omitempty"`
}

func (s *Server) serveSitemapXML(w http.ResponseWriter, r *http.Request) {
	origin := s.requestOrigin(r)
	shares, err := s.indexableShares()
	if err != nil {
		serverError(w, r, err)
		return
	}
	var urls []sitemapURL
	for _, sh := range shares {
		urls = append(urls, sitemapURL{
			Loc:     origin + "/s/" + sh.Token,
			LastMod: time.UnixMilli(sh.UpdatedAt).UTC().Format(time.RFC3339),
		})
		if sh.TargetType == "repo" || sh.NodeType == "group" {
			nodes, err := s.shareTreeNodes(sh)
			if err != nil {
				continue
			}
			for _, n := range nodes {
				if n.Type == "doc" || n.Type == "table" {
					urls = append(urls, sitemapURL{
						Loc:     origin + "/s/" + sh.Token + "/" + n.ID,
						LastMod: time.UnixMilli(n.UpdatedAt).UTC().Format(time.RFC3339),
					})
				}
			}
		}
	}
	w.Header().Set("X-Robots-Tag", "all")
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write([]byte(xml.Header))
	enc := xml.NewEncoder(w)
	enc.Indent("", "  ")
	_ = enc.Encode(sitemapURLSet{
		Xmlns: "http://www.sitemaps.org/schemas/sitemap/0.9",
		URLs:  urls,
	})
}

// serveRootLLMsTxt provides site-wide discovery following https://llmstxt.org/.
func (s *Server) serveRootLLMsTxt(w http.ResponseWriter, r *http.Request) {
	origin := s.requestOrigin(r)
	shares, _ := s.indexableShares()

	var b strings.Builder
	b.WriteString("# 青简 Qingjian\n\n")
	b.WriteString("> 个人自托管的在线知识库：原生 Markdown、多维表格与结构化绘图。\n\n")
	b.WriteString("## Agent 与 MCP 访问\n\n")
	b.WriteString("- **私有远程 MCP**：支持通过 `" + origin + "/mcp`（Streamable HTTP，兼容 OAuth 2.1 + PKCE 及可撤销的 `qj_...` API Key，支持 `mcp:read`、`mcp:write`、`mcp:trash` 细粒度权限）接入授权 AI 客户端。\n")
	b.WriteString("- **公开分享直读 Markdown**：对无密码公开分享链接附加 `.md` 后缀、添加 `?format=md` 参数，或发送 `Accept: text/markdown` 请求头，可获取纯 Markdown 原文；访问 `/s/{token}/llms.txt` 与 `/s/{token}/llms-full.txt` 可获取目录索引与整库上下文。\n")

	if len(shares) > 0 {
		b.WriteString("\n## 已公开索引的分享内容\n\n")
		for _, sh := range shares {
			title := sh.Title
			if sh.TargetType == "repo" {
				title = nonEmpty(title, "未命名知识库")
			} else {
				title = shareNodeDisplayTitle(sh.NodeType, title)
			}
			b.WriteString(fmt.Sprintf("- [%s](%s/s/%s.md)\n", title, origin, sh.Token))
		}
	}
	w.Header().Set("X-Robots-Tag", "index, follow")
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write([]byte(b.String()))
}
