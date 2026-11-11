package server

import (
	"encoding/json"
	"testing"
)

func TestEmptyTrash(t *testing.T) {
	e := newEnv(t)
	goneRepo, _ := e.repoWithDoc("a")
	keptRepo, keptDoc := e.repoWithDoc("b")
	_, n := e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": keptRepo, "type": "doc", "title": "X", "markdown": "x"})
	trashedDoc := n["id"].(string)

	e.do(e.admin, "DELETE", "/api/repos/"+goneRepo, nil)
	e.do(e.admin, "DELETE", "/api/nodes/"+trashedDoc, nil)
	trash := func() []TrashItem {
		_, body := e.raw(e.admin, "GET", "/api/trash", nil)
		var items []TrashItem
		if err := json.Unmarshal(body, &items); err != nil {
			t.Fatal(err)
		}
		return items
	}
	if got := len(trash()); got != 2 {
		t.Fatalf("trash before: %d items", got)
	}

	code, res := e.do(e.admin, "DELETE", "/api/trash", nil)
	if code != 200 || res["purged"] != float64(2) {
		t.Fatalf("empty trash: %d %v", code, res)
	}
	if got := len(trash()); got != 0 {
		t.Fatalf("trash after: %d items", got)
	}
	// gone for good: neither can be restored
	if code, _ := e.do(e.admin, "GET", "/api/docs/"+trashedDoc, nil); code != 404 {
		t.Fatalf("purged doc: %d", code)
	}
	if code, _ := e.do(e.admin, "GET", "/api/repos/"+goneRepo, nil); code != 404 {
		t.Fatalf("purged repo: %d", code)
	}
	// what was not in the trash stays
	if code, _ := e.do(e.admin, "GET", "/api/docs/"+keptDoc, nil); code != 200 {
		t.Fatalf("kept doc: %d", code)
	}
}
