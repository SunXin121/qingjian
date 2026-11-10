package server

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type testEnv struct {
	t     *testing.T
	srv   *Server
	ts    *httptest.Server
	admin *http.Client
}

func newEnv(t *testing.T, mut ...func(*Config)) *testEnv {
	t.Helper()
	cfg := Config{DataDir: t.TempDir(), AdminPassword: "pw", MaxUploadMB: 10, TrashDays: 30}
	for _, m := range mut {
		m(&cfg)
	}
	srv, err := New(cfg, nil)
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

func newClient() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar}
}

func (e *testEnv) do(c *http.Client, method, path string, body any) (int, map[string]any) {
	e.t.Helper()
	code, raw := e.raw(c, method, path, body)
	var m map[string]any
	json.Unmarshal(raw, &m)
	return code, m
}

func (e *testEnv) raw(c *http.Client, method, path string, body any) (int, []byte) {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.ts.URL+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data
}

func (e *testEnv) repoWithDoc(md string) (repoID, docID string) {
	e.t.Helper()
	_, r := e.do(e.admin, "POST", "/api/repos", map[string]string{"name": "R"})
	repoID = r["id"].(string)
	_, n := e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repoID, "type": "doc", "title": "D", "markdown": md})
	return repoID, n["id"].(string)
}

func (e *testEnv) upload(name, content string) string {
	e.t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", name)
	fw.Write([]byte(content))
	mw.Close()
	req, _ := http.NewRequest("POST", e.ts.URL+"/api/files", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := e.admin.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var att Attachment
	json.NewDecoder(resp.Body).Decode(&att)
	if resp.StatusCode != 201 {
		e.t.Fatalf("upload: %d", resp.StatusCode)
	}
	return att.ID
}

func TestShareDocWithPassword(t *testing.T) {
	e := newEnv(t)
	repoID, docID := e.repoWithDoc("# hello")
	_, other := e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repoID, "type": "doc", "title": "secret"})

	code, sh := e.do(e.admin, "POST", "/api/shares", map[string]any{"target_type": "node", "target_id": docID, "password": "1234"})
	if code != 201 || sh["has_password"] != true {
		t.Fatalf("create share: %d %v", code, sh)
	}
	token := sh["token"].(string)
	visitor := newClient()

	if code, m := e.do(visitor, "GET", "/api/s/"+token, nil); code != 401 || m["need_password"] != true {
		t.Fatalf("expected password prompt, got %d %v", code, m)
	}
	if code, _ := e.do(visitor, "POST", "/api/s/"+token+"/auth", map[string]string{"password": "nope"}); code != 401 {
		t.Fatalf("wrong password accepted: %d", code)
	}
	if code, _ := e.do(visitor, "POST", "/api/s/"+token+"/auth", map[string]string{"password": "1234"}); code != 200 {
		t.Fatalf("auth: %d", code)
	}
	code, info := e.do(visitor, "GET", "/api/s/"+token, nil)
	if code != 200 || info["doc_id"] != docID {
		t.Fatalf("info: %d %v", code, info)
	}
	if code, d := e.do(visitor, "GET", "/api/s/"+token+"/docs/"+docID, nil); code != 200 || d["markdown"] != "# hello" {
		t.Fatalf("doc: %d %v", code, d)
	}
	// other docs in the same repo stay private
	if code, _ := e.do(visitor, "GET", "/api/s/"+token+"/docs/"+other["id"].(string), nil); code != 404 {
		t.Fatalf("leaked sibling doc: %d", code)
	}
	if code, _ := e.do(visitor, "GET", "/api/s/"+token+"/tree", nil); code != 404 {
		t.Fatalf("doc share exposes tree: %d", code)
	}
	// admin APIs remain closed to visitors
	if code, _ := e.do(visitor, "GET", "/api/docs/"+docID, nil); code != 401 {
		t.Fatalf("visitor reached admin API: %d", code)
	}

	// changing the password invalidates the visitor's cookie
	e.do(e.admin, "PATCH", "/api/shares/"+token, map[string]any{"password": "5678"})
	if code, _ := e.do(visitor, "GET", "/api/s/"+token, nil); code != 401 {
		t.Fatalf("old cookie still valid after password change: %d", code)
	}
	// removing the password opens it up
	e.do(e.admin, "PATCH", "/api/shares/"+token, map[string]any{"password": ""})
	if code, _ := e.do(newClient(), "GET", "/api/s/"+token, nil); code != 200 {
		t.Fatalf("passwordless share: %d", code)
	}

	// disable → 404, expire → 410
	e.do(e.admin, "PATCH", "/api/shares/"+token, map[string]any{"enabled": false})
	if code, _ := e.do(visitor, "GET", "/api/s/"+token, nil); code != 404 {
		t.Fatalf("disabled share: %d", code)
	}
	past := time.Now().Add(-time.Minute).UnixMilli()
	e.do(e.admin, "PATCH", "/api/shares/"+token, map[string]any{"enabled": true, "expires_at": past})
	if code, _ := e.do(visitor, "GET", "/api/s/"+token, nil); code != 410 {
		t.Fatalf("expired share: %d", code)
	}
	e.do(e.admin, "PATCH", "/api/shares/"+token, map[string]any{"expires_at": nil})

	// regenerate kills the old token
	_, re := e.do(e.admin, "POST", "/api/shares/"+token+"/regenerate", nil)
	if code, _ := e.do(visitor, "GET", "/api/s/"+token, nil); code != 404 {
		t.Fatalf("old token alive after regenerate: %d", code)
	}
	newToken := re["token"].(string)
	if code, _ := e.do(visitor, "GET", "/api/s/"+newToken, nil); code != 200 {
		t.Fatalf("new token: %d", code)
	}

	// deleting the doc takes the share down
	e.do(e.admin, "DELETE", "/api/nodes/"+docID, nil)
	if code, _ := e.do(visitor, "GET", "/api/s/"+newToken, nil); code != 404 {
		t.Fatalf("share of deleted doc: %d", code)
	}
	_, list := e.raw(e.admin, "GET", "/api/shares", nil)
	if !strings.Contains(string(list), `"target_alive":false`) {
		t.Fatalf("share list should mark dead target: %s", list)
	}
}

