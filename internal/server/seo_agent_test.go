package server

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
)

func newEnvWithStatic(t *testing.T) *testEnv {
	t.Helper()
	static := fstest.MapFS{
		"index.html": &fstest.MapFile{
			Data: []byte("<!doctype html>\n<html lang=\"zh-CN\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <meta name=\"robots\" content=\"noindex, nofollow\" />\n    <title>青简 Qingjian</title>\n  </head>\n  <body>\n    <div id=\"root\"></div>\n  </body>\n</html>"),
		},
	}
	cfg := Config{DataDir: t.TempDir(), AdminPassword: "pw", MaxUploadMB: 10, TrashDays: 30, Version: "1.2.0"}
	srv, err := New(cfg, static)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		ts.Close()
		srv.Close()
	})
	e := &testEnv{t: t, srv: srv, ts: ts, admin: newClient()}
	if code, _ := e.do(e.admin, "POST", "/api/auth/login", map[string]string{"password": "pw"}); code != 200 {
		t.Fatalf("login: %d", code)
	}
	return e
}

func getWithHeaders(t *testing.T, c *http.Client, targetURL string, headers map[string]string) (int, http.Header, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, string(b)
}

func TestShareSEOAndMarkdown(t *testing.T) {
	e := newEnvWithStatic(t)
	_, r := e.do(e.admin, "POST", "/api/repos", map[string]string{"name": "工程手册", "description": "架构与研发规范汇总"})
	repoID := r["id"].(string)
	_, d := e.do(e.admin, "POST", "/api/nodes", map[string]any{
		"repo_id":  repoID,
		"type":     "doc",
		"title":    "部署指南",
		"markdown": "这是一份详细的容器化部署说明，支持单二进制运行。\n\n## 环境要求\n\nGo 1.26 与 SQLite。",
	})
	docID := d["id"].(string)

	code, sh := e.do(e.admin, "POST", "/api/shares", map[string]any{
		"target_type": "repo",
		"target_id":   repoID,
	})
	if code != 201 || sh["allow_indexing"] != false {
		t.Fatalf("create share: %d %v", code, sh)
	}
	token := sh["token"].(string)
	visitor := newClient()

	code, hdr, htmlBody := getWithHeaders(t, visitor, e.ts.URL+"/s/"+token+"/"+docID, map[string]string{"Accept": "text/html"})
	if code != 200 || hdr.Get("X-Robots-Tag") != "noindex, nofollow" {
		t.Fatalf("share HTML: %d %q", code, hdr.Get("X-Robots-Tag"))
	}
	for _, want := range []string{
		"<title>部署指南 - 青简</title>",
		`property="og:title" content="部署指南 - 青简"`,
		`type="text/markdown"`,
		"容器化部署说明",
		`application/ld+json`,
	} {
		if !strings.Contains(htmlBody, want) {
			t.Fatalf("missing %q in HTML:\n%s", want, htmlBody)
		}
	}

	code, sh = e.do(e.admin, "PATCH", "/api/shares/"+token, map[string]any{"allow_indexing": true})
	if code != 200 || sh["allow_indexing"] != true {
		t.Fatalf("enable indexing: %d %v", code, sh)
	}
	_, hdr, htmlBody = getWithHeaders(t, visitor, e.ts.URL+"/s/"+token, map[string]string{"Accept": "text/html"})
	if hdr.Get("X-Robots-Tag") != "index, follow" || !strings.Contains(htmlBody, `<meta name="robots" content="index, follow" />`) {
		t.Fatalf("expected index, follow: hdr=%q body=%s", hdr.Get("X-Robots-Tag"), htmlBody)
	}
	_, _, sitemap := getWithHeaders(t, visitor, e.ts.URL+"/sitemap.xml", nil)
	if !strings.Contains(sitemap, "/s/"+token+"/"+docID) {
		t.Fatalf("sitemap missing opted-in share:\n%s", sitemap)
	}

	code, hdr, mdBody := getWithHeaders(t, visitor, e.ts.URL+"/s/"+token+"/"+docID, map[string]string{"Accept": "text/markdown"})
	if code != 200 || !strings.HasPrefix(hdr.Get("Content-Type"), "text/markdown") {
		t.Fatalf("markdown negotiation failed: %d %v", code, hdr)
	}
	if !strings.Contains(mdBody, `title: "部署指南"`) || !strings.Contains(mdBody, "## 环境要求") {
		t.Fatalf("unexpected markdown body:\n%s", mdBody)
	}

	// Setting password clears allow_indexing and prevents metadata leakage
	code, sh = e.do(e.admin, "PATCH", "/api/shares/"+token, map[string]any{"password": "secret"})
	if code != 200 || sh["allow_indexing"] != false || sh["has_password"] != true {
		t.Fatalf("set password did not clear allow_indexing: %d %v", code, sh)
	}
	_, hdr, lockedHTML := getWithHeaders(t, visitor, e.ts.URL+"/s/"+token+"/"+docID, map[string]string{"Accept": "text/html"})
	if hdr.Get("X-Robots-Tag") != "noindex, nofollow" || strings.Contains(lockedHTML, "部署指南") {
		t.Fatalf("passworded share leaked metadata: %q\n%s", hdr.Get("X-Robots-Tag"), lockedHTML)
	}
}

