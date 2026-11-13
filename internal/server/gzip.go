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
			serverError(w, r, err)
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

// gzipJSON compresses JSON API responses for clients that accept gzip. Tables and
// directory trees are sent whole, and JSON of a big table shrinks to about a tenth.
// Other responses (files, exports, the frontend, which has its own cache) pass through.
func gzipJSON(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			h.ServeHTTP(w, r)
			return
		}
		w.Header().Add("Vary", "Accept-Encoding")
		gw := &gzipJSONWriter{ResponseWriter: w}
		defer gw.close()
		h.ServeHTTP(gw, r)
	})
}

var gzipPool = sync.Pool{New: func() any {
	zw, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
	return zw
}}

type gzipJSONWriter struct {
	http.ResponseWriter
	decided bool
	zw      *gzip.Writer
}

func (g *gzipJSONWriter) WriteHeader(code int) {
	if !g.decided {
		g.decided = true
		hd := g.Header()
		if strings.HasPrefix(hd.Get("Content-Type"), "application/json") && hd.Get("Content-Encoding") == "" && code != http.StatusNoContent && code != http.StatusNotModified {
			hd.Del("Content-Length")
			hd.Set("Content-Encoding", "gzip")
			g.zw = gzipPool.Get().(*gzip.Writer)
			g.zw.Reset(g.ResponseWriter)
		}
	}
	g.ResponseWriter.WriteHeader(code)
}

func (g *gzipJSONWriter) Write(p []byte) (int, error) {
	if !g.decided {
		g.WriteHeader(http.StatusOK)
	}
	if g.zw != nil {
		return g.zw.Write(p)
	}
	return g.ResponseWriter.Write(p)
}

func (g *gzipJSONWriter) close() {
	if g.zw != nil {
		g.zw.Close()
		gzipPool.Put(g.zw)
		g.zw = nil
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (g *gzipJSONWriter) Unwrap() http.ResponseWriter { return g.ResponseWriter }
