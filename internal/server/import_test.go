package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

type importPart struct{ path, content string }

func (e *testEnv) importFiles(repoID, parentID string, files ...importPart) (int, importResult, string) {
	e.t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if parentID != "" {
		mw.WriteField("parent_id", parentID)
	}
	for _, f := range files {
		mw.WriteField("path", f.path)
		fw, _ := mw.CreateFormFile("file", f.path)
		fw.Write([]byte(f.content))
	}
	mw.Close()
	req, _ := http.NewRequest("POST", e.ts.URL+"/api/repos/"+repoID+"/import", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := e.admin.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var raw bytes.Buffer
	raw.ReadFrom(resp.Body)
	var res importResult
	json.Unmarshal(raw.Bytes(), &res)
	return resp.StatusCode, res, raw.String()
}

func (e *testEnv) newRepo() string {
	_, r := e.do(e.admin, "POST", "/api/repos", map[string]string{"name": "R"})
	return r["id"].(string)
}

// treeByPath maps "parent title/child title" → node.
func (e *testEnv) treeByPath(repoID string) map[string]map[string]any {
	e.t.Helper()
	_, raw := e.raw(e.admin, "GET", "/api/repos/"+repoID+"/tree", nil)
	var nodes []map[string]any
	json.Unmarshal(raw, &nodes)
	byID := map[string]map[string]any{}
	for _, n := range nodes {
		byID[n["id"].(string)] = n
	}
	var full func(n map[string]any) string
	full = func(n map[string]any) string {
		if p, ok := n["parent_id"].(string); ok {
			return full(byID[p]) + "/" + n["title"].(string)
		}
		return n["title"].(string)
	}
	out := map[string]map[string]any{}
	for _, n := range nodes {
		out[full(n)] = n
	}
	return out
}

func (e *testEnv) docMarkdown(id string) string {
	e.t.Helper()
	_, d := e.do(e.admin, "GET", "/api/docs/"+id, nil)
	return d["markdown"].(string)
}

func TestImportFolder(t *testing.T) {
	e := newEnv(t)
	repo := e.newRepo()
	code, res, body := e.importFiles(repo, "",
		importPart{"notes/intro.md", "---\ntitle: 简介\ntags: [a, b]\n---\n# 简介\n\nsee [guide](sub/guide%20one.md#part) and ![pic](img/a.png)\n\n```\n[x](sub/guide one.md)\n```\n`[y](img/a.png)` [[Guide One]] ![[a.png|200]] [[nowhere]]\n"},
		importPart{"notes/sub/guide one.md", "# other heading\n\nback to [intro](../intro.md) <img src=\"../img/a.png\">\n\n[ref]: ../intro.md\n[^1]: a footnote\n"},
		importPart{"notes/sub.md", "parent of sub/"},
		importPart{"notes/img/a.png", "PNG"},
		importPart{"notes/img/unused.png", "nope"},
		importPart{"notes/.obsidian/app.json", "{}"},
		importPart{"notes/10 ten.md", "10"},
		importPart{"notes/2 two.md", "2"},
	)
	if code != 201 {
		t.Fatalf("import: %d %s", code, body)
	}
	if res.Docs != 5 || res.Groups != 1 || res.Attachments != 1 {
		t.Fatalf("result: %+v", res)
	}
	if len(res.Missing) != 1 || !strings.Contains(res.Missing[0], "nowhere") {
		t.Fatalf("missing: %v", res.Missing)
	}
	tree := e.treeByPath(repo)
	intro, guide := tree["notes/简介"], tree["notes/sub/guide one"]
	if intro == nil || guide == nil || tree["notes/sub"]["type"] != "doc" || tree["notes"]["type"] != "group" {
		t.Fatalf("tree: %v", tree)
	}
	if tree["notes/2 two"]["sort"].(float64) > tree["notes/10 ten"]["sort"].(float64) {
		t.Fatal("natural order")
	}
	gid, iid := guide["id"].(string), intro["id"].(string)

	md := e.docMarkdown(iid)
	if strings.Contains(md, "# 简介") || !strings.HasPrefix(md, "```yaml\ntags: [a, b]\n```") {
		t.Fatalf("front matter / title heading: %q", md)
	}
	if !strings.Contains(md, "[guide](/r/"+repo+"/d/"+gid+"#part)") {
		t.Fatalf("doc link: %q", md)
	}
	att := regexp.MustCompile(`!\[pic\]\((/files/[0-9a-z]{20}/a\.png)\)`).FindStringSubmatch(md)
	if att == nil {
		t.Fatalf("image: %q", md)
	}
	if !strings.Contains(md, "```\n[x](sub/guide one.md)\n```") || !strings.Contains(md, "`[y](img/a.png)`") {
		t.Fatalf("code was rewritten: %q", md)
	}
	if !strings.Contains(md, "[guide one](/r/"+repo+"/d/"+gid+")") || !strings.Contains(md, "![]("+att[1]+")") || !strings.Contains(md, "[[nowhere]]") {
		t.Fatalf("wikilinks: %q", md)
	}

	gmd := e.docMarkdown(gid)
	if !strings.HasPrefix(gmd, "# other heading") || !strings.Contains(gmd, "[intro](/r/"+repo+"/d/"+iid+")") ||
		!strings.Contains(gmd, `<img src="`+att[1]+`">`) || !strings.Contains(gmd, "[ref]: /r/"+repo+"/d/"+iid) || !strings.Contains(gmd, "[^1]: a footnote") {
		t.Fatalf("guide: %q", gmd)
	}
	// links are recorded: the intro has a backlink from the guide
	_, raw := e.raw(e.admin, "GET", "/api/nodes/"+iid+"/backlinks", nil)
	if !strings.Contains(string(raw), gid) {
		t.Fatalf("backlinks: %s", raw)
	}
	// and the documents are searchable
	_, raw = e.raw(e.admin, "GET", "/api/search?q=footnote", nil)
	if !strings.Contains(string(raw), gid) {
		t.Fatalf("search: %s", raw)
	}
}

func TestImportZipRoundTrip(t *testing.T) {
	e := newEnv(t)
	repo, doc := e.repoWithDoc("hello ![a](" + "/files/" + e.upload("p.png", "img") + "/p.png)")
	_, child := e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repo, "parent_id": doc, "type": "doc", "title": "child", "markdown": "up: [D](/r/" + repo + "/d/" + doc + ")"})
	_ = child
	_, zipData := e.raw(e.admin, "GET", "/api/repos/"+repo+"/export", nil)

	target := e.newRepo()
	_, g := e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": target, "type": "group", "title": "G"})
	code, res, body := e.importFiles(target, g["id"].(string), importPart{"kb.zip", string(zipData)})
	if code != 201 || res.Docs != 2 || res.Groups != 0 || res.Attachments != 1 {
		t.Fatalf("import: %d %s", code, body)
	}
	tree := e.treeByPath(target)
	d, c := tree["G/D"], tree["G/D/child"]
	if d == nil || c == nil {
		t.Fatalf("tree: %v", tree)
	}
	if md := e.docMarkdown(c["id"].(string)); md != "up: [D](/r/"+target+"/d/"+d["id"].(string)+")" {
		t.Fatalf("child: %q", md)
	}
	if md := e.docMarkdown(d["id"].(string)); !regexp.MustCompile(`^hello !\[a\]\(/files/[0-9a-z]{20}/p\.png\)$`).MatchString(md) {
		t.Fatalf("doc: %q", md)
	}
}