func TestShareRepo(t *testing.T) {
	e := newEnv(t)
	repoID, docID := e.repoWithDoc("a")
	otherRepo, otherDoc := e.repoWithDoc("b")
	_ = otherRepo
	_, sh := e.do(e.admin, "POST", "/api/shares", map[string]any{"target_type": "repo", "target_id": repoID})
	token := sh["token"].(string)
	v := newClient()
	code, info := e.do(v, "GET", "/api/s/"+token, nil)
	if code != 200 || info["type"] != "repo" {
		t.Fatalf("info: %d %v", code, info)
	}
	code, tree := e.raw(v, "GET", "/api/s/"+token+"/tree", nil)
	if code != 200 || !strings.Contains(string(tree), docID) {
		t.Fatalf("tree: %d %s", code, tree)
	}
	if code, _ := e.do(v, "GET", "/api/s/"+token+"/docs/"+docID, nil); code != 200 {
		t.Fatalf("doc in repo: %d", code)
	}
	if code, _ := e.do(v, "GET", "/api/s/"+token+"/docs/"+otherDoc, nil); code != 404 {
		t.Fatalf("doc from another repo leaked: %d", code)
	}
	// view counter
	_, list := e.raw(e.admin, "GET", "/api/shares?target_type=repo&target_id="+repoID, nil)
	if !strings.Contains(string(list), `"view_count":1`) {
		t.Fatalf("view count: %s", list)
	}
	// purging the repo from trash removes its shares
	e.do(e.admin, "DELETE", "/api/repos/"+repoID, nil)
	e.do(e.admin, "DELETE", "/api/trash/repo/"+repoID, nil)
	_, list = e.raw(e.admin, "GET", "/api/shares", nil)
	if strings.Contains(string(list), token) {
		t.Fatalf("share survived purge: %s", list)
	}
}

