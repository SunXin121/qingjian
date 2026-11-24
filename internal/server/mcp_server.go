package server

import (
	"cmp"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
)

const (
	mcpLatestProtocol = "2025-03-26"
	defaultMaxLines   = 400
	defaultMaxChars   = 24_000
	maxBoundedChars   = 100_000
)

var supportedMCPProtocols = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type mcpToolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Scope       string         `json:"-"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations,omitempty"`
}

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	setMCPDiscoveryCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	origin := s.requestOrigin(r)
	grant, status, msg := s.authenticateMCP(r)
	if grant == nil {
		if status == http.StatusUnauthorized {
			w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer resource_metadata="%s/.well-known/oauth-protected-resource"`, origin))
		}
		writeJSON(w, status, map[string]string{"error": msg})
		return
	}

	switch r.Method {
	case http.MethodGet:
		// Streamable HTTP spec: 405 indicates server uses direct JSON responses on POST rather than standalone SSE
		w.Header().Set("Allow", "POST, DELETE, OPTIONS")
		httpError(w, http.StatusMethodNotAllowed, "SSE stream not used; send JSON-RPC requests via POST /mcp")
		return
	case http.MethodDelete:
		w.WriteHeader(http.StatusNoContent)
		return
	case http.MethodPost:
		// continue below
	default:
		w.Header().Set("Allow", "POST, DELETE, OPTIONS")
		httpError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var raw json.RawMessage
	if err := readJSON(r, &raw); err != nil {
		writeJSON(w, http.StatusBadRequest, rpcResponse{
			JSONRPC: "2.0",
			ID:      json.RawMessage("null"),
			Error:   &rpcError{Code: -32700, Message: "Parse error"},
		})
		return
	}

	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, "[") {
		var batch []rpcRequest
		if err := json.Unmarshal(raw, &batch); err != nil || len(batch) == 0 {
			writeJSON(w, http.StatusBadRequest, rpcResponse{
				JSONRPC: "2.0",
				ID:      json.RawMessage("null"),
				Error:   &rpcError{Code: -32600, Message: "Invalid batch request"},
			})
			return
		}
		var replies []rpcResponse
		for _, req := range batch {
			if resp := s.dispatchMCPRequest(r, grant, req); resp != nil {
				replies = append(replies, *resp)
			}
		}
		if len(replies) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		writeJSON(w, http.StatusOK, replies)
		return
	}

	var req rpcRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, rpcResponse{
			JSONRPC: "2.0",
			ID:      json.RawMessage("null"),
			Error:   &rpcError{Code: -32600, Message: "Invalid request"},
		})
		return
	}
	resp := s.dispatchMCPRequest(r, grant, req)
	if resp == nil {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) dispatchMCPRequest(r *http.Request, grant *MCPGrant, req rpcRequest) *rpcResponse {
	isNotification := len(req.ID) == 0
	if req.JSONRPC != "2.0" || req.Method == "" {
		if isNotification {
			return nil
		}
		id := req.ID
		if len(id) == 0 {
			id = json.RawMessage("null")
		}
		return &rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -32600, Message: "Invalid Request"}}
	}
	if strings.HasPrefix(req.Method, "notifications/") {
		return nil
	}

	okResp := func(res any) *rpcResponse {
		if isNotification {
			return nil
		}
		return &rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: res}
	}
	errResp := func(code int, msg string) *rpcResponse {
		if isNotification {
			return nil
		}
		return &rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: code, Message: msg}}
	}

	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &p)
		proto := mcpLatestProtocol
		if slices.Contains(supportedMCPProtocols, p.ProtocolVersion) {
			proto = p.ProtocolVersion
		}
		return okResp(map[string]any{
			"protocolVersion": proto,
			"capabilities": map[string]any{
				"tools":     map[string]any{"listChanged": false},
				"resources": map[string]any{"listChanged": false},
			},
			"serverInfo": map[string]any{
				"name":    "qingjian",
				"version": nonEmpty(s.cfg.Version, "dev"),
			},
			"instructions": "青简（Qingjian）私有知识库 MCP 服务。使用 search 与 fetch/read_doc 检索和分段读取文档；更新文档时请传入 read_doc 返回的 base_updated_at 以启用乐观并发保护。",
		})

	case "ping":
		return okResp(map[string]any{})

	case "tools/list":
		all := mcpToolCatalog()
		visible := make([]mcpToolDef, 0, len(all))
		for _, t := range all {
			if grant.hasScope(t.Scope) {
				visible = append(visible, t)
			}
		}
		return okResp(map[string]any{"tools": visible})

	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil || p.Name == "" {
			return errResp(-32602, "Invalid params")
		}
		res, code, msg := s.executeMCPTool(r, grant, p.Name, p.Arguments)
		if code != 0 {
			return errResp(code, msg)
		}
		return okResp(res)

	case "resources/list":
		if !grant.hasScope(ScopeMCPRead) {
			return errResp(-32003, "缺少 mcp:read 权限")
		}
		list, err := s.mcpListResources()
		if err != nil {
			return errResp(-32603, "Internal error")
		}
		return okResp(map[string]any{"resources": list})

	case "resources/read":
		if !grant.hasScope(ScopeMCPRead) {
			return errResp(-32003, "缺少 mcp:read 权限")
		}
		var p struct {
			URI string `json:"uri"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil || p.URI == "" {
			return errResp(-32602, "Invalid resource URI")
		}
		contents, err := s.mcpReadResource(p.URI)
		if err != nil {
			return errResp(-32602, err.Error())
		}
		return okResp(map[string]any{"contents": contents})

	default:
		return errResp(-32601, "Method not found: "+req.Method)
	}
}

