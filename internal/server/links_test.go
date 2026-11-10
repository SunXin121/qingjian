package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestBacklinks(t *testing.T) {
	e := newEnv(t)
	repoID, target := e.repoWithDoc("# 目标")
	_, n := e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repoID, "type": "doc", "title": "来源",
		"markdown": "开头\n\n- 参见 [目标文档](/r/" + repoID + "/d/" + target + ") 的 **说明**\n- 再次 [链接](https://note.example.com/r/" + repoID + "/d/" + target + "#h)\n"})
	src := n["id"].(string)
	_, n = e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repoID, "type": "doc", "title": "其他", "markdown": "无关"})
	other := n["id"].(string)

	backlinks := func(id string) []Backlink {
		_, raw := e.raw(e.admin, "GET", "/api/nodes/"+id+"/backlinks", nil)
		var out []Backlink
		json.Unmarshal(raw, &out)
		return out
	}
	bl := backlinks(target)
	if len(bl) != 1 || bl[0].ID != src || bl[0].Title != "来源" || bl[0].Snippet != "参见 目标文档 的 说明" {
		t.Fatalf("backlinks: %+v", bl)
	}

	// saving updates the links
	e.saveDoc(other, "也链接 [x](/r/"+repoID+"/d/"+target+")")
	e.saveDoc(src, "不再链接")
	bl = backlinks(target)
	if len(bl) != 1 || bl[0].ID != other {
		t.Fatalf("after saves: %+v", bl)
	}
	// documents in the trash do not count
	e.do(e.admin, "DELETE", "/api/nodes/"+other, nil)
	if bl = backlinks(target); len(bl) != 0 {
		t.Fatalf("trashed source: %+v", bl)
	}

	// finding nodes to link to: title prefix first
	e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repoID, "type": "table", "title": "旧来源表"})
	_, raw := e.raw(e.admin, "GET", "/api/nodes/find?q=来源", nil)
	var found []NodeRef
	json.Unmarshal(raw, &found)
	if len(found) != 2 || found[0].ID != src || found[0].Type != "doc" || found[1].Type != "table" {
		t.Fatalf("find: %s", raw)
	}
	_, raw = e.raw(e.admin, "GET", "/api/nodes/find?q=%25", nil)
	if json.Unmarshal(raw, &found); len(found) != 0 {
		t.Fatalf("find %%: %s", raw)
	}
}

func TestLinkSnippet(t *testing.T) {
	long := strings.Repeat("前", 60) + "[目标](/r/r1/d/abc123) 后"
	got := linkSnippet("x\n"+long, "abc123")
	if !strings.HasPrefix(got, "…") || !strings.HasSuffix(got, "目标 后") || len([]rune(got)) != 1+40+4 {
		t.Fatalf("snippet: %q", got)
	}
	if got := linkSnippet("[a](/r/r1/d/other1)", "abc123"); got != "" {
		t.Fatalf("no link: %q", got)
	}
}

func TestExportRelativeLinks(t *testing.T) {
	e := newEnv(t)
	repoID, target := e.repoWithDoc("# 目标")
	_, g := e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repoID, "type": "group", "title": "子目录"})
	gid := g["id"].(string)
	e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repoID, "parent_id": gid, "type": "doc", "title": "来源",
		"markdown": "见 [目标](/r/" + repoID + "/d/" + target + ") 和 [外部](/r/zzzzzz/d/missing1)"})
	_, data := e.raw(e.admin, "GET", "/api/repos/"+repoID+"/export", nil)
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range zr.File {
		if f.Name != "子目录/来源.md" {
			continue
		}
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		if got := string(b); !strings.Contains(got, "[目标](../D.md)") || !strings.Contains(got, "[外部](/r/zzzzzz/d/missing1)") {
			t.Fatalf("links: %s", got)
		}
		return
	}
	t.Fatal("source doc not exported")
}