func TestAttachmentCleanup(t *testing.T) {
	e := newEnv(t)
	used := e.upload("a.png", "image-a")
	scene := e.upload("scene.excalidraw", "scene")
	svg := e.upload("drawing.svg", "<svg/>")
	orphan := e.upload("b.txt", "orphan")
	dupOrphan := e.upload("c.txt", "image-a") // same blob as `used`
	inVersion := e.upload("v.txt", "old")

	md := "![](/files/" + used + "/a.png)\n\n```excalidraw\n{\"scene\":\"" + scene + "\",\"svg\":\"" + svg + "\"}\n```"
	_, docID := e.repoWithDoc(md)
	// a reference that only survives in history must keep the file
	e.srv.db.Exec(`INSERT INTO doc_versions(node_id, title, markdown, created_at) VALUES(?,?,?,?)`, docID, "", "[x](/files/"+inVersion+"/v.txt)", now())

	// everything is inside the grace period: nothing to clean yet
	if n, _, _ := e.srv.cleanupAttachments(); n != 0 {
		t.Fatalf("cleaned %d files inside grace period", n)
	}
	old := time.Now().Add(-48 * time.Hour).UnixMilli()
	e.srv.db.Exec(`UPDATE attachments SET created_at = ?`, old)

	_, stats := e.do(e.admin, "GET", "/api/files/stats", nil)
	if stats["unreferenced"].(float64) != 2 {
		t.Fatalf("stats: %v", stats)
	}
	code, res := e.do(e.admin, "POST", "/api/files/cleanup", nil)
	if code != 200 || res["removed"].(float64) != 2 || res["freed_bytes"].(float64) != float64(len("orphan")) {
		t.Fatalf("cleanup: %d %v", code, res)
	}
	for _, id := range []string{used, scene, svg, inVersion} {
		if code, _ := e.raw(newClient(), "GET", "/files/"+id+"/x", nil); code != 200 {
			t.Fatalf("referenced file %s gone: %d", id, code)
		}
	}
	for _, id := range []string{orphan, dupOrphan} {
		if code, _ := e.raw(newClient(), "GET", "/files/"+id+"/x", nil); code != 404 {
			t.Fatalf("orphan %s still served: %d", id, code)
		}
	}
}

func TestLocalBackup(t *testing.T) {
	dir := t.TempDir()
	e := newEnv(t, func(c *Config) { c.Backup = BackupConfig{Dir: dir, Keep: 2} })
	att := e.upload("a.txt", "hello backup")
	e.repoWithDoc("[a](/files/" + att + "/a.txt)")

	var snaps []string
	for i := 0; i < 3; i++ {
		rep := e.srv.backup.run(t.Context())
		if !rep.OK {
			t.Fatalf("backup failed: %+v", rep)
		}
		snaps = append(snaps, rep.Results[0].Snapshot)
		if i == 0 && rep.Results[0].Files != 1 {
			t.Fatalf("first run should upload 1 blob, got %d", rep.Results[0].Files)
		}
		if i > 0 && rep.Results[0].Files != 0 {
			t.Fatalf("blobs must upload only once, got %d", rep.Results[0].Files)
		}
		time.Sleep(1100 * time.Millisecond) // snapshot names have second resolution
	}
	if _, err := os.Stat(filepath.Join(dir, snaps[0])); !os.IsNotExist(err) {
		t.Fatalf("oldest snapshot should be rotated away")
	}
	f, err := os.Open(filepath.Join(dir, snaps[2]))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	head := make([]byte, 16)
	io.ReadFull(zr, head)
	if string(head) != "SQLite format 3\x00" {
		t.Fatalf("snapshot is not a sqlite db: %q", head)
	}
	sum, _ := e.srv.loadAttachment(att)
	if b, err := os.ReadFile(filepath.Join(dir, "files", sum.SHA256[:2], sum.SHA256[2:4], sum.SHA256)); err != nil || string(b) != "hello backup" {
		t.Fatalf("blob not backed up: %v", err)
	}
	_, status := e.do(e.admin, "GET", "/api/backup", nil)
	if status["enabled"] != true || status["last"].(map[string]any)["ok"] != true {
		t.Fatalf("status: %v", status)
	}
}

