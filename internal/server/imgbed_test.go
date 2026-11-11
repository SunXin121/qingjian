package server

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestImgbedExport(t *testing.T) {
	var uploads atomic.Int32
	var gotQuery, gotAuth, gotType string
	bed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/upload" || r.Method != "POST" {
			http.NotFound(w, r)
			return
		}
		f, h, err := r.FormFile("file")
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		io.Copy(io.Discard, f)
		uploads.Add(1)
		gotQuery, gotAuth, gotType = r.URL.RawQuery, r.Header.Get("Authorization"), h.Header.Get("Content-Type")
		w.Write([]byte(`[{"src":"/file/x_` + h.Filename + `"}]`))
	}))
	defer bed.Close()

	e := newEnv(t)
	img := e.upload("pic one.png", "\x89PNG\r\n\x1a\nfake")
	repoID, docID := e.repoWithDoc("![](/files/" + img + "/pic%20one.png)\n\nagain ![](/files/" + img + "/pic%20one.png)")

	// not configured yet
	if code, _ := e.raw(e.admin, "GET", "/api/docs/"+docID+"/export?imgbed=1", nil); code != 502 {
		t.Fatalf("export without image host: %d", code)
	}
	if code, _ := e.do(e.admin, "PUT", "/api/imgbed", map[string]string{"url": "ftp://x"}); code != 400 {
		t.Fatalf("bad url accepted: %d", code)
	}
	if code, _ := e.do(e.admin, "PUT", "/api/imgbed", map[string]string{"url": bed.URL + "/", "auth_code": "AC", "token": "TK", "folder": "/notes/"}); code != 200 {
		t.Fatalf("save config: %d", code)
	}
	_, cfg := e.do(e.admin, "GET", "/api/config", nil)
	if cfg["imgbed"] != true {
		t.Fatalf("config: %v", cfg)
	}

	code, md := e.raw(e.admin, "GET", "/api/docs/"+docID+"/export?imgbed=1", nil)
	if code != 200 {
		t.Fatalf("export: %d %s", code, md)
	}
	want := bed.URL + "/file/x_pic%20one.png"
	if strings.Count(string(md), "![]("+want+")") != 2 {
		t.Fatalf("markdown: %s", md)
	}
	if uploads.Load() != 1 {
		t.Fatalf("uploads: %d", uploads.Load())
	}
	if !strings.Contains(gotQuery, "authCode=AC") || !strings.Contains(gotQuery, "uploadFolder=notes") || gotAuth != "Bearer TK" || gotType != "image/png" {
		t.Fatalf("request: %s %s %s", gotQuery, gotAuth, gotType)
	}

	// repo export: no assets/, already uploaded files are reused
	code, data := e.raw(e.admin, "GET", "/api/repos/"+repoID+"/export?imgbed=1", nil)
	if code != 200 {
		t.Fatalf("repo export: %d", code)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "assets/") {
			t.Fatalf("unexpected %s", f.Name)
		}
	}
	if uploads.Load() != 1 {
		t.Fatalf("file uploaded twice: %d", uploads.Load())
	}

	// forgetting the records uploads again
	e.do(e.admin, "POST", "/api/imgbed/forget", nil)
	e.raw(e.admin, "GET", "/api/docs/"+docID+"/export?imgbed=1", nil)
	if uploads.Load() != 2 {
		t.Fatalf("uploads after forget: %d", uploads.Load())
	}
}

func TestImgbedUploadError(t *testing.T) {
	bed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"Unauthorized"}`))
	}))
	defer bed.Close()
	e := newEnv(t)
	img := e.upload("a.png", "x")
	_, docID := e.repoWithDoc("![](/files/" + img + "/a.png)")
	e.do(e.admin, "PUT", "/api/imgbed", map[string]string{"url": bed.URL})
	code, body := e.raw(e.admin, "GET", "/api/docs/"+docID+"/export?imgbed=1", nil)
	if code != 502 || !strings.Contains(string(body), "Unauthorized") {
		t.Fatalf("got %d %s", code, body)
	}
}
