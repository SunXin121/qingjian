package server

// PlantUML code blocks are rendered by an optional plantuml-server (QINGJIAN_PLANTUML_URL):
// the browser posts the diagram source here and gets the SVG back, so the PlantUML server
// never has to be reachable from outside. Share visitors may only render diagrams that
// appear in a document of their share.

import (
	"bytes"
	"compress/flate"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	pumlMaxSource = 256 << 10
	pumlMaxSVG    = 8 << 20
	pumlCacheSize = 256
	// longer sources are posted instead of being encoded into the URL
	pumlMaxGetLen = 4000
)

// pumlCache keeps the most recently rendered diagrams (by source hash).
type pumlCache struct {
	mu    sync.Mutex
	items map[string]string
	order []string
}

func (c *pumlCache) get(key string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.items[key]
	return v, ok
}

func (c *pumlCache) put(key, svg string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.items == nil {
		c.items = map[string]string{}
	}
	if _, ok := c.items[key]; ok {
		return
	}
	c.items[key] = svg
	c.order = append(c.order, key)
	if len(c.order) > pumlCacheSize {
		delete(c.items, c.order[0])
		c.order = c.order[1:]
	}
}

const pumlAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"

// plantumlEncode is PlantUML's text encoding: raw deflate, then a base64 variant.
func plantumlEncode(src string) string {
	var buf bytes.Buffer
	zw, _ := flate.NewWriter(&buf, flate.BestCompression)
	zw.Write([]byte(src))
	zw.Close()
	data := buf.Bytes()
	var sb strings.Builder
	for i := 0; i < len(data); i += 3 {
		var b2, b3 byte
		b1 := data[i]
		if i+1 < len(data) {
			b2 = data[i+1]
		}
		if i+2 < len(data) {
			b3 = data[i+2]
		}
		sb.WriteByte(pumlAlphabet[b1>>2])
		sb.WriteByte(pumlAlphabet[(b1&0x3)<<4|b2>>4])
		sb.WriteByte(pumlAlphabet[(b2&0xF)<<2|b3>>6])
		sb.WriteByte(pumlAlphabet[b3&0x3F])
	}
	return sb.String()
}

func (s *Server) plantUML(w http.ResponseWriter, r *http.Request) { s.renderPlantUML(w, r, nil) }

func (s *Server) sharePlantUML(w http.ResponseWriter, r *http.Request) {
	sh := s.activeShare(w, r, true)
	if sh == nil {
		return
	}
	s.renderPlantUML(w, r, sh)
}

func (s *Server) renderPlantUML(w http.ResponseWriter, r *http.Request, sh *Share) {
	if s.cfg.PlantUMLURL == "" {
		httpError(w, http.StatusServiceUnavailable, "服务器未配置 PlantUML 服务（QINGJIAN_PLANTUML_URL）")
		return
	}
	var req struct {
		Source string `json:"source"`
	}
	if err := readJSON(r, &req); err != nil {
		httpError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	src := strings.TrimSpace(req.Source)
	if src == "" || len(src) > pumlMaxSource {
		httpError(w, http.StatusBadRequest, "图表内容为空或过长")
		return
	}
	if sh != nil {
		ok, err := s.shareHasText(sh, src)
		if err != nil {
			serverError(w, err)
			return
		}
		if !ok {
			httpError(w, http.StatusNotFound, "图表不存在")
			return
		}
	}
	sum := sha256.Sum256([]byte(src))
	key := hex.EncodeToString(sum[:])
	if svg, ok := s.puml.get(key); ok {
		writeJSON(w, http.StatusOK, map[string]any{"svg": svg})
		return
	}
	svg, syntaxErr, err := s.fetchPlantUML(r.Context(), src)
	if err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	if !syntaxErr {
		s.puml.put(key, svg)
	}
	writeJSON(w, http.StatusOK, map[string]any{"svg": svg, "error": syntaxErr})
}

// fetchPlantUML renders src to SVG; syntax errors come back as an SVG describing them.
func (s *Server) fetchPlantUML(ctx context.Context, src string) (svg string, syntaxErr bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	base := strings.TrimRight(s.cfg.PlantUMLURL, "/") + "/svg"
	var req *http.Request
	if enc := plantumlEncode(src); len(enc) <= pumlMaxGetLen {
		req, err = http.NewRequestWithContext(ctx, "GET", base+"/"+enc, nil)
	} else {
		req, err = http.NewRequestWithContext(ctx, "POST", base, strings.NewReader(src))
		if req != nil {
			req.Header.Set("Content-Type", "text/plain; charset=utf-8")
		}
	}
	if err != nil {
		return "", false, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", false, fmt.Errorf("无法连接 PlantUML 服务：%v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, pumlMaxSVG+1))
	if err != nil {
		return "", false, fmt.Errorf("读取 PlantUML 服务响应失败：%v", err)
	}
	if len(body) > pumlMaxSVG {
		return "", false, fmt.Errorf("图表过大")
	}
	isSVG := bytes.Contains(body, []byte("<svg"))
	switch {
	case resp.StatusCode == 200 && isSVG:
		return string(body), false, nil
	case resp.StatusCode == 400 && isSVG:
		return string(body), true, nil
	default:
		return "", false, fmt.Errorf("PlantUML 服务返回 %d", resp.StatusCode)
	}
}

// shareHasText reports whether a document visible through the share contains src (as a
// code block: compared line by line, ignoring the indentation and quote markers blocks
// nested in lists or callouts carry in the markdown).
func (s *Server) shareHasText(sh *Share, src string) (bool, error) {
	first := strings.TrimSpace(strings.SplitN(src, "\n", 2)[0])
	cond, args := shareScope(sh)
	rows, err := s.db.Query(`SELECT c.markdown FROM doc_contents c JOIN nodes n ON n.id = c.node_id
WHERE n.deleted_at IS NULL AND n.type = 'doc' AND instr(c.markdown, ?) > 0 AND `+cond, append([]any{first}, args...)...)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	want := normalizeBlockText(src)
	for rows.Next() {
		var md sql.NullString
		if err := rows.Scan(&md); err != nil {
			return false, err
		}
		if strings.Contains(normalizeBlockText(md.String), want) {
			return true, nil
		}
	}
	return false, rows.Err()
}

func normalizeBlockText(s string) string {
	lines := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(strings.TrimLeft(l, " \t>"), " \t")
	}
	return strings.Join(lines, "\n")
}
