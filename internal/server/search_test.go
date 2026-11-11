package server

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientIPUsesLastForwardedEntry(t *testing.T) {
	s := &Server{cfg: Config{TrustProxy: true}}
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.1:1234"
	// the first entry is whatever the client sent; the proxy appended the real address
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 203.0.113.9")
	if ip := s.clientIP(r); ip != "203.0.113.9" {
		t.Fatalf("ip = %q", ip)
	}
	s.cfg.TrustProxy = false
	if ip := s.clientIP(r); ip != "10.0.0.1" {
		t.Fatalf("untrusted proxy: ip = %q", ip)
	}
}

func TestIndexFold(t *testing.T) {
	// "İ" lower-cases to a different byte length, which used to shift the offset
	body := "İİİ Hello 世界"
	i := indexFold(body, "hello")
	if i < 0 || body[i:i+5] != "Hello" {
		t.Fatalf("indexFold = %d", i)
	}
	if s := makeSnippet(body, "hello"); !strings.Contains(s, "\x01Hello\x02") {
		t.Fatalf("snippet = %q", s)
	}
	if indexFold(body, "nope") != -1 {
		t.Fatal("unexpected match")
	}
}

func TestSearchFindsTableRecords(t *testing.T) {
	e := newEnv(t)
	_, id := e.newTable("任务")
	_, tb := e.table("/api/tables/" + id)
	primary := tb.Fields[0].ID
	code, m := e.ops(id,
		map[string]any{"op": "field.create", "id": "fsel000001", "name": "状态", "type": "select",
			"options": map[string]any{"choices": []map[string]any{{"id": "cho0000001", "name": "进行中的事项", "color": 0}}}, "sort": 10},
		map[string]any{"op": "record.create", "id": "rec0000001", "data": map[string]any{primary: "采购云服务器", "fsel000001": "cho0000001"}, "sort": 10},
	)
	if code != 200 {
		t.Fatalf("ops: %d %v", code, m)
	}
	e.srv.indexPending(now() + tableIndexDelay.Milliseconds() + 1)
	for _, q := range []string{"云服务器", "进行中的事项", "云服"} {
		code, raw := e.raw(e.admin, "GET", "/api/search?q="+q, nil)
		if code != 200 || !strings.Contains(string(raw), id) {
			t.Fatalf("search %q: %d %s", q, code, raw)
		}
	}
}