func callMCP(t *testing.T, tsURL, token string, rpc any) (int, http.Header, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(rpc)
	req, _ := http.NewRequest(http.MethodPost, tsURL+"/mcp", strings.NewReader(string(b)))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, resp.Header, out
}

func TestPrivateRemoteMCPScopesBoundedReadsAndRevisionGuards(t *testing.T) {
	e := newEnvWithStatic(t)
	_, docID := e.repoWithDoc("第一行\n第二行\n第三行\n第四行\n第五行")

	// 1. Unauthenticated /mcp returns RFC 9728 resource_metadata challenge
	code, hdr, _ := callMCP(t, e.ts.URL, "", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"})
	if code != 401 || !strings.Contains(hdr.Get("WWW-Authenticate"), ".well-known/oauth-protected-resource") {
		t.Fatalf("expected OAuth protected resource challenge: %d %q", code, hdr.Get("WWW-Authenticate"))
	}

	// 2. Read-only qj_... API key can initialize, search, bounded read, but NOT write or trash
	code, roRes := e.do(e.admin, "POST", "/api/mcp/keys", map[string]any{
		"name":   "ReadOnly Key",
		"scopes": []string{"mcp:read"},
	})
	if code != 201 {
		t.Fatalf("create ro key: %d %v", code, roRes)
	}
	roToken := roRes["token"].(string)
	if !strings.HasPrefix(roToken, "qj_") {
		t.Fatalf("unexpected key prefix: %q", roToken)
	}

	code, _, initResp := callMCP(t, e.ts.URL, roToken, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "initialize",
		"params":  map[string]any{"protocolVersion": "2025-03-26"},
	})
	if code != 200 || initResp["error"] != nil {
		t.Fatalf("initialize: %d %v", code, initResp)
	}

	// tools/list on read-only key only exposes mcp:read tools
	_, _, listResp := callMCP(t, e.ts.URL, roToken, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
	rawTools, _ := json.Marshal(listResp["result"])
	if strings.Contains(string(rawTools), `"update_doc"`) || strings.Contains(string(rawTools), `"trash_node"`) {
		t.Fatalf("read-only key should not list write/trash tools: %s", rawTools)
	}

	// Bounded read (offset_line=2, max_lines=2)
	_, _, readResp := callMCP(t, e.ts.URL, roToken, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "read_doc",
			"arguments": map[string]any{"doc_id": docID, "offset_line": 2, "max_lines": 2},
		},
	})
	structured := readResp["result"].(map[string]any)["structuredContent"].(map[string]any)
	if structured["markdown"] != "第二行\n第三行" || structured["has_more"] != true || structured["next_offset"].(float64) != 4 {
		t.Fatalf("bounded read mismatch: %+v", structured)
	}
	baseRev := int64(structured["base_updated_at"].(float64))

	// Read-only key calling update_doc returns isError: true
	_, _, deniedWrite := callMCP(t, e.ts.URL, roToken, map[string]any{
		"jsonrpc": "2.0",
		"id":      4,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "update_doc",
			"arguments": map[string]any{"doc_id": docID, "markdown": "hacked"},
		},
	})
	if deniedWrite["result"].(map[string]any)["isError"] != true {
		t.Fatalf("expected scope error for read-only key: %+v", deniedWrite)
	}

	// 3. Read+Write key enforces base_updated_at optimistic concurrency guard and still blocks trash_node
	_, rwRes := e.do(e.admin, "POST", "/api/mcp/keys", map[string]any{
		"name":   "Editor Key",
		"scopes": []string{"mcp:write"},
	})
	rwToken := rwRes["token"].(string)

	// Stale base_updated_at fails safely
	_, _, conflictResp := callMCP(t, e.ts.URL, rwToken, map[string]any{
		"jsonrpc": "2.0",
		"id":      5,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "update_doc",
			"arguments": map[string]any{"doc_id": docID, "markdown": "stale overwrite", "base_updated_at": baseRev - 1},
		},
	})
	if conflictResp["result"].(map[string]any)["isError"] != true {
		t.Fatalf("expected revision conflict error: %+v", conflictResp)
	}

	// Matching base_updated_at succeeds
	_, _, okWrite := callMCP(t, e.ts.URL, rwToken, map[string]any{
		"jsonrpc": "2.0",
		"id":      6,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "update_doc",
			"arguments": map[string]any{"doc_id": docID, "append_markdown": "第六行", "base_updated_at": baseRev},
		},
	})
	if okWrite["result"].(map[string]any)["isError"] != false {
		t.Fatalf("revision-safe write failed: %+v", okWrite)
	}

	// Still blocked from trash without mcp:trash
	_, _, deniedTrash := callMCP(t, e.ts.URL, rwToken, map[string]any{
		"jsonrpc": "2.0",
		"id":      7,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "trash_node",
			"arguments": map[string]any{"node_id": docID},
		},
	})
	if deniedTrash["result"].(map[string]any)["isError"] != true {
		t.Fatalf("expected trash permission rejection: %+v", deniedTrash)
	}
}

