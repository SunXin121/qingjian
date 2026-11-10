package server

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"strings"
	"testing"
	"time"
)

func randomDoc(rng *rand.Rand, paras int) string {
	words := []string{"青简", "知识库", "文档", "版本", "增量", "the", "quick", "fox", "```", "", "- item", "# 标题", "| a | b |"}
	var b strings.Builder
	for i := 0; i < paras; i++ {
		n := 1 + rng.Intn(12)
		for j := 0; j < n; j++ {
			b.WriteString(words[rng.Intn(len(words))])
			b.WriteByte(' ')
		}
		b.WriteString("\n")
		if rng.Intn(3) == 0 {
			b.WriteString("\n")
		}
	}
	return b.String()
}

// mutate applies a few random line edits, inserts, deletes and block moves.
func mutate(rng *rand.Rand, s string) string {
	ls := strings.SplitAfter(s, "\n")
	for k := rng.Intn(6); k >= 0; k-- {
		if len(ls) == 0 {
			ls = append(ls, "new\n")
			continue
		}
		i := rng.Intn(len(ls))
		switch rng.Intn(4) {
		case 0:
			ls[i] = fmt.Sprintf("edited %d\n", rng.Int())
		case 1:
			ls = append(ls[:i], append([]string{"inserted line\n"}, ls[i:]...)...)
		case 2:
			ls = append(ls[:i], ls[i+1:]...)
		case 3:
			j := min(len(ls), i+1+rng.Intn(5))
			block := append([]string{}, ls[i:j]...)
			rest := append(append([]string{}, ls[:i]...), ls[j:]...)
			p := rng.Intn(len(rest) + 1)
			ls = append(rest[:p], append(block, rest[p:]...)...)
		}
	}
	out := strings.Join(ls, "")
	if rng.Intn(4) == 0 {
		out = strings.TrimSuffix(out, "\n") // no trailing newline
	}
	return out
}

func TestDeltaRoundTrip(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	cases := [][2]string{{"", ""}, {"", "a"}, {"a", ""}, {"a\nb\n", "a\nb"}, {"x\n\n\n", "\n\nx\n"}}
	doc := randomDoc(rng, 200)
	for i := 0; i < 300; i++ {
		next := mutate(rng, doc)
		cases = append(cases, [2]string{doc, next})
		doc = next
	}
	for i, c := range cases {
		d := makeDelta(c[0], c[1])
		got, err := applyDelta(c[0], d)
		if err != nil || got != c[1] {
			t.Fatalf("case %d: err=%v\nbase=%q\nwant=%q\ngot =%q\ndelta=%s", i, err, c[0], c[1], got, d)
		}
	}
	if _, err := applyDelta("a\n", `[[0,5]]`); err == nil {
		t.Fatal("out of range copy accepted")
	}
}

func TestDeltaIsSmallForSmallEdits(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	base := randomDoc(rng, 20000) // ~ 1 MB
	next := strings.Replace(base, "\n", "\nan edit in the middle\n", 1)
	next = next[:len(next)/2] + "\nanother edit\n" + next[len(next)/2:]
	start := time.Now()
	d := makeDelta(base, next)
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("delta of a 1 MB document took %v", el)
	}
	if len(d) > 2000 {
		t.Fatalf("delta for two small edits is %d bytes (doc %d bytes)", len(d), len(base))
	}
}

func (e *testEnv) newDoc(md string) string {
	e.t.Helper()
	_, r := e.do(e.admin, "POST", "/api/repos", map[string]string{"name": "R"})
	code, n := e.do(e.admin, "POST", "/api/nodes", map[string]any{"repo_id": r["id"], "type": "doc", "markdown": md})
	if code != 201 {
		e.t.Fatalf("create doc: %d", code)
	}
	return n["id"].(string)
}

func (e *testEnv) saveDoc(id, md string) {
	e.t.Helper()
	if code, r := e.do(e.admin, "PUT", "/api/docs/"+id, map[string]any{"markdown": md, "snapshot": true}); code != 200 {
		e.t.Fatalf("save: %d %v", code, r)
	}
}