func mcpToolResult(data any) map[string]any {
	b, _ := json.MarshalIndent(data, "", "  ")
	return map[string]any{
		"content": []map[string]any{
			{"type": "text", "text": string(b)},
		},
		"structuredContent": data,
		"isError":           false,
	}
}

func mcpToolError(msg string) map[string]any {
	return map[string]any{
		"content": []map[string]any{
			{"type": "text", "text": msg},
		},
		"isError": true,
	}
}

func mcpToolCatalog() []mcpToolDef {
	ro := map[string]any{"readOnlyHint": true, "destructiveHint": false}
	rw := map[string]any{"readOnlyHint": false, "destructiveHint": false}
	tr := map[string]any{"readOnlyHint": false, "destructiveHint": true}

	return []mcpToolDef{
		{
			Name:        "search",
			Description: "全文搜索青简中的文档与多维表格，返回匹配的 ID、标题、所属知识库、摘要片段与链接。",
			Scope:       ScopeMCPRead,
			Annotations: ro,
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query":   map[string]any{"type": "string", "description": "搜索关键词"},
					"repo_id": map[string]any{"type": "string", "description": "可选：限定在某个知识库 ID 内搜索"},
					"type":    map[string]any{"type": "string", "enum": []string{"doc", "table"}, "description": "可选：限定节点类型"},
					"limit":   map[string]any{"type": "integer", "minimum": 1, "maximum": 50, "description": "返回条数上限（默认 20）"},
				},
				"required": []string{"query"},
			},
		},
		{
			Name:        "fetch",
			Description: "按节点 ID 获取单篇文档或多维表格的元信息与有界 Markdown 内容（配合 search 使用）。",
			Scope:       ScopeMCPRead,
			Annotations: ro,
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"id":          map[string]any{"type": "string", "description": "文档或表格节点 ID"},
					"offset_line": map[string]any{"type": "integer", "minimum": 1, "description": "起始行号（从 1 开始，默认 1）"},
					"max_lines":   map[string]any{"type": "integer", "minimum": 1, "maximum": 2000, "description": "最大读取行数（默认 400）"},
				},
				"required": []string{"id"},
			},
		},
		{
			Name:        "list_repos",
			Description: "列出全部知识库及其简介、文档数量和更新时间。",
			Scope:       ScopeMCPRead,
			Annotations: ro,
			InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			Name:        "get_repo_tree",
			Description: "获取指定知识库的目录树（分组文件夹、文档、多维表格）。",
			Scope:       ScopeMCPRead,
			Annotations: ro,
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"repo_id":   map[string]any{"type": "string", "description": "知识库 ID"},
					"parent_id": map[string]any{"type": "string", "description": "可选：仅查看某个父节点下的直接与间接子节点"},
				},
				"required": []string{"repo_id"},
			},
		},
		{
			Name:        "read_doc",
			Description: "分段有界读取文档 Markdown 正文，并返回 base_updated_at 版本戳以支持安全并发写入。",
			Scope:       ScopeMCPRead,
			Annotations: ro,
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"doc_id":      map[string]any{"type": "string", "description": "文档 ID"},
					"offset_line": map[string]any{"type": "integer", "minimum": 1, "description": "起始行号（从 1 开始，默认 1）"},
					"max_lines":   map[string]any{"type": "integer", "minimum": 1, "maximum": 2000, "description": "最大读取行数（默认 400）"},
				},
				"required": []string{"doc_id"},
			},
		},
		{
			Name:        "get_backlinks",
			Description: "读取指定文档或表格的双向链接图谱（引用它的反向链接与它引用的正向链接）。",
			Scope:       ScopeMCPRead,
			Annotations: ro,
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"node_id": map[string]any{"type": "string", "description": "节点 ID"}},
				"required":   []string{"node_id"},
			},
		},
		{
			Name:        "list_doc_versions",
			Description: "列出文档的历史版本快照元数据（版本 ID、标题、字节数、创建时间）。",
			Scope:       ScopeMCPRead,
			Annotations: ro,
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"doc_id": map[string]any{"type": "string", "description": "文档 ID"},
					"limit":  map[string]any{"type": "integer", "minimum": 1, "maximum": 100, "description": "最大返回条数（默认 20）"},
				},
				"required": []string{"doc_id"},
			},
		},
		{
			Name:        "get_table",
			Description: "有界读取多维表格的字段结构、视图列表与分页记录。",
			Scope:       ScopeMCPRead,
			Annotations: ro,
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"table_id": map[string]any{"type": "string", "description": "多维表格 ID"},
					"offset":   map[string]any{"type": "integer", "minimum": 0, "description": "记录起始偏移（默认 0）"},
					"limit":    map[string]any{"type": "integer", "minimum": 1, "maximum": 200, "description": "单次返回记录数（默认 50）"},
				},
				"required": []string{"table_id"},
			},
		},
		{
			Name:        "create_repo",
			Description: "创建新的知识库。",
			Scope:       ScopeMCPWrite,
			Annotations: rw,
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name":        map[string]any{"type": "string", "description": "知识库名称"},
					"description": map[string]any{"type": "string", "description": "知识库简介"},
					"icon":        map[string]any{"type": "string", "description": "可选：Emoji 或图标名（如 lucide:book）"},
				},
				"required": []string{"name"},
			},
		},
		{
			Name:        "create_node",
			Description: "在知识库中新建文档（doc）、分组文件夹（group）或多维表格（table）。",
			Scope:       ScopeMCPWrite,
			Annotations: rw,
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"repo_id":   map[string]any{"type": "string", "description": "知识库 ID"},
					"parent_id": map[string]any{"type": "string", "description": "可选：父节点 ID（为空则在根目录）"},
					"type":      map[string]any{"type": "string", "enum": []string{"doc", "group", "table"}, "description": "节点类型（默认 doc）"},
					"title":     map[string]any{"type": "string", "description": "标题"},
					"markdown":  map[string]any{"type": "string", "description": "初始 Markdown 内容（仅 doc 有效）"},
				},
				"required": []string{"repo_id", "title"},
			},
		},
		{
			Name:        "update_doc",
			Description: "版本安全地更新或追加文档内容。建议传入 read_doc 返回的 base_updated_at，若文档在外部已被修改将拒绝覆盖并提示冲突。",
			Scope:       ScopeMCPWrite,
			Annotations: rw,
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"doc_id":          map[string]any{"type": "string", "description": "文档 ID"},
					"title":           map[string]any{"type": "string", "description": "可选：更新文档标题（自动同步双链引用文本）"},
					"markdown":        map[string]any{"type": "string", "description": "可选：完整替换后的 Markdown 正文"},
					"append_markdown": map[string]any{"type": "string", "description": "可选：追加到文档末尾的 Markdown 段落（与 markdown 二选一）"},
					"base_updated_at": map[string]any{"type": "integer", "description": "乐观锁版本戳（来自 read_doc / fetch 的 base_updated_at）"},
					"snapshot":        map[string]any{"type": "boolean", "description": "是否强制生成一条历史版本快照"},
				},
				"required": []string{"doc_id"},
			},
		},
		{
			Name:        "move_or_rename_node",
			Description: "重命名节点或将其移动到新的父分组/排序位置。",
			Scope:       ScopeMCPWrite,
			Annotations: rw,
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"node_id":   map[string]any{"type": "string", "description": "节点 ID"},
					"title":     map[string]any{"type": "string", "description": "可选：新标题"},
					"parent_id": map[string]any{"type": "string", "description": "可选：移动到目标父节点 ID（传空字符串移回根目录）"},
				},
				"required": []string{"node_id"},
			},
		},
		{
			Name:        "list_trash",
			Description: "列出回收站中的知识库与节点（需独立 mcp:trash 权限）。",
			Scope:       ScopeMCPTrash,
			Annotations: ro,
			InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			Name:        "trash_node",
			Description: "将指定节点及其子节点软删除至回收站（保留 30 天可恢复；需 mcp:trash 权限，不允许永久物理清除）。",
			Scope:       ScopeMCPTrash,
			Annotations: tr,
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"node_id": map[string]any{"type": "string", "description": "要移入回收站的节点 ID"}},
				"required":   []string{"node_id"},
			},
		},
		{
			Name:        "restore_trash",
			Description: "从回收站恢复软删除的知识库或节点（需 mcp:trash 权限）。",
			Scope:       ScopeMCPTrash,
			Annotations: rw,
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"kind": map[string]any{"type": "string", "enum": []string{"node", "repo"}, "description": "条目类型"},
					"id":   map[string]any{"type": "string", "description": "条目 ID"},
				},
				"required": []string{"kind", "id"},
			},
		},
	}
}

