package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestRestrictedShareData(t *testing.T) {
	e := newEnv(t)
	repo, id := e.newTable("public")
	_, tb := e.table("/api/tables/" + id)
	primary, secret, date := tb.Fields[0].ID, tb.Fields[1].ID, tb.Fields[2].ID
	view := tb.Views[0].ID
	config := map[string]any{"hidden": []string{secret, date}, "filter": map[string]any{"conj": "and", "conds": []any{map[string]any{"field": primary, "op": "is", "value": "allowed"}}}}
	code, out := e.ops(id,
		map[string]any{"op": "record.update", "id": tb.Records[0].ID, "data": map[string]any{primary: "allowed", date: "private-date"}},
		map[string]any{"op": "record.update", "id": tb.Records[1].ID, "data": map[string]any{primary: "secret-row"}},
		map[string]any{"op": "view.update", "id": view, "config": config},
		map[string]any{"op": "view.create", "id": "otherview1", "name": "other", "type": "grid", "config": map[string]any{}},
	)
	if code != http.StatusOK {
		t.Fatalf("ops: %d %v", code, out)
	}
	share := func(target string, viewID string) string {
		body := map[string]any{"target_type": "node", "target_id": target}
		if viewID != "" {
			body["view_id"] = viewID
		}
		code, sh := e.do(e.admin, "POST", "/api/shares", body)
		if code != http.StatusCreated {
			t.Fatalf("share: %d %v", code, sh)
		}
		return sh["token"].(string)
	}
	token := share(id, view)
	visitor := newClient()
	assertPrivate := func(token, query string) {
		t.Helper()
		code, raw := e.raw(visitor, "GET", "/api/s/"+token+"/tables/"+id+query, nil)
		var data tableResp
		if err := json.Unmarshal(raw, &data); err != nil {
			t.Fatal(err)
		}
		if code != http.StatusOK || len(data.Fields) != 1 || len(data.Records) != 1 || data.Records[0].ID != tb.Records[0].ID || len(data.Views) != 1 || data.Views[0].ID != view {
			t.Fatalf("projection: %d %s", code, raw)
		}
		if strings.Contains(string(raw), "private-date") || strings.Contains(string(raw), "secret-row") || strings.Contains(string(data.Records[0].Data), secret) || strings.Contains(string(data.Views[0].Config), "allowed") {
			t.Fatalf("private value leaked: %s", raw)
		}
	}
	assertPrivate(token, "")
	if code, _ := e.raw(visitor, "GET", "/api/s/"+token+"/tables/"+id+"?view=otherview1", nil); code != http.StatusUnprocessableEntity {
		t.Fatalf("view override: %d", code)
	}
	md := "```table\n{\"table\":\"" + id + "\",\"view\":\"" + view + "\"}\n```"
	_, doc := e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repo, "type": "doc", "title": "embed", "markdown": md})
	docToken := share(doc["id"].(string), "")
	assertPrivate(docToken, "")
	assertPrivate(docToken, "?view="+view)
	if code, _ := e.raw(visitor, "GET", "/api/s/"+docToken+"/tables/"+id+"?view=otherview1", nil); code != http.StatusUnprocessableEntity {
		t.Fatalf("embed override: %d", code)
	}
	// Whole-table sharing deliberately retains its wider scope.
	full := share(id, "")
	if code, raw := e.raw(visitor, "GET", "/api/s/"+full+"/tables/"+id, nil); code != http.StatusOK || !strings.Contains(string(raw), "secret-row") {
		t.Fatalf("whole table: %d %s", code, raw)
	}
	// Unsupported browser-only expressions must fail closed at the HTTP boundary.
	e.ops(id, map[string]any{"op": "view.update", "id": view, "config": map[string]any{"filter": map[string]any{"conj": "or", "conds": []any{map[string]any{"op": "expr", "value": "true"}}}}})
	for _, tok := range []string{token, docToken} {
		if code, raw := e.raw(visitor, "GET", "/api/s/"+tok+"/tables/"+id, nil); code != http.StatusUnprocessableEntity || strings.Contains(string(raw), "secret-row") {
			t.Fatalf("unsupported filter: %d %s", code, raw)
		}
	}

	// A deleted view must never silently fall back to an unrestricted one.
	e.ops(id, map[string]any{"op": "view.delete", "id": view})
	if code, _ := e.raw(visitor, "GET", "/api/s/"+token+"/tables/"+id, nil); code != http.StatusUnprocessableEntity {
		t.Fatalf("deleted view: %d", code)
	}
}