func TestVersionsStoredAsDeltas(t *testing.T) {
	e := newEnv(t)
	rng := rand.New(rand.NewSource(3))
	doc := randomDoc(rng, 400)
	id := e.newDoc(doc)
	saved := []string{}
	for i := 0; i < maxVersions+40; i++ {
		doc = mutate(rng, doc) + fmt.Sprintf("v%d\n", i) // always different
		e.saveDoc(id, doc)
		saved = append(saved, doc)
	}
	// most versions are deltas, the oldest kept one is full, and the count is capped
	var total, deltas, oldestDelta int
	e.srv.db.QueryRow(`SELECT COUNT(*), SUM(delta) FROM doc_versions WHERE node_id = ?`, id).Scan(&total, &deltas)
	e.srv.db.QueryRow(`SELECT delta FROM doc_versions WHERE node_id = ? ORDER BY id LIMIT 1`, id).Scan(&oldestDelta)
	if total != maxVersions || oldestDelta != 0 || deltas < total*9/10 {
		t.Fatalf("total=%d deltas=%d oldestDelta=%d", total, deltas, oldestDelta)
	}
	// every listed version rebuilds to exactly what was saved
	var list []Version
	code, raw := e.raw(e.admin, "GET", "/api/docs/"+id+"/versions", nil)
	if code != 200 {
		t.Fatal(code)
	}
	mustJSON(t, raw, &list)
	for i, v := range list {
		want := saved[len(saved)-1-i]
		var got Version
		_, raw := e.raw(e.admin, "GET", fmt.Sprintf("/api/versions/%d", v.ID), nil)
		mustJSON(t, raw, &got)
		if got.Markdown != want || v.Size != len([]rune(want)) {
			t.Fatalf("version %d (#%d) differs: size %d", v.ID, i, v.Size)
		}
	}
	// restoring an old version (a delta) works and is itself undoable
	old := list[len(list)-1]
	if code, _ := e.do(e.admin, "POST", fmt.Sprintf("/api/versions/%d/restore", old.ID), nil); code != 200 {
		t.Fatal(code)
	}
	_, d := e.do(e.admin, "GET", "/api/docs/"+id, nil)
	if d["markdown"] != saved[len(saved)-maxVersions] {
		t.Fatal("restore produced different content")
	}
}

func TestCompactLegacyVersions(t *testing.T) {
	e := newEnv(t)
	rng := rand.New(rand.NewSource(4))
	doc := randomDoc(rng, 300)
	id := e.newDoc("")
	var want []string
	// history written the old way: every version a full copy
	for i := 0; i < 120; i++ {
		doc = mutate(rng, doc) + fmt.Sprintf("v%d\n", i)
		want = append(want, doc)
		e.srv.db.Exec(`INSERT INTO doc_versions(node_id, title, markdown, created_at, size) VALUES(?,?,?,?,?)`, id, "", doc, int64(i+1), len([]rune(doc)))
	}
	e.srv.setSetting("versions_compacted", "")
	e.srv.compactVersions()
	var deltas int
	e.srv.db.QueryRow(`SELECT SUM(delta) FROM doc_versions WHERE node_id = ?`, id).Scan(&deltas)
	if deltas < 100 {
		t.Fatalf("only %d of 120 versions compacted", deltas)
	}
	rows, _ := e.srv.db.Query(`SELECT id FROM doc_versions WHERE node_id = ? ORDER BY id`, id)
	var ids []int64
	for rows.Next() {
		var x int64
		rows.Scan(&x)
		ids = append(ids, x)
	}
	rows.Close()
	for i, vid := range ids {
		got, err := versionText(e.srv.db, vid)
		if err != nil || got != want[i] {
			t.Fatalf("version %d after compaction: %v", i, err)
		}
	}
}

func TestDeferredIndexOfLongDocs(t *testing.T) {
	e := newEnv(t)
	short := e.newDoc("短文档里的独特词汇甲乙丙")
	long := e.newDoc(strings.Repeat("填充内容填充内容。\n", 10000))
	search := func(q string) int {
		var hits []SearchHit
		_, raw := e.raw(e.admin, "GET", "/api/search?q="+q, nil)
		mustJSON(t, raw, &hits)
		return len(hits)
	}
	if search("独特词汇甲乙丙") != 1 {
		t.Fatal("short document not indexed on create")
	}
	e.do(e.admin, "PUT", "/api/docs/"+long, map[string]any{"markdown": strings.Repeat("填充内容填充内容。\n", 10000) + "长文档末尾的标记丁戊己"})
	e.do(e.admin, "PUT", "/api/docs/"+short, map[string]any{"markdown": "改过的短文档庚辛壬"})
	if search("改过的短文档庚辛壬") != 1 {
		t.Fatal("short document not reindexed on save")
	}
	var pending int
	e.srv.db.QueryRow(`SELECT COUNT(*) FROM fts_pending WHERE node_id = ?`, long).Scan(&pending)
	if pending != 1 {
		t.Fatal("long document not queued")
	}
	e.srv.indexPending(now() + ftsQuietPeriod.Milliseconds() + 1)
	if search("长文档末尾的标记丁戊己") != 1 {
		t.Fatal("long document not indexed after the quiet period")
	}
	e.srv.db.QueryRow(`SELECT COUNT(*) FROM fts_pending`).Scan(&pending)
	if pending != 0 {
		t.Fatal("queue not drained")
	}
}

func TestAPIGzip(t *testing.T) {
	e := newEnv(t)
	e.newDoc(strings.Repeat("内容", 5000))
	req, _ := http.NewRequest("GET", e.ts.URL+"/api/repos", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	// the transport only decompresses transparently when it added the header itself
	resp, err := e.admin.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("api json not compressed: %v", resp.Header)
	}
	// the normal client path still decodes it
	if code, list := e.raw(e.admin, "GET", "/api/repos", nil); code != 200 || !strings.HasPrefix(string(list), "[") {
		t.Fatalf("%d %s", code, list)
	}
}

func mustJSON(t *testing.T, raw []byte, v any) {
	t.Helper()
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("decode %q: %v", raw, err)
	}
}
