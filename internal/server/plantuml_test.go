package server

import (
	"bytes"
	"compress/flate"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// plantumlDecode reverses plantumlEncode (as the PlantUML server does).
func plantumlDecode(t *testing.T, s string) string {
	var data []byte
	for i := 0; i+3 < len(s); i += 4 {
		c := [4]byte{}
		for k := 0; k < 4; k++ {
			c[k] = byte(strings.IndexByte(pumlAlphabet, s[i+k]))
		}
		data = append(data, c[0]<<2|c[1]>>4, c[1]<<4|c[2]>>2, c[2]<<6|c[3])
	}
	out, err := io.ReadAll(flate.NewReader(bytes.NewReader(data)))
	if err != nil && !strings.Contains(err.Error(), "unexpected EOF") {
		t.Fatalf("inflate: %v", err)
	}
	return string(out)
}

func TestPlantUML(t *testing.T) {
	var hits atomic.Int32
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		var src string
		if r.Method == "POST" {
			b, _ := io.ReadAll(r.Body)
			src = string(b)
		} else {
			src = plantumlDecode(t, strings.TrimPrefix(r.URL.Path, "/svg/"))
		}
		if strings.Contains(src, "oops") {
			w.WriteHeader(400)
			w.Write([]byte(`<svg><text>Syntax Error?</text></svg>`))
			return
		}
		w.Write([]byte(`<svg><text>` + src + `</text></svg>`))
	}))
	defer fake.Close()

	e := newEnv(t, func(c *Config) { c.PlantUMLURL = fake.URL + "/" })
	src := "@startuml\nAlice -> Bob: 你好\n@enduml"
	code, m := e.do(e.admin, "POST", "/api/plantuml", map[string]string{"source": src})
	if code != 200 || !strings.Contains(m["svg"].(string), "Alice -> Bob: 你好") || m["error"] == true {
		t.Fatalf("render: %d %v", code, m)
	}
	// cached
	e.do(e.admin, "POST", "/api/plantuml", map[string]string{"source": src})
	if hits.Load() != 1 {
		t.Fatalf("hits: %d", hits.Load())
	}
	// syntax errors come back as an error svg, not cached
	code, m = e.do(e.admin, "POST", "/api/plantuml", map[string]string{"source": "@startuml\noops\n@enduml"})
	if code != 200 || m["error"] != true || !strings.Contains(m["svg"].(string), "Syntax Error") {
		t.Fatalf("syntax error: %d %v", code, m)
	}
	// long sources are posted
	var sb strings.Builder
	sb.WriteString("@startuml")
	for i := 0; i < 300; i++ {
		sum := sha256.Sum256([]byte{byte(i), byte(i >> 8)})
		sb.WriteString("\nA -> B: " + hex.EncodeToString(sum[:]))
	}
	long := sb.String() + "\n@enduml"
	if code, m = e.do(e.admin, "POST", "/api/plantuml", map[string]string{"source": long}); code != 200 || !strings.Contains(m["svg"].(string), long) {
		t.Fatalf("long: %d", code)
	}
	if code, _ := e.do(newClient(), "POST", "/api/plantuml", map[string]string{"source": src}); code != 401 {
		t.Fatalf("anonymous render: %d", code)
	}

	// share visitors render only diagrams in the shared docs (also nested in a callout)
	_, docID := e.repoWithDoc("intro\n\n> [!INFO]\n> ```plantuml\n> @startuml\n> Alice -> Bob: 你好\n> @enduml\n> ```\n")
	_, sh := e.do(e.admin, "POST", "/api/shares", map[string]any{"target_type": "node", "target_id": docID})
	token := sh["token"].(string)
	visitor := newClient()
	if code, m := e.do(visitor, "POST", "/api/s/"+token+"/plantuml", map[string]string{"source": src}); code != 200 || m["svg"] == nil {
		t.Fatalf("share render: %d %v", code, m)
	}
	if code, _ := e.do(visitor, "POST", "/api/s/"+token+"/plantuml", map[string]string{"source": "@startuml\nEve -> Bob\n@enduml"}); code != 404 {
		t.Fatalf("share render of foreign source: %d", code)
	}

	off := newEnv(t)
	if code, _ := off.do(off.admin, "POST", "/api/plantuml", map[string]string{"source": src}); code != 503 {
		t.Fatalf("unconfigured: %d", code)
	}
}