func sliceBoundedLines(md string, offsetLine, maxLines int) (chunk string, startLine, endLine, totalLines int, hasMore bool, nextOffset *int) {
	if offsetLine < 1 {
		offsetLine = 1
	}
	if maxLines < 1 {
		maxLines = defaultMaxLines
	}
	if maxLines > 2000 {
		maxLines = 2000
	}
	lines := strings.Split(md, "\n")
	totalLines = len(lines)
	if offsetLine > totalLines {
		return "", offsetLine, totalLines, totalLines, false, nil
	}
	startIdx := offsetLine - 1
	endIdx := min(totalLines, startIdx+maxLines)
	var b strings.Builder
	actualEnd := startIdx
	for i := startIdx; i < endIdx; i++ {
		if i > startIdx && b.Len()+len(lines[i])+1 > maxBoundedChars {
			break
		}
		if i > startIdx {
			b.WriteByte('\n')
		}
		line := lines[i]
		if len(line) > defaultMaxChars && i == startIdx {
			line = string([]rune(line)[:defaultMaxChars/2]) + "…[truncated]"
		}
		b.WriteString(line)
		actualEnd = i + 1
	}
	hasMore = actualEnd < totalLines
	if hasMore {
		n := actualEnd + 1
		nextOffset = &n
	}
	return b.String(), offsetLine, actualEnd, totalLines, hasMore, nextOffset
}

