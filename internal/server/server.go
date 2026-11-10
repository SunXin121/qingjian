package server

import (
	"database/sql"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

type Config struct {
	Addr          string
	DataDir       string
	AdminPassword string
	MaxUploadMB   int64
	TrustProxy    bool
	TrashDays     int
}

type Server struct {
	cfg           Config
	db            *sql.DB
	filesDir      string
	static        fs.FS
	secret        []byte
	pwFingerprint []byte
	storedHash    string
	limiter       *loginLimiter
}

func New(cfg Config, static fs.FS) (*Server, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, err
	}
	filesDir := filepath.Join(cfg.DataDir, "files")
	if err := os.MkdirAll(filepath.Join(filesDir, "tmp"), 0o755); err != nil {
		return nil, err
	}
	db, err := openDB(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	s := &Server{cfg: cfg, db: db, filesDir: filesDir, static: static, limiter: newLoginLimiter()}
	if err := s.initAuth(); err != nil {
		return nil, err
	}
	go s.housekeeping()
	return s, nil
}

func (s *Server) Close() error { return s.db.Close() }

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	a := s.requireAdmin

	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/auth/me", s.handleMe)

	mux.Handle("GET /api/repos", a(s.listRepos))
	mux.Handle("POST /api/repos", a(s.createRepo))
	mux.Handle("GET /api/repos/{id}", a(s.getRepo))
	mux.Handle("PATCH /api/repos/{id}", a(s.updateRepo))
	mux.Handle("DELETE /api/repos/{id}", a(s.deleteRepo))
	mux.Handle("GET /api/repos/{id}/tree", a(s.repoTree))
	mux.Handle("GET /api/repos/{id}/export", a(s.exportRepo))

	mux.Handle("POST /api/nodes", a(s.createNode))
	mux.Handle("PATCH /api/nodes/{id}", a(s.updateNode))
	mux.Handle("POST /api/nodes/{id}/move", a(s.moveNode))
	mux.Handle("DELETE /api/nodes/{id}", a(s.deleteNode))

	mux.Handle("GET /api/docs/{id}", a(s.getDoc))
	mux.Handle("PUT /api/docs/{id}", a(s.saveDoc))
	mux.Handle("GET /api/docs/{id}/export", a(s.exportDoc))
	mux.Handle("GET /api/docs/{id}/versions", a(s.listVersions))
	mux.Handle("GET /api/versions/{vid}", a(s.getVersion))
	mux.Handle("POST /api/versions/{vid}/restore", a(s.restoreVersion))

	mux.Handle("GET /api/recent", a(s.recentDocs))
	mux.Handle("GET /api/search", a(s.search))

	mux.Handle("GET /api/trash", a(s.listTrash))
	mux.Handle("POST /api/trash/{kind}/{id}/restore", a(s.restoreTrash))
	mux.Handle("DELETE /api/trash/{kind}/{id}", a(s.purgeTrash))

	mux.Handle("POST /api/files", a(s.uploadFile))
	mux.HandleFunc("GET /files/{id}/{name...}", s.serveFile)

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { httpError(w, http.StatusNotFound, "not found") })
	mux.HandleFunc("/", s.serveStatic)

	return securityHeaders(mux)
}

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "same-origin")
		hd.Set("X-Frame-Options", "SAMEORIGIN")
		h.ServeHTTP(w, r)
	})
}

// serveStatic serves the embedded SPA, falling back to index.html for client routes.
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if s.static == nil {
		http.NotFound(w, r)
		return
	}
	p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if p != "" {
		if f, err := s.static.Open(p); err == nil {
			st, _ := f.Stat()
			f.Close()
			if st != nil && !st.IsDir() {
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				serveStaticFile(w, r, s.static, p)
				return
			}
		}
		if strings.HasPrefix(p, "assets/") {
			http.NotFound(w, r)
			return
		}
	}
	w.Header().Set("Cache-Control", "no-cache")
	serveStaticFile(w, r, s.static, "index.html")
}

func (s *Server) housekeeping() {
	t := time.NewTicker(6 * time.Hour)
	defer t.Stop()
	for {
		if s.cfg.TrashDays > 0 {
			if n, err := s.purgeExpiredTrash(time.Duration(s.cfg.TrashDays) * 24 * time.Hour); err != nil {
				log.Printf("trash cleanup: %v", err)
			} else if n > 0 {
				log.Printf("trash cleanup: purged %d items", n)
			}
		}
		<-t.C
	}
}