func TestS3Signing(t *testing.T) {
	// Requests must reach the server with the exact path/headers that were signed.
	var got *http.Request
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		io.Copy(io.Discard, r.Body)
	}))
	defer ts.Close()
	e := newEnv(t, func(c *Config) {
		c.Backup = BackupConfig{S3Endpoint: ts.URL, S3Bucket: "bk", S3Prefix: "my notes/", S3AccessKey: "AK", S3SecretKey: "SK"}
	})
	tgt := e.srv.backup.targets[0]
	tmp := filepath.Join(t.TempDir(), "x")
	os.WriteFile(tmp, []byte("data"), 0o644)
	if err := putFile(t.Context(), tgt, "db/a b.gz", tmp, "abc"); err != nil {
		t.Fatal(err)
	}
	if got.URL.EscapedPath() != "/bk/my%20notes/db/a%20b.gz" {
		t.Fatalf("path: %s", got.URL.EscapedPath())
	}
	auth := got.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 Credential=AK/") || !strings.Contains(auth, "SignedHeaders=host;x-amz-content-sha256;x-amz-date") {
		t.Fatalf("auth header: %s", auth)
	}
	if got.Header.Get("X-Amz-Content-Sha256") != "abc" {
		t.Fatalf("payload hash header missing")
	}
}

func TestPortableMarkdown(t *testing.T) {
	e := newEnv(t)
	svg := e.upload("diagram.svg", "<svg/>")
	md := "a\n\n```drawio\n{\"scene\":\"x\",\"svg\":\"" + svg + "\"}\n```\n\n```mindmap\n{\"new\":\"1\"}\n```"
	out := e.srv.portableMarkdown(md)
	if !strings.Contains(out, "![流程图](/files/"+svg+"/diagram.svg)") {
		t.Fatalf("drawio not converted: %s", out)
	}
	if strings.Contains(out, "mindmap") || strings.Contains(out, "\"new\"") {
		t.Fatalf("empty mindmap should be dropped: %s", out)
	}
}

