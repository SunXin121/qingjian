package server

import (
	"encoding/json"
	"testing"
)

type linkedResp struct {
	tableResp
	Linked map[string]tableResp `json:"linked"`
}

func recByID(t tableResp, id string) map[string]any {
	for _, r := range t.Records {
		if r.ID == id {
			m := map[string]any{}
			json.Unmarshal(r.Data, &m)
			return m
		}
	}
	return nil
}

func fieldByID(t tableResp, id string) *Field {
	for i := range t.Fields {
		if t.Fields[i].ID == id {
			return &t.Fields[i]
		}
	}
	return nil
}

func TestTwoWayLinks(t *testing.T) {
	e := newEnv(t)
	repoID, a := e.newTable("项目")
	_, bn := e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repoID, "type": "table", "title": "任务"})
	b := bn["id"].(string)
	_, tb := e.table("/api/tables/" + b)
	b1, b2 := tb.Records[0].ID, tb.Records[1].ID
	_, ta := e.table("/api/tables/" + a)
	a1, a2 := ta.Records[0].ID, ta.Records[1].ID

	code, m := e.ops(a,
		map[string]any{"op": "field.create", "id": "flink00001", "name": "任务", "type": "link", "sort": 10,
			"options": map[string]any{"table": b, "pair": "fpair00001", "pairName": "所属项目"}},
		map[string]any{"op": "record.update", "id": a1, "data": map[string]any{"flink00001": []string{b1, b2}}},
		map[string]any{"op": "record.update", "id": a2, "data": map[string]any{"flink00001": []string{b1}}},
	)
	if code != 200 {
		t.Fatalf("ops: %d %v", code, m)
	}
	_, tb = e.table("/api/tables/" + b)
	pf := fieldByID(tb, "fpair00001")
	if pf == nil || pf.Name != "所属项目" || pf.Type != "link" {
		t.Fatalf("pair field: %+v", tb.Fields)
	}
	if o := parseOpts(pf.Options); o.Table != a || o.Pair != "flink00001" {
		t.Fatalf("pair options: %s", pf.Options)
	}
	if got := recByID(tb, b1)["fpair00001"]; len(got.([]any)) != 2 {
		t.Fatalf("b1 pair: %v", got)
	}
	_, ta = e.table("/api/tables/" + a)
	if o := parseOpts(fieldByID(ta, "flink00001").Options); o.PairName != "" || o.Pair != "fpair00001" {
		t.Fatalf("stored options: %+v", o)
	}

	// unlinking and deleting a record update the other side
	e.ops(a, map[string]any{"op": "record.update", "id": a1, "data": map[string]any{"flink00001": []string{b2}}})
	_, tb = e.table("/api/tables/" + b)
	if got := recByID(tb, b1)["fpair00001"].([]any); len(got) != 1 || got[0] != a2 {
		t.Fatalf("after unlink: %v", got)
	}
	e.ops(a, map[string]any{"op": "record.delete", "id": a2})
	_, tb = e.table("/api/tables/" + b)
	if _, ok := recByID(tb, b1)["fpair00001"]; ok {
		t.Fatalf("after delete: %v", recByID(tb, b1))
	}

	// editing from the other side mirrors back
	e.ops(b, map[string]any{"op": "record.update", "id": b1, "data": map[string]any{"fpair00001": []string{a1}}})
	_, ta = e.table("/api/tables/" + a)
	if got := recByID(ta, a1)["flink00001"].([]any); len(got) != 2 {
		t.Fatalf("mirror back: %v", got)
	}

	// the table comes with the linked table
	_, raw := e.raw(e.admin, "GET", "/api/tables/"+a, nil)
	var lr linkedResp
	json.Unmarshal(raw, &lr)
	if lt, ok := lr.Linked[b]; !ok || len(lt.Records) != 3 {
		t.Fatalf("linked: %s", raw)
	}

	// deleting one side turns the other into a one-way link
	e.ops(a, map[string]any{"op": "field.delete", "id": "flink00001"})
	_, tb = e.table("/api/tables/" + b)
	if o := parseOpts(fieldByID(tb, "fpair00001").Options); o.Pair != "" || o.Table != a {
		t.Fatalf("unpaired: %+v", o)
	}
}

func TestTwoWayBackfillAndShareTrim(t *testing.T) {
	e := newEnv(t)
	repoID, a := e.newTable("A")
	_, bn := e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repoID, "type": "table", "title": "B"})
	b := bn["id"].(string)
	_, tb := e.table("/api/tables/" + b)
	_, ta := e.table("/api/tables/" + a)
	b1 := tb.Records[0].ID
	secret := tb.Fields[1].ID // a field of B nothing in A reads
	e.ops(b, map[string]any{"op": "record.update", "id": b1, "data": map[string]any{tb.Fields[0].ID: "b-one"}})
	e.ops(b, map[string]any{"op": "record.update", "id": tb.Records[2].ID, "data": map[string]any{tb.Fields[0].ID: "unlinked"}})
	// one-way first, then switched to two-way: existing links are back-filled
	e.ops(a,
		map[string]any{"op": "field.create", "id": "flink00001", "name": "B", "type": "link", "sort": 10, "options": map[string]any{"table": b}},
		map[string]any{"op": "field.create", "id": "flook00001", "name": "日期", "type": "lookup", "sort": 11,
			"options": map[string]any{"link": "flink00001", "target": tb.Fields[2].ID}},
		map[string]any{"op": "record.update", "id": ta.Records[0].ID, "data": map[string]any{"flink00001": []string{b1}}},
	)
	if code, m := e.ops(a, map[string]any{"op": "field.update", "id": "flink00001", "options": map[string]any{"table": b, "pair": "fpair00001", "pairName": "A"}}); code != 200 {
		t.Fatalf("update: %d %v", code, m)
	}
	_, tb = e.table("/api/tables/" + b)
	if got, _ := recByID(tb, b1)["fpair00001"].([]any); len(got) != 1 || got[0] != ta.Records[0].ID {
		t.Fatalf("backfill: %v", recByID(tb, b1))
	}

	_, sh := e.do(e.admin, "POST", "/api/shares", map[string]any{"target_type": "node", "target_id": a})
	_, raw := e.raw(newClient(), "GET", "/api/s/"+sh["token"].(string)+"/tables/"+a, nil)
	var lr linkedResp
	json.Unmarshal(raw, &lr)
	lt, ok := lr.Linked[b]
	if !ok || len(lt.Records) != 1 || lt.Records[0].ID != b1 {
		t.Fatalf("share linked records: %s", raw)
	}
	if fieldByID(lt, secret) != nil || fieldByID(lt, tb.Fields[0].ID) == nil || fieldByID(lt, tb.Fields[2].ID) == nil {
		t.Fatalf("share linked fields: %+v", lt.Fields)
	}
	if _, ok := recByID(lt, b1)["fpair00001"]; ok {
		t.Fatalf("share leaked unneeded value: %v", recByID(lt, b1))
	}
}