func TestMCPOAuth21PKCEFlowAndRevocation(t *testing.T) {
	e := newEnvWithStatic(t)
	_, docID := e.repoWithDoc("# OAuth 笔记")
	anon := newClient()

	// 1. Metadata discovery
	code, _, metaRaw := getWithHeaders(t, anon, e.ts.URL+"/.well-known/oauth-authorization-server", nil)
	if code != 200 || !strings.Contains(metaRaw, `"S256"`) {
		t.Fatalf("oauth metadata: %d %s", code, metaRaw)
	}

	// 2. Dynamic Client Registration
	code, reg := e.do(anon, "POST", "/oauth/register", map[string]any{
		"client_name":   "Claude Desktop",
		"redirect_uris": []string{"http://127.0.0.1:54321/callback"},
	})
	if code != 201 {
		t.Fatalf("oauth register: %d %v", code, reg)
	}
	clientID := reg["client_id"].(string)

	// 3. PKCE S256 verifier & challenge
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-qingjian-pkce"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	code, approve := e.do(e.admin, "POST", "/api/mcp/oauth/approve", map[string]any{
		"approve":               true,
		"client_id":             clientID,
		"redirect_uri":          "http://127.0.0.1:54321/callback",
		"code_challenge":        challenge,
		"code_challenge_method": "S256",
		"state":                 "xyz123",
		"scopes":                []string{"mcp:read", "mcp:trash"},
	})
	if code != 200 {
		t.Fatalf("approve oauth: %d %v", code, approve)
	}
	redirURL, err := url.Parse(approve["redirect_to"].(string))
	if err != nil || redirURL.Query().Get("state") != "xyz123" {
		t.Fatalf("redirect_to: %v %v", approve, err)
	}
	authCode := redirURL.Query().Get("code")

	// Wrong verifier must fail (consumes single-use code! So let's approve a second code after testing wrong verifier)
	code, badTok := e.do(anon, "POST", "/oauth/token", map[string]string{
		"grant_type":    "authorization_code",
		"code":          authCode,
		"client_id":     clientID,
		"redirect_uri":  "http://127.0.0.1:54321/callback",
		"code_verifier": "wrong-verifier-that-is-at-least-43-characters-long-123456",
	})
	if code != 400 {
		t.Fatalf("wrong PKCE verifier accepted: %d %v", code, badTok)
	}

	// Issue fresh code and exchange with valid PKCE verifier
	_, approve2 := e.do(e.admin, "POST", "/api/mcp/oauth/approve", map[string]any{
		"approve":               true,
		"client_id":             clientID,
		"redirect_uri":          "http://127.0.0.1:54321/callback",
		"code_challenge":        challenge,
		"code_challenge_method": "S256",
		"scopes":                []string{"mcp:read", "mcp:trash"},
	})
	u2, _ := url.Parse(approve2["redirect_to"].(string))
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {u2.Query().Get("code")},
		"client_id":     {clientID},
		"redirect_uri":  {"http://127.0.0.1:54321/callback"},
		"code_verifier": {verifier},
	}
	resp, err := anon.PostForm(e.ts.URL+"/oauth/token", form)
	if err != nil {
		t.Fatal(err)
	}
	var tokData map[string]any
	json.NewDecoder(resp.Body).Decode(&tokData)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("token exchange: %d %v", resp.StatusCode, tokData)
	}
	accessToken := tokData["access_token"].(string)
	refreshToken := tokData["refresh_token"].(string)

	// Trash and restore via MCP using mcp:trash grant
	_, _, trResp := callMCP(t, e.ts.URL, accessToken, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params":  map[string]any{"name": "trash_node", "arguments": map[string]any{"node_id": docID}},
	})
	if trResp["result"].(map[string]any)["isError"] != false {
		t.Fatalf("trash_node failed: %+v", trResp)
	}
	_, _, rsResp := callMCP(t, e.ts.URL, accessToken, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "tools/call",
		"params":  map[string]any{"name": "restore_trash", "arguments": map[string]any{"kind": "node", "id": docID}},
	})
	if rsResp["result"].(map[string]any)["isError"] != false {
		t.Fatalf("restore_trash failed: %+v", rsResp)
	}

	// Refresh token rotation
	resp2, err := anon.PostForm(e.ts.URL+"/oauth/token", url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
	})
	if err != nil {
		t.Fatal(err)
	}
	var rotated map[string]any
	json.NewDecoder(resp2.Body).Decode(&rotated)
	resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Fatalf("refresh failed: %d %v", resp2.StatusCode, rotated)
	}
	newAccess := rotated["access_token"].(string)

	// Old access token no longer works; new access token works
	if c, _, _ := callMCP(t, e.ts.URL, accessToken, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "ping"}); c != 401 {
		t.Fatalf("old rotated access token still accepted: %d", c)
	}
	if c, _, _ := callMCP(t, e.ts.URL, newAccess, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "ping"}); c != 200 {
		t.Fatalf("new access token rejected: %d", c)
	}

	// Revoke via admin grant management
	_, grantsRaw := e.raw(e.admin, "GET", "/api/mcp/grants", nil)
	var grants []MCPGrant
	json.Unmarshal(grantsRaw, &grants)
	if len(grants) != 1 || grants[0].Kind != "oauth" {
		t.Fatalf("expected 1 oauth grant: %+v", grants)
	}
	e.do(e.admin, "DELETE", "/api/mcp/grants/"+grants[0].ID, nil)
	if c, _, _ := callMCP(t, e.ts.URL, newAccess, map[string]any{"jsonrpc": "2.0", "id": 5, "method": "ping"}); c != 401 {
		t.Fatalf("revoked grant still accepted: %d", c)
	}
}