func TestShareViewFilters(t *testing.T) {
	cases := []struct {
		name, typ, op string
		value, target any
		want          bool
	}{
		{"numeric", "number", "gte", 5.0, 4.0, true},
		{"numeric missing", "number", "is_not", nil, 4.0, true},
		{"progress percent", "progress", "is", 0.5, 50.0, true},
		{"select", "select", "is", "one", []any{"one"}, true},
		{"multi", "multiselect", "not_contains", []any{"one"}, []any{"two"}, true},
		{"text", "text", "contains", "Hello World", " WORLD ", true},
		{"empty false", "checkbox", "is", false, false, true},
		{"missing checkbox target", "checkbox", "is", true, nil, false},
		{"missing checkbox value", "checkbox", "is", nil, nil, true},
		{"empty list", "multiselect", "empty", []any{}, nil, true},
		{"date", "date", "lt", "2026-01-02", "2026-01-03", true},
		{"attachment", "attachment", "contains", []any{map[string]any{"name": "REPORT.pdf"}}, "report", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			raw, _ := json.Marshal(map[string]any{"field": c.value})
			tb := &TableData{Fields: []Field{{ID: "field", Type: c.typ, Options: json.RawMessage(`{}`)}}}
			test, err := shareCondition(tb, shareCond{Field: "field", Op: c.op, Value: c.target})
			if err != nil || test == nil {
				t.Fatalf("condition: %v", err)
			}
			if got := test(&Record{Data: raw}); got != c.want {
				t.Fatalf("got %v want %v", got, c.want)
			}
		})
	}
	for _, typ := range []string{"formula", "lookup", "rollup", "link"} {
		tb := &TableData{Fields: []Field{{ID: "field", Type: typ}}}
		if _, err := shareCondition(tb, shareCond{Field: "field", Op: "is", Value: "x"}); err == nil {
			t.Fatalf("unsupported %s allowed", typ)
		}
	}
	tb := &TableData{Fields: []Field{{ID: "field", Type: "text"}}}
	if _, err := shareCondition(tb, shareCond{Op: "expr", Value: "true"}); err == nil {
		t.Fatal("expression allowed")
	}
}

func TestShareFilterBeforeHiddenProjection(t *testing.T) {
	for _, conj := range []string{"and", "or"} {
		t.Run(conj, func(t *testing.T) {
			table := &TableData{
				Fields: []Field{{ID: "title", Type: "text"}, {ID: "private", Type: "number"}},
				Views:  []View{{ID: "view", Config: json.RawMessage(`{"hidden":["private"],"filter":{"conj":"` + conj + `","conds":[{"field":"private","op":"gte","value":5},{"field":"title","op":"is","value":"yes"}]}}`)}},
				Records: []Record{
					{ID: "both", Data: json.RawMessage(`{"title":"yes","private":6}`)},
					{ID: "number", Data: json.RawMessage(`{"title":"no","private":8}`)},
					{ID: "title", Data: json.RawMessage(`{"title":"yes","private":1}`)},
					{ID: "neither", Data: json.RawMessage(`{"title":"no","private":1}`)},
				},
			}
			if err := restrictShareView(table, "view"); err != nil {
				t.Fatal(err)
			}
			want := 1
			if conj == "or" {
				want = 3
			}
			if len(table.Records) != want || len(table.Fields) != 1 {
				t.Fatalf("projection: %+v", table)
			}
			for _, record := range table.Records {
				if strings.Contains(string(record.Data), "private") {
					t.Fatalf("hidden value: %s", record.Data)
				}
			}
		})
	}
}

func TestLinkedTableRespectsEmbeddedView(t *testing.T) {
	e := newEnv(t)
	repo, a := e.newTable("A")
	_, b := e.newTable("B")
	_, at := e.table("/api/tables/" + a)
	_, bt := e.table("/api/tables/" + b)
	primary, private := bt.Fields[0].ID, bt.Fields[2].ID
	code, result := e.ops(b,
		map[string]any{"op": "record.update", "id": bt.Records[0].ID, "data": map[string]any{primary: "secret-row", private: "private-date"}},
		map[string]any{"op": "record.update", "id": bt.Records[1].ID, "data": map[string]any{primary: "public-row", private: "private-date"}},
		map[string]any{"op": "view.update", "id": bt.Views[0].ID, "config": map[string]any{"hidden": []string{private}, "filter": map[string]any{"conj": "and", "conds": []any{map[string]any{"field": primary, "op": "is", "value": "public-row"}}}}},
	)
	if code != http.StatusOK {
		t.Fatalf("B: %d %v", code, result)
	}
	code, result = e.ops(a,
		map[string]any{"op": "field.create", "id": "linkfield1", "name": "B", "type": "link", "options": map[string]any{"table": b, "multiple": true}, "sort": 10},
		map[string]any{"op": "field.create", "id": "lookupfld1", "name": "Private", "type": "lookup", "options": map[string]any{"link": "linkfield1", "target": private}, "sort": 11},
		map[string]any{"op": "record.update", "id": at.Records[0].ID, "data": map[string]any{"linkfield1": []string{bt.Records[0].ID, bt.Records[1].ID}}},
	)
	if code != http.StatusOK {
		t.Fatalf("A: %d %v", code, result)
	}
	md := "```table\n{\"table\":\"" + a + "\",\"view\":\"" + at.Views[0].ID + "\"}\n```\n\n```table\n{\"table\":\"" + b + "\",\"view\":\"" + bt.Views[0].ID + "\"}\n```"
	_, doc := e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": repo, "type": "doc", "title": "tables", "markdown": md})
	_, sh := e.do(e.admin, "POST", "/api/shares", map[string]any{"target_type": "node", "target_id": doc["id"]})
	code, raw := e.raw(newClient(), "GET", "/api/s/"+sh["token"].(string)+"/tables/"+a, nil)
	if code != http.StatusOK {
		t.Fatalf("share: %d %s", code, raw)
	}
	var data struct {
		Linked map[string]tableResp `json:"linked"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	linked := data.Linked[b]
	if len(linked.Records) != 1 || linked.Records[0].ID != bt.Records[1].ID || len(linked.Fields) != 1 {
		t.Fatalf("linked projection: %s", raw)
	}
	if strings.Contains(string(raw), "private-date") || strings.Contains(string(raw), "secret-row") {
		t.Fatalf("linked data leaked: %s", raw)
	}
}