func TestImportEncodingsAndErrors(t *testing.T) {
	e := newEnv(t)
	repo := e.newRepo()
	gbk, _ := simplifiedchinese.GBK.NewEncoder().String("中文内容\r\n第二行")
	var zbuf bytes.Buffer
	zw := zip.NewWriter(&zbuf)
	name, _ := simplifiedchinese.GBK.NewEncoder().String("目录/笔记 0123456789abcdef0123456789abcdef.md")
	fw, _ := zw.CreateHeader(&zip.FileHeader{Name: name, NonUTF8: true})
	fw.Write([]byte("\xEF\xBB\xBFzip 内容"))
	zw.Close()
	code, res, body := e.importFiles(repo, "", importPart{"gbk.md", gbk}, importPart{"z.zip", zbuf.String()})
	if code != 201 || res.Docs != 2 {
		t.Fatalf("import: %d %s", code, body)
	}
	tree := e.treeByPath(repo)
	if md := e.docMarkdown(tree["gbk"]["id"].(string)); md != "中文内容\n第二行" {
		t.Fatalf("gbk: %q", md)
	}
	if n := tree["目录/笔记"]; n == nil || e.docMarkdown(n["id"].(string)) != "zip 内容" {
		t.Fatalf("zip names: %v", tree)
	}

	if code, _, _ := e.importFiles(repo, "", importPart{"a.png", "x"}); code != 400 {
		t.Fatalf("no markdown: %d", code)
	}
	if code, _, _ := e.importFiles(repo, "nope", importPart{"a.md", "x"}); code != 400 {
		t.Fatalf("bad parent: %d", code)
	}
	if code, _, _ := e.importFiles(repo, "", importPart{"../../etc/x.md", "x"}); code != 201 {
		t.Fatalf("escaping path: %d", code)
	}
	if e.treeByPath(repo)["etc/x"] == nil {
		t.Fatal("escaping path should be rooted")
	}
}

func TestNaturalCompare(t *testing.T) {
	for _, c := range [][2]string{{"2", "10"}, {"a2b", "a10a"}, {"A", "b"}, {"x", "x1"}, {"第2章", "第10章"}} {
		if naturalCompare(c[0], c[1]) >= 0 || naturalCompare(c[1], c[0]) <= 0 {
			t.Errorf("%q < %q", c[0], c[1])
		}
	}
}