func (s *Server) executeMCPTool(r *http.Request, grant *MCPGrant, name string, rawArgs json.RawMessage) (map[string]any, int, string) {
	var def *mcpToolDef
	for _, t := range mcpToolCatalog() {
		if t.Name == name {
			cp := t
			def = &cp
			break
		}
	}
	if def == nil {
		return nil, -32602, "Unknown tool: " + name
	}
	if !grant.hasScope(def.Scope) {
		return mcpToolError(fmt.Sprintf("当前凭证缺少 %s 权限，无法调用 %s", def.Scope, name)), 0, ""
	}
	if len(rawArgs) == 0 {
		rawArgs = json.RawMessage("{}")
	}
	origin := s.requestOrigin(r)

	switch name {
	case "search":
		var in struct {
			Query  string `json:"query"`
			RepoID string `json:"repo_id"`
			Type   string `json:"type"`
			Limit  int    `json:"limit"`
		}
		if json.Unmarshal(rawArgs, &in) != nil || strings.TrimSpace(in.Query) == "" {
			return mcpToolError("请提供非空的 query 参数"), 0, ""
		}
		q := strings.TrimSpace(in.Query)
		if runes := []rune(q); len(runes) > 200 {
			q = string(runes[:200])
		}
		limit := in.Limit
		if limit <= 0 || limit > 50 {
			limit = 20
		}
		var hits []SearchHit
		var err error
		if minTermLen(q) >= 3 {
			hits, err = s.searchFTS(q)
		} else {
			hits, err = s.searchLike(q)
		}
		if err != nil {
			return mcpToolError("搜索失败"), 0, ""
		}
		type item struct {
			ID        string `json:"id"`
			Title     string `json:"title"`
			Type      string `json:"type"`
			RepoID    string `json:"repo_id"`
			RepoName  string `json:"repo_name"`
			URL       string `json:"url"`
			Snippet   string `json:"snippet"`
			UpdatedAt int64  `json:"updated_at"`
		}
		results := make([]item, 0, limit)
		cleanHL := strings.NewReplacer("\x01", "", "\x02", "")
		for _, h := range hits {
			if in.RepoID != "" && h.RepoID != in.RepoID {
				continue
			}
			if in.Type != "" && h.Type != in.Type {
				continue
			}
			seg := "d"
			if h.Type == "table" {
				seg = "t"
			}
			results = append(results, item{
				ID:        h.ID,
				Title:     shareNodeDisplayTitle(h.Type, h.Title),
				Type:      h.Type,
				RepoID:    h.RepoID,
				RepoName:  h.RepoName,
				URL:       fmt.Sprintf("%s/r/%s/%s/%s", origin, h.RepoID, seg, h.ID),
				Snippet:   cleanHL.Replace(h.Snippet),
				UpdatedAt: h.UpdatedAt,
			})
			if len(results) >= limit {
				break
			}
		}
		return mcpToolResult(map[string]any{"results": results}), 0, ""

	case "fetch", "read_doc":
		var in struct {
			ID         string `json:"id"`
			DocID      string `json:"doc_id"`
			OffsetLine int    `json:"offset_line"`
			MaxLines   int    `json:"max_lines"`
		}
		if json.Unmarshal(rawArgs, &in) != nil {
			return mcpToolError("参数格式错误"), 0, ""
		}
		id := strings.TrimSpace(cmp.Or(in.DocID, in.ID))
		if id == "" {
			return mcpToolError("请提供文档或节点 ID"), 0, ""
		}
		n, err := s.loadNode(s.db, id)
		if err != nil {
			return mcpToolError("节点不存在或已被删除"), 0, ""
		}
		if n.Type == "table" {
			t, err := s.loadTableData(s.db, id)
			if err != nil {
				return mcpToolError("读取表格失败"), 0, ""
			}
			s.withLinked(t)
			md := t.markdown("")
			chunk, startL, endL, totalL, more, nextOff := sliceBoundedLines(md, in.OffsetLine, in.MaxLines)
			return mcpToolResult(map[string]any{
				"id":          t.ID,
				"type":        "table",
				"repo_id":     t.RepoID,
				"title":       shareNodeDisplayTitle("table", t.Title),
				"url":         fmt.Sprintf("%s/r/%s/t/%s", origin, t.RepoID, t.ID),
				"text":        chunk,
				"start_line":  startL,
				"end_line":    endL,
				"total_lines": totalL,
				"has_more":    more,
				"next_offset": nextOff,
				"updated_at":  t.UpdatedAt,
			}), 0, ""
		}
		d, err := s.loadDoc(id)
		if err != nil {
			return mcpToolError("文档不存在"), 0, ""
		}
		chunk, startL, endL, totalL, more, nextOff := sliceBoundedLines(d.Markdown, in.OffsetLine, in.MaxLines)
		return mcpToolResult(map[string]any{
			"id":              d.ID,
			"type":            "doc",
			"repo_id":         d.RepoID,
			"parent_id":       d.ParentID,
			"title":           shareNodeDisplayTitle("doc", d.Title),
			"url":             fmt.Sprintf("%s/r/%s/d/%s", origin, d.RepoID, d.ID),
			"markdown":        chunk,
			"text":            chunk,
			"start_line":      startL,
			"end_line":        endL,
			"total_lines":     totalL,
			"has_more":        more,
			"next_offset":     nextOff,
			"base_updated_at": d.ContentUpdatedAt,
		}), 0, ""

	case "list_repos":
		rows, err := s.db.Query(`SELECT r.id, r.name, r.description, r.icon, r.sort, r.created_at, r.updated_at,
  (SELECT COUNT(*) FROM nodes n WHERE n.repo_id = r.id AND n.type = 'doc' AND n.deleted_at IS NULL)
FROM repos r WHERE r.deleted_at IS NULL ORDER BY r.sort, r.created_at`)
		if err != nil {
			return mcpToolError("读取知识库列表失败"), 0, ""
		}
		defer rows.Close()
		repos := []Repo{}
		for rows.Next() {
			var x Repo
			if err := rows.Scan(&x.ID, &x.Name, &x.Description, &x.Icon, &x.Sort, &x.CreatedAt, &x.UpdatedAt, &x.DocCount); err != nil {
				return mcpToolError("读取知识库列表失败"), 0, ""
			}
			repos = append(repos, x)
		}
		return mcpToolResult(map[string]any{"repos": repos}), 0, ""

	case "get_repo_tree":
		var in struct {
			RepoID   string `json:"repo_id"`
			ParentID string `json:"parent_id"`
		}
		if json.Unmarshal(rawArgs, &in) != nil || strings.TrimSpace(in.RepoID) == "" {
			return mcpToolError("请提供 repo_id"), 0, ""
		}
		repo, err := s.loadRepo(in.RepoID)
		if err != nil {
			return mcpToolError("知识库不存在"), 0, ""
		}
		nodes, err := s.treeNodes(in.RepoID)
		if err != nil {
			return mcpToolError("读取目录树失败"), 0, ""
		}
		if in.ParentID != "" {
			nodes = subtree(nodes, in.ParentID)
		}
		return mcpToolResult(map[string]any{"repo": repo, "nodes": nodes}), 0, ""

	case "get_backlinks":
		var in struct {
			NodeID string `json:"node_id"`
		}
		if json.Unmarshal(rawArgs, &in) != nil || strings.TrimSpace(in.NodeID) == "" {
			return mcpToolError("请提供 node_id"), 0, ""
		}
		backlinks := []Backlink{}
		err := scanRows(s.db, func(rows *sql.Rows) error {
			var b Backlink
			var md string
			if err := rows.Scan(&b.ID, &b.RepoID, &b.RepoName, &b.Title, &b.UpdatedAt, &md); err != nil {
				return err
			}
			b.Snippet = linkSnippet(md, in.NodeID)
			backlinks = append(backlinks, b)
			return nil
		}, `SELECT n.id, n.repo_id, rp.name, n.title, n.updated_at, c.markdown
FROM doc_links l JOIN nodes n ON n.id = l.src JOIN repos rp ON rp.id = n.repo_id JOIN doc_contents c ON c.node_id = n.id
WHERE l.dst = ? AND n.deleted_at IS NULL AND rp.deleted_at IS NULL ORDER BY n.updated_at DESC LIMIT 100`, in.NodeID)
		if err != nil {
			return mcpToolError("读取反向链接失败"), 0, ""
		}
		outlinks := []NodeRef{}
		_ = scanRows(s.db, func(rows *sql.Rows) error {
			var n NodeRef
			if err := rows.Scan(&n.ID, &n.RepoID, &n.RepoName, &n.Type, &n.Title, &n.UpdatedAt); err != nil {
				return err
			}
			outlinks = append(outlinks, n)
			return nil
		}, `SELECT n.id, n.repo_id, rp.name, n.type, n.title, n.updated_at
FROM doc_links l JOIN nodes n ON n.id = l.dst JOIN repos rp ON rp.id = n.repo_id
WHERE l.src = ? AND n.deleted_at IS NULL AND rp.deleted_at IS NULL ORDER BY n.updated_at DESC LIMIT 100`, in.NodeID)
		return mcpToolResult(map[string]any{"backlinks": backlinks, "outlinks": outlinks}), 0, ""

	case "list_doc_versions":
		var in struct {
			DocID string `json:"doc_id"`
			Limit int    `json:"limit"`
		}
		if json.Unmarshal(rawArgs, &in) != nil || strings.TrimSpace(in.DocID) == "" {
			return mcpToolError("请提供 doc_id"), 0, ""
		}
		limit := in.Limit
		if limit <= 0 || limit > 100 {
			limit = 20
		}
		versions := []Version{}
		err := scanRows(s.db, func(rows *sql.Rows) error {
			var v Version
			if err := rows.Scan(&v.ID, &v.NodeID, &v.Title, &v.Size, &v.CreatedAt); err != nil {
				return err
			}
			versions = append(versions, v)
			return nil
		}, `SELECT id, node_id, title, size, created_at FROM doc_versions WHERE node_id = ? ORDER BY id DESC LIMIT ?`, in.DocID, limit)
		if err != nil {
			return mcpToolError("读取版本列表失败"), 0, ""
		}
		return mcpToolResult(map[string]any{"versions": versions}), 0, ""

	case "get_table":
		var in struct {
			TableID string `json:"table_id"`
			Offset  int    `json:"offset"`
			Limit   int    `json:"limit"`
		}
		if json.Unmarshal(rawArgs, &in) != nil || strings.TrimSpace(in.TableID) == "" {
			return mcpToolError("请提供 table_id"), 0, ""
		}
		t, err := s.loadTableData(s.db, in.TableID)
		if err != nil {
			return mcpToolError("多维表格不存在"), 0, ""
		}
		limit := in.Limit
		if limit <= 0 || limit > 200 {
			limit = 50
		}
		offset := max(0, in.Offset)
		total := len(t.Records)
		var page []Record
		if offset < total {
			page = t.Records[offset:min(total, offset+limit)]
		} else {
			page = []Record{}
		}
		return mcpToolResult(map[string]any{
			"id":            t.ID,
			"title":         t.Title,
			"fields":        t.Fields,
			"views":         t.Views,
			"records":       page,
			"total_records": total,
			"has_more":      offset+len(page) < total,
			"updated_at":    t.UpdatedAt,
		}), 0, ""

	case "create_repo":
		var in struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Icon        string `json:"icon"`
		}
		if json.Unmarshal(rawArgs, &in) != nil || strings.TrimSpace(in.Name) == "" {
			return mcpToolError("请提供知识库名称 name"), 0, ""
		}
		x := Repo{ID: newID(), Name: strings.TrimSpace(in.Name), Description: in.Description, Icon: in.Icon, CreatedAt: now()}
		x.UpdatedAt = x.CreatedAt
		if err := s.db.QueryRow(`INSERT INTO repos(id, name, description, icon, sort, created_at, updated_at)
VALUES(?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM repos), ?, ?) RETURNING sort`,
			x.ID, x.Name, x.Description, x.Icon, x.CreatedAt, x.UpdatedAt).Scan(&x.Sort); err != nil {
			return mcpToolError("创建知识库失败"), 0, ""
		}
		return mcpToolResult(x), 0, ""

	case "create_node":
		var in struct {
			RepoID   string  `json:"repo_id"`
			ParentID *string `json:"parent_id"`
			Type     string  `json:"type"`
			Title    string  `json:"title"`
			Markdown string  `json:"markdown"`
		}
		if json.Unmarshal(rawArgs, &in) != nil || strings.TrimSpace(in.RepoID) == "" {
			return mcpToolError("请提供 repo_id 与 title"), 0, ""
		}
		if in.Type == "" {
			in.Type = "doc"
		}
		if !nodeTypes[in.Type] {
			return mcpToolError("不支持的节点类型"), 0, ""
		}
		if _, err := s.loadRepo(in.RepoID); err != nil {
			return mcpToolError("知识库不存在"), 0, ""
		}
		if in.ParentID != nil && *in.ParentID == "" {
			in.ParentID = nil
		}
		n := Node{ID: newID(), RepoID: in.RepoID, ParentID: in.ParentID, Type: in.Type, Title: strings.TrimSpace(in.Title), CreatedAt: now()}
		n.UpdatedAt = n.CreatedAt
		err := s.withTx(func(tx *sql.Tx) error {
			if in.ParentID != nil {
				p, err := s.loadNode(tx, *in.ParentID)
				if err != nil || p.RepoID != in.RepoID {
					return errors.New("父节点不存在")
				}
			}
			if err := tx.QueryRow(`SELECT COALESCE(MAX(sort), 0) + 1 FROM nodes WHERE repo_id = ? AND parent_id IS ?`, n.RepoID, n.ParentID).Scan(&n.Sort); err != nil {
				return err
			}
			if _, err := tx.Exec(`INSERT INTO nodes(id, repo_id, parent_id, type, title, sort, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)`,
				n.ID, n.RepoID, n.ParentID, n.Type, n.Title, n.Sort, n.CreatedAt, n.UpdatedAt); err != nil {
				return err
			}
			switch n.Type {
			case "doc":
				if _, err := tx.Exec(`INSERT INTO doc_contents(node_id, markdown, updated_at) VALUES(?,?,?)`, n.ID, in.Markdown, n.UpdatedAt); err != nil {
					return err
				}
				if err := indexDoc(tx, n.ID, n.Title, in.Markdown, n.CreatedAt); err != nil {
					return err
				}
				if in.Markdown != "" {
					_ = addVersion(tx, n.ID, n.Title, in.Markdown, n.UpdatedAt)
				}
			case "table":
				if err := initTable(tx, n.ID, n.CreatedAt); err != nil {
					return err
				}
				if _, err := tx.Exec(`INSERT INTO docs_fts(node_id, title, body) VALUES(?,?,'')`, n.ID, n.Title); err != nil {
					return err
				}
			}
			return touchRepo(tx, n.RepoID, n.UpdatedAt)
		})
		if err != nil {
			return mcpToolError(err.Error()), 0, ""
		}
		return mcpToolResult(map[string]any{"node": n, "base_updated_at": n.UpdatedAt}), 0, ""

	case "update_doc":
		var in struct {
			DocID          string  `json:"doc_id"`
			Title          *string `json:"title"`
			Markdown       *string `json:"markdown"`
			AppendMarkdown *string `json:"append_markdown"`
			BaseUpdatedAt  *int64  `json:"base_updated_at"`
			Snapshot       bool    `json:"snapshot"`
		}
		if json.Unmarshal(rawArgs, &in) != nil || strings.TrimSpace(in.DocID) == "" {
			return mcpToolError("请提供 doc_id"), 0, ""
		}
		if in.Markdown != nil && in.AppendMarkdown != nil {
			return mcpToolError("markdown 与 append_markdown 不能同时传入"), 0, ""
		}
		errConflict := errors.New("conflict")
		var updatedAt, currentAt int64
		var finalTitle string
		err := s.withTx(func(tx *sql.Tx) error {
			n, err := s.loadNode(tx, in.DocID)
			if err != nil || n.Type != "doc" {
				return errors.New("文档不存在")
			}
			var md string
			if err := tx.QueryRow(`SELECT markdown, updated_at FROM doc_contents WHERE node_id = ?`, in.DocID).Scan(&md, &currentAt); err != nil {
				return err
			}
			if in.BaseUpdatedAt != nil && *in.BaseUpdatedAt != currentAt {
				return errConflict
			}
			updatedAt = now()
			if updatedAt <= currentAt {
				updatedAt = currentAt + 1
			}
			oldTitle := n.Title
			if in.Title != nil {
				n.Title = strings.TrimSpace(*in.Title)
			}
			finalTitle = n.Title
			if in.Markdown != nil {
				md = *in.Markdown
			} else if in.AppendMarkdown != nil {
				sep := "\n\n"
				if strings.TrimSpace(md) == "" {
					sep = ""
				}
				md = strings.TrimRight(md, "\n") + sep + *in.AppendMarkdown
			}
			if err := renameLinks(tx, in.DocID, n.Type, oldTitle, n.Title); err != nil {
				return err
			}
			if _, err := tx.Exec(`UPDATE nodes SET title = ?, updated_at = ? WHERE id = ?`, n.Title, updatedAt, in.DocID); err != nil {
				return err
			}
			if _, err := tx.Exec(`UPDATE doc_contents SET markdown = ?, updated_at = ? WHERE node_id = ?`, md, updatedAt, in.DocID); err != nil {
				return err
			}
			if err := indexDoc(tx, in.DocID, n.Title, md, updatedAt); err != nil {
				return err
			}
			if err := touchRepo(tx, n.RepoID, updatedAt); err != nil {
				return err
			}
			_, lastAt, _, verr := latestVersion(tx, in.DocID)
			if in.Snapshot || errors.Is(verr, sql.ErrNoRows) || updatedAt-lastAt >= versionInterval {
				if same, err := sameAsLatest(tx, in.DocID, md); err == nil && !same {
					return addVersion(tx, in.DocID, n.Title, md, updatedAt)
				}
			}
			return nil
		})
		if errors.Is(err, errConflict) {
			return mcpToolError(fmt.Sprintf("版本冲突：文档已在外部修改（最新 base_updated_at=%d），请先重新调用 read_doc 读取后再合并保存", currentAt)), 0, ""
		} else if err != nil {
			return mcpToolError(err.Error()), 0, ""
		}
		return mcpToolResult(map[string]any{"doc_id": in.DocID, "title": finalTitle, "base_updated_at": updatedAt}), 0, ""

	case "move_or_rename_node":
		var in struct {
			NodeID   string  `json:"node_id"`
			Title    *string `json:"title"`
			ParentID *string `json:"parent_id"`
		}
		if json.Unmarshal(rawArgs, &in) != nil || strings.TrimSpace(in.NodeID) == "" {
			return mcpToolError("请提供 node_id"), 0, ""
		}
		var outNode *Node
		err := s.withTx(func(tx *sql.Tx) error {
			n, err := s.loadNode(tx, in.NodeID)
			if err != nil {
				return errors.New("节点不存在")
			}
			if in.Title != nil {
				title := strings.TrimSpace(*in.Title)
				if err := renameLinks(tx, n.ID, n.Type, n.Title, title); err != nil {
					return err
				}
				n.Title, n.UpdatedAt = title, now()
				if _, err := tx.Exec(`UPDATE nodes SET title = ?, updated_at = ? WHERE id = ?`, n.Title, n.UpdatedAt, n.ID); err != nil {
					return err
				}
				if _, err := tx.Exec(`UPDATE docs_fts SET title = ? WHERE node_id = ?`, n.Title, n.ID); err != nil {
					return err
				}
			}
			if in.ParentID != nil {
				var targetParent *string
				if strings.TrimSpace(*in.ParentID) != "" {
					pStr := strings.TrimSpace(*in.ParentID)
					targetParent = &pStr
					p, err := s.loadNode(tx, pStr)
					if err != nil || p.RepoID != n.RepoID {
						return errors.New("目标父节点不存在或不在同一知识库")
					}
					for cur := p; cur != nil; {
						if cur.ID == n.ID {
							return errors.New("不能移动到自身的子节点下")
						}
						if cur.ParentID == nil {
							break
						}
						cur, _ = s.loadNode(tx, *cur.ParentID)
					}
				}
				var sort float64
				if err := tx.QueryRow(`SELECT COALESCE(MAX(sort), 0) + 1 FROM nodes WHERE repo_id = ? AND parent_id IS ?`, n.RepoID, targetParent).Scan(&sort); err != nil {
					return err
				}
				n.ParentID, n.Sort = targetParent, sort
				if _, err := tx.Exec(`UPDATE nodes SET parent_id = ?, sort = ? WHERE id = ?`, targetParent, sort, n.ID); err != nil {
					return err
				}
			}
			outNode = n
			return nil
		})
		if err != nil {
			return mcpToolError(err.Error()), 0, ""
		}
		return mcpToolResult(outNode), 0, ""

	case "list_trash":
		items := []TrashItem{}
		err := scanRows(s.db, func(rows *sql.Rows) error {
			it := TrashItem{Kind: "repo", Type: "repo"}
			if err := rows.Scan(&it.ID, &it.Title, &it.DeletedAt); err != nil {
				return err
			}
			it.RepoID, it.RepoName = it.ID, it.Title
			items = append(items, it)
			return nil
		}, `SELECT id, name, deleted_at FROM repos WHERE deleted_at IS NOT NULL`)
		if err == nil {
			err = scanRows(s.db, func(rows *sql.Rows) error {
				it := TrashItem{Kind: "node"}
				if err := rows.Scan(&it.ID, &it.Type, &it.Title, &it.RepoID, &it.RepoName, &it.DeletedAt); err != nil {
					return err
				}
				items = append(items, it)
				return nil
			}, `SELECT n.id, n.type, n.title, n.repo_id, r.name, n.deleted_at FROM nodes n JOIN repos r ON r.id = n.repo_id
WHERE n.trash_root = 1 AND n.deleted_at IS NOT NULL AND r.deleted_at IS NULL`)
		}
		if err != nil {
			return mcpToolError("读取回收站失败"), 0, ""
		}
		slices.SortStableFunc(items, func(a, b TrashItem) int { return cmp.Compare(b.DeletedAt, a.DeletedAt) })
		return mcpToolResult(map[string]any{"items": items}), 0, ""

	case "trash_node":
		var in struct {
			NodeID string `json:"node_id"`
		}
		if json.Unmarshal(rawArgs, &in) != nil || strings.TrimSpace(in.NodeID) == "" {
			return mcpToolError("请提供 node_id"), 0, ""
		}
		err := s.withTx(func(tx *sql.Tx) error {
			if _, err := s.loadNode(tx, in.NodeID); err != nil {
				return errors.New("节点不存在")
			}
			ids, err := descendantIDs(tx, in.NodeID, true)
			if err != nil {
				return err
			}
			t := now()
			for _, x := range ids {
				if _, err := tx.Exec(`UPDATE nodes SET deleted_at = ?, trash_root = ? WHERE id = ?`, t, boolInt(x == in.NodeID), x); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return mcpToolError(err.Error()), 0, ""
		}
		return mcpToolResult(map[string]any{"trashed": in.NodeID}), 0, ""

	case "restore_trash":
		var in struct {
			Kind string `json:"kind"`
			ID   string `json:"id"`
		}
		if json.Unmarshal(rawArgs, &in) != nil || in.ID == "" {
			return mcpToolError("请提供 kind 与 id"), 0, ""
		}
		err := s.withTx(func(tx *sql.Tx) error {
			switch in.Kind {
			case "repo":
				_, err := tx.Exec(`UPDATE repos SET deleted_at = NULL WHERE id = ?`, in.ID)
				return err
			case "node":
				return restoreNode(tx, in.ID)
			default:
				return errors.New("不支持的恢复类型")
			}
		})
		if err != nil {
			return mcpToolError(err.Error()), 0, ""
		}
		return mcpToolResult(map[string]any{"restored": in.ID, "kind": in.Kind}), 0, ""
	}

	return nil, -32602, "Unknown tool"
}

func (s *Server) mcpListResources() ([]map[string]any, error) {
	out := []map[string]any{}
	err := scanRows(s.db, func(rows *sql.Rows) error {
		var id, name, desc string
		if err := rows.Scan(&id, &name, &desc); err != nil {
			return err
		}
		out = append(out, map[string]any{
			"uri":         "qingjian://repo/" + id,
			"name":        name,
			"description": desc,
			"mimeType":    "application/json",
		})
		return nil
	}, `SELECT id, name, description FROM repos WHERE deleted_at IS NULL ORDER BY sort, created_at LIMIT 100`)
	if err != nil {
		return nil, err
	}
	err = scanRows(s.db, func(rows *sql.Rows) error {
		var id, title, repoName string
		if err := rows.Scan(&id, &title, &repoName); err != nil {
			return err
		}
		out = append(out, map[string]any{
			"uri":         "qingjian://doc/" + id,
			"name":        shareNodeDisplayTitle("doc", title),
			"description": repoName,
			"mimeType":    "text/markdown",
		})
		return nil
	}, `SELECT n.id, n.title, r.name FROM nodes n JOIN repos r ON r.id = n.repo_id
WHERE n.type = 'doc' AND n.deleted_at IS NULL AND r.deleted_at IS NULL ORDER BY n.updated_at DESC LIMIT 100`)
	return out, err
}

func (s *Server) mcpReadResource(uri string) ([]map[string]any, error) {
	if id, ok := strings.CutPrefix(uri, "qingjian://doc/"); ok && id != "" {
		d, err := s.loadDoc(id)
		if err != nil {
			return nil, errors.New("document not found")
		}
		chunk, _, _, _, _, _ := sliceBoundedLines(d.Markdown, 1, defaultMaxLines)
		return []map[string]any{
			{
				"uri":      uri,
				"mimeType": "text/markdown",
				"text":     chunk,
			},
		}, nil
	}
	if id, ok := strings.CutPrefix(uri, "qingjian://repo/"); ok && id != "" {
		repo, err := s.loadRepo(id)
		if err != nil {
			return nil, errors.New("repository not found")
		}
		nodes, err := s.treeNodes(id)
		if err != nil {
			return nil, err
		}
		b, _ := json.MarshalIndent(map[string]any{"repo": repo, "nodes": nodes}, "", "  ")
		return []map[string]any{
			{
				"uri":      uri,
				"mimeType": "application/json",
				"text":     string(b),
			},
		}, nil
	}
	return nil, errors.New("unsupported resource URI")
}
