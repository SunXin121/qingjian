package server

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"sync"
)

// The embedded frontend is immutable, so each compressible file is gzipped at most once
// and kept in memory (only files that are actually requested).
var gzCache sync.Map // path → []byte

var compressible = map[string]bool{".js": true, ".css": true, ".html": true, ".svg": true, ".json": true, ".wasm": true, ".txt": true, ".map": true}

func serveStaticFile(w http.ResponseWriter, r *http.Request, fsys fs.FS, name string) {
	ext := path.Ext(name)
	if !compressible[ext] || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		http.ServeFileFS(w, r, fsys, name)
		return
	}
	var data []byte
	if v, ok := gzCache.Load(name); ok {
		data = v.([]byte)
	} else {
		f, err := fsys.Open(name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		raw, err := io.ReadAll(f)
		f.Close()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		zw.Write(raw)
		zw.Close()
		data = buf.Bytes()
		gzCache.Store(name, data)
	}
	h := w.Header()
	ct := mime.TypeByExtension(ext)
	if ct == "" {
		ct = "application/octet-stream"
	}
	h.Set("Content-Type", ct)
	h.Set("Content-Encoding", "gzip")
	h.Add("Vary", "Accept-Encoding")
	if r.Method == http.MethodHead {
		return
	}
	w.Write(data)
}
