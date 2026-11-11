package server

import (
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestServeIcon(t *testing.T) {
	static := fstest.MapFS{
		"index.html":      {Data: []byte("<html>")},
		"icons/demo.json": {Data: []byte(`{"width":24,"height":24,"icons":{"book":"<path d=\"M1 1\"/>","wide":["<path/>",32,24,0,-2]}}`)},
	}
	srv, err := New(Config{DataDir: t.TempDir(), AdminPassword: "pw"}, static)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	h := srv.Handler()
	get := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		return w
	}
	w := get("/icons/demo/book.svg")
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/svg+xml" ||
		w.Body.String() != `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path d="M1 1"/></svg>` {
		t.Fatalf("book: %d %s", w.Code, w.Body)
	}
	if w := get("/icons/demo/wide.svg"); !strings.Contains(w.Body.String(), `viewBox="0 -2 32 24"`) {
		t.Fatalf("wide: %s", w.Body)
	}
	for _, p := range []string{"/icons/demo/missing.svg", "/icons/nope/book.svg", "/icons/demo/book", "/icons/..%2f/book.svg", "/icons/Demo/book.svg"} {
		if w := get(p); w.Code != 404 {
			t.Fatalf("%s: %d", p, w.Code)
		}
	}
	if w := get("/icons/demo.json"); w.Code != 200 || w.Header().Get("Cache-Control") == "" {
		t.Fatalf("set file: %d %v", w.Code, w.Header())
	}
}