func TestPortableMarkdownEmptyParagraphs(t *testing.T) {
	s := &Server{}
	for _, tc := range []struct {
		name, markdown, want string
	}{
		{"empty paragraphs", "before\n\n<br />\n\n<br />\n\nafter\n", "before\n\n\n\n\n\nafter\n"},
		{"variants and CRLF", "<br>\r\n<BR/>\r\n  <br />  \r\n", "\r\n\r\n\r\n"},
		{"only placeholder", "<br />", ""},
		{"blockquote", "> before\n>\n> <br />\n>\n> after", "> before\n>\n> \n>\n> after"},
		{"inline HTML", "before<br />after", "before<br />after"},
		{"inline code", "`<br />`", "`<br />`"},
		{"indented code", "    <br />\n\t<br />", "    <br />\n\t<br />"},
		{"backtick fence", "```html\n<br />\n```\n\n<br />", "```html\n<br />\n```\n\n"},
		{"long fence", "````markdown\n```html\n<br />\n```\n````\n<br />", "````markdown\n```html\n<br />\n```\n````\n"},
		{"tilde fence", "~~~html\n<br />\n~~~\n<br />", "~~~html\n<br />\n~~~\n"},
		{"quoted fence", "> ```html\n> <br />\n> ```\n> <br />", "> ```html\n> <br />\n> ```\n> "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := s.portableMarkdown(tc.markdown); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestExportEmptyParagraphs(t *testing.T) {
	e := newEnv(t)
	repoID, docID := e.repoWithDoc("before\n\n<br />\n\nafter\n")
	for _, endpoint := range []string{"/api/docs/" + docID + "/export", "/api/repos/" + repoID + "/export"} {
		code, data := e.raw(e.admin, "GET", endpoint, nil)
		if code != 200 {
			t.Fatalf("export %s: %d", endpoint, code)
		}
		if got := readZip(t, data)["D.md"]; got != "before\n\n\n\nafter\n" {
			t.Fatalf("export %s: %q", endpoint, got)
		}
	}
	if d, err := e.srv.loadDoc(docID); err != nil || d.Markdown != "before\n\n<br />\n\nafter\n" {
		t.Fatalf("export changed stored document: %+v, %v", d, err)
	}
}

func readZip(t *testing.T, data []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("not a zip: %v", err)
	}
	files := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		files[f.Name] = string(b)
	}
	return files
}

func TestExportDocZip(t *testing.T) {
	e := newEnv(t)
	svg1 := e.upload("diagram.svg", "<svg id=\"1\"/>")
	svg2 := e.upload("diagram.svg", "<svg id=\"2\"/>")
	img := e.upload("my photo (1).png", "PNG")
	md := "```drawio\r\n{\"scene\":\"x\",\"svg\":\"" + svg1 + "\"}\r\n```\n\n" +
		"```excalidraw \n{\"svg\":\"" + svg2 + "\"}\n```\n\n" +
		"![p](/files/" + img + "/my%20photo%20(1).png) and [again](http://example.com/files/" + img + "/x.png)\n\n" +
		"```mindmap\n{\"new\":\"1\"}\n```\n"
	_, docID := e.repoWithDoc(md)
	code, data := e.raw(e.admin, "GET", "/api/docs/"+docID+"/export", nil)
	if code != 200 {
		t.Fatalf("export: %d", code)
	}
	files := readZip(t, data)
	out, ok := files["D.md"]
	if !ok {
		t.Fatalf("missing D.md: %v", files)
	}
	for _, want := range []string{
		"![流程图](assets/diagram.svg)",
		"![画板](assets/diagram-2.svg)",
		"![p](assets/my%20photo%20%281%29.png)",
		"[again](assets/my%20photo%20%281%29.png)",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "/files/") || strings.Contains(out, "mindmap") {
		t.Fatalf("server links or editor blocks left:\n%s", out)
	}
	if files["assets/diagram.svg"] != "<svg id=\"1\"/>" || files["assets/diagram-2.svg"] != "<svg id=\"2\"/>" || files["assets/my photo (1).png"] != "PNG" {
		t.Fatalf("assets: %v", files)
	}
}

func TestExportRepoZip(t *testing.T) {
	e := newEnv(t)
	svg := e.upload("diagram.svg", "<svg/>")
	repoID, docID := e.repoWithDoc("```drawio\n{\"svg\":\"" + svg + "\"}\n```")
	e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repoID, "parent_id": docID, "type": "doc", "title": "Child", "markdown": "![x](/files/" + svg + "/diagram.svg)"})
	code, data := e.raw(e.admin, "GET", "/api/repos/"+repoID+"/export", nil)
	if code != 200 {
		t.Fatalf("export: %d", code)
	}
	files := readZip(t, data)
	if !strings.Contains(files["D.md"], "](assets/diagram.svg)") {
		t.Fatalf("root doc: %v", files)
	}
	if !strings.Contains(files["D/Child.md"], "](../assets/diagram.svg)") {
		t.Fatalf("child doc: %v", files)
	}
	if files["assets/diagram.svg"] != "<svg/>" {
		t.Fatalf("asset missing: %v", files)
	}
}
