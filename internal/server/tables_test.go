package server

import (
	"encoding/json"
	"strings"
	"testing"
)

type tableResp struct {
	ID      string   `json:"id"`
	RepoID  string   `json:"repo_id"`
	Fields  []Field  `json:"fields"`
	Views   []View   `json:"views"`
	Records []Record `json:"records"`
}

func (e *testEnv) table(path string) (int, tableResp) {
	e.t.Helper()
	code, raw := e.raw(e.admin, "GET", path, nil)
	var t tableResp
	json.Unmarshal(raw, &t)
	return code, t
}

func (e *testEnv) newTable(title string) (repoID, tableID string) {
	e.t.Helper()
	_, r := e.do(e.admin, "POST", "/api/repos", map[string]string{"name": "R"})
	repoID = r["id"].(string)
	code, n := e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repoID, "type": "table", "title": title})
	if code != 201 {
		e.t.Fatalf("create table: %d %v", code, n)
	}
	return repoID, n["id"].(string)
}

func (e *testEnv) ops(tableID string, ops ...map[string]any) (int, map[string]any) {
	e.t.Helper()
	return e.do(e.admin, "POST", "/api/tables/"+tableID+"/ops", map[string]any{"ops": ops})
}

func TestTableLifecycle(t *testing.T) {
	e := newEnv(t)
	_, id := e.newTable("任务")
	code, tb := e.table("/api/tables/"+id)
	if code != 200 || len(tb.Fields) != 3 || len(tb.Views) != 1 || len(tb.Records) != 3 {
		t.Fatalf("defaults: %d %+v", code, tb)
	}
	primary := tb.Fields[0].ID
	if tb.Records[2].Seq != 3 {
		t.Fatalf("seq: %+v", tb.Records)
	}

	code, m := e.ops(id,
		map[string]any{"op": "field.create", "id": "fnum000001", "name": "数量", "type": "number", "options": map[string]any{"precision": 1}, "sort": 10},
		map[string]any{"op": "record.create", "id": "rec0000001", "data": map[string]any{primary: "苹果", "fnum000001": 3}, "sort": 10},
		map[string]any{"op": "record.update", "id": "rec0000001", "data": map[string]any{"fnum000001": 4.5}},
	)
	if code != 200 {
		t.Fatalf("ops: %d %v", code, m)
	}
	_, tb = e.table("/api/tables/"+id)
	last := tb.Records[len(tb.Records)-1]
	var data map[string]any
	json.Unmarshal(last.Data, &data)
	if last.ID != "rec0000001" || last.Seq != 4 || data[primary] != "苹果" || data["fnum000001"] != 4.5 {
		t.Fatalf("record: %+v %v", last, data)
	}

	// null in a patch removes the value, deleting a field strips it from records
	e.ops(id, map[string]any{"op": "record.update", "id": "rec0000001", "data": map[string]any{primary: nil}})
	e.ops(id, map[string]any{"op": "field.delete", "id": "fnum000001"})
	_, tb = e.table("/api/tables/"+id)
	if got := string(tb.Records[len(tb.Records)-1].Data); got != "{}" {
		t.Fatalf("data after removals: %s", got)
	}
	if code, _ := e.ops(id, map[string]any{"op": "field.delete", "id": primary}); code != 400 {
		t.Fatalf("primary field deleted: %d", code)
	}
	if code, _ := e.ops(id, map[string]any{"op": "view.delete", "id": tb.Views[0].ID}); code != 400 {
		t.Fatalf("last view deleted: %d", code)
	}
	// a failing op rolls back the whole batch
	e.ops(id,
		map[string]any{"op": "record.delete", "id": tb.Records[0].ID},
		map[string]any{"op": "field.create", "id": "bad", "type": "nope"},
	)
	if _, tb2 := e.table("/api/tables/"+id); len(tb2.Records) != len(tb.Records) {
		t.Fatalf("batch not atomic")
	}
	// ops on a doc are rejected
	_, docID := e.repoWithDoc("x")
	if code, _ := e.ops(docID, map[string]any{"op": "record.delete", "id": "abcdefgh"}); code != 404 {
		t.Fatalf("ops on doc: %d", code)
	}
}

func TestTableShareAndEmbed(t *testing.T) {
	e := newEnv(t)
	repoID, id := e.newTable("T")
	_, tb := e.table("/api/tables/"+id)
	e.ops(id, map[string]any{"op": "view.create", "id": "view000002", "name": "看板", "type": "kanban", "sort": 2})

	_, sh := e.do(e.admin, "POST", "/api/shares", map[string]any{"target_type": "node", "target_id": id, "view_id": "view000002"})
	token := sh["token"].(string)
	visitor := newClient()
	if _, info := e.do(visitor, "GET", "/api/s/"+token, nil); info["node_type"] != "table" {
		t.Fatalf("info: %v", info)
	}
	code, raw := e.raw(visitor, "GET", "/api/s/"+token+"/tables/"+id, nil)
	var pub tableResp
	json.Unmarshal(raw, &pub)
	if code != 200 || len(pub.Views) != 1 || pub.Views[0].ID != "view000002" || len(pub.Records) != 3 {
		t.Fatalf("public table: %d %s", code, raw)
	}

	// a shared doc exposes the tables it embeds, and nothing else
	_, other := e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repoID, "type": "table", "title": "secret"})
	md := "intro\n\n```table\n{\"table\":\"" + id + "\",\"view\":\"" + tb.Views[0].ID + "\"}\n```\n"
	_, doc := e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repoID, "type": "doc", "title": "D", "markdown": md})
	_, dsh := e.do(e.admin, "POST", "/api/shares", map[string]any{"target_type": "node", "target_id": doc["id"]})
	dt := dsh["token"].(string)
	if code, _ := e.raw(visitor, "GET", "/api/s/"+dt+"/tables/"+id, nil); code != 200 {
		t.Fatalf("embedded table: %d", code)
	}
	if code, _ := e.raw(visitor, "GET", "/api/s/"+dt+"/tables/"+other["id"].(string), nil); code != 404 {
		t.Fatalf("unrelated table leaked: %d", code)
	}
}

func TestTableExport(t *testing.T) {
	e := newEnv(t)
	repoID, id := e.newTable("清单")
	_, tb := e.table("/api/tables/"+id)
	f := tb.Fields
	var opts struct {
		Choices []struct{ ID string } `json:"choices"`
	}
	json.Unmarshal(f[1].Options, &opts)
	e.ops(id,
		map[string]any{"op": "record.update", "id": tb.Records[0].ID, "data": map[string]any{f[0].ID: "a|b", f[1].ID: opts.Choices[1].ID, f[2].ID: "2026-11-10"}},
		map[string]any{"op": "view.update", "id": tb.Views[0].ID, "config": map[string]any{"hidden": []string{f[2].ID}}},
	)
	md := "```table\n{\"table\":\"" + id + "\",\"view\":\"" + tb.Views[0].ID + "\"}\n```"
	got := e.srv.portableMarkdown(md)
	if !strings.Contains(got, "| 名称 | 状态 |\n| --- | --- |\n| a\\|b | 进行中 |") || strings.Contains(got, "日期") {
		t.Fatalf("embed markdown:\n%s", got)
	}

	code, data := e.raw(e.admin, "GET", "/api/repos/"+repoID+"/export", nil)
	if code != 200 {
		t.Fatalf("export: %d", code)
	}
	csv := readZip(t, data)["清单.csv"]
	if !strings.HasPrefix(csv, "\uFEFF名称,状态,日期\r\na|b,进行中,2026-11-10\r\n") {
		t.Fatalf("csv: %q", csv)
	}
}
