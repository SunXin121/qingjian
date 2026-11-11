package server

import (
	"database/sql"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Addr          string
	DataDir       string
	AdminPassword string
	MaxUploadMB   int64
	TrustProxy    bool
	TrashDays     int
	Version       string
	// draw.io editor: either a URL (default embed.diagrams.net) or a local directory with
	// the draw.io webapp, which is then served from /drawio/.
	DrawioURL string
	DrawioDir string
	// PlantUML: base URL of a plantuml-server (e.g. http://plantuml:8080); empty disables it.
	PlantUMLURL string
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
	blobMu        sync.Mutex // serialises blob creation against attachment cleanup
	puml          pumlCache
	icons         iconSets
	stop          chan struct{}  // closed by Close: background workers return
	workers       sync.WaitGroup // workers that use the database (Close waits for them)
	indexDone     chan struct{}
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
	s := &Server{cfg: cfg, db: db, filesDir: filesDir, static: static, limiter: newLoginLimiter(), stop: make(chan struct{}), indexDone: make(chan struct{})}
	if err := s.initAuth(); err != nil {
		return nil, err
	}
	if err := s.backfillLinks(); err != nil {
		db.Close()
		return nil, err
	}
	if err := s.backfillTableIndex(); err != nil {
		db.Close()
		return nil, err
	}
	go s.housekeeping()
	s.workers.Add(2)
	go func() {
		defer s.workers.Done()
		s.indexLoop()
	}()
	go func() {
		defer s.workers.Done()
		s.compactVersions()
	}()
	return s, nil
}

func (s *Server) Close() error {
	close(s.stop)
	s.workers.Wait()
	return s.db.Close()
}

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
	mux.Handle("POST /api/repos/{id}/import", a(s.importDocs))

	mux.Handle("POST /api/nodes", a(s.createNode))
	mux.Handle("PATCH /api/nodes/{id}", a(s.updateNode))
	mux.Handle("POST /api/nodes/{id}/move", a(s.moveNode))
	mux.Handle("DELETE /api/nodes/{id}", a(s.deleteNode))
	mux.Handle("GET /api/nodes/{id}/backlinks", a(s.backlinks))
	mux.Handle("GET /api/nodes/find", a(s.findNodes))

	mux.Handle("GET /api/docs/{id}", a(s.getDoc))
	mux.Handle("PUT /api/docs/{id}", a(s.saveDoc))
	mux.Handle("GET /api/docs/{id}/export", a(s.exportDoc))
	mux.Handle("GET /api/docs/{id}/versions", a(s.listVersions))
	mux.Handle("GET /api/versions/{vid}", a(s.getVersion))
	mux.Handle("POST /api/versions/{vid}/restore", a(s.restoreVersion))

	mux.Handle("GET /api/tables", a(s.listTables))
	mux.Handle("GET /api/tables/{id}", a(s.getTable))
	mux.Handle("POST /api/tables/{id}/ops", a(s.tableOps))
	mux.Handle("GET /api/tables/{id}/records/{rid}/history", a(s.recordHistory))

	mux.Handle("GET /api/recent", a(s.recentDocs))
	mux.Handle("GET /api/search", a(s.search))

	mux.Handle("GET /api/trash", a(s.listTrash))
	mux.Handle("POST /api/trash/{kind}/{id}/restore", a(s.restoreTrash))
	mux.Handle("DELETE /api/trash/{kind}/{id}", a(s.purgeTrash))

	mux.Handle("POST /api/files", a(s.uploadFile))
	mux.Handle("GET /api/files/stats", a(s.storageStats))
	mux.Handle("POST /api/files/cleanup", a(s.cleanupFiles))
	mux.HandleFunc("GET /files/{id}/{name...}", s.serveFile)
	mux.HandleFunc("GET /icons/{set}/{name}", s.serveIcon)

	mux.Handle("GET /api/shares", a(s.listShares))
	mux.Handle("POST /api/shares", a(s.createShare))
	mux.Handle("PATCH /api/shares/{token}", a(s.updateShare))
	mux.Handle("POST /api/shares/{token}/regenerate", a(s.regenerateShare))
	mux.Handle("DELETE /api/shares/{token}", a(s.deleteShare))

	// visitor endpoints: no admin session, guarded per share
	mux.HandleFunc("GET /api/s/{token}", s.shareInfo)
	mux.HandleFunc("POST /api/s/{token}/auth", s.shareAuth)
	mux.HandleFunc("GET /api/s/{token}/tree", s.shareTree)
	mux.HandleFunc("GET /api/s/{token}/docs/{id}", s.shareDoc)
	mux.HandleFunc("GET /api/s/{token}/tables/{id}", s.shareTable)
	mux.HandleFunc("POST /api/s/{token}/plantuml", s.sharePlantUML)

	mux.Handle("GET /api/imgbed", a(s.getImgbed))
	mux.Handle("PUT /api/imgbed", a(s.putImgbed))
	mux.Handle("POST /api/imgbed/forget", a(s.forgetImgbed))
	mux.Handle("GET /api/config", a(s.clientConfig))
	mux.Handle("POST /api/plantuml", a(s.plantUML))

	if s.cfg.DrawioDir != "" {
		mux.Handle("GET /drawio/", http.StripPrefix("/drawio/", http.FileServer(http.Dir(s.cfg.DrawioDir))))
	}

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { httpError(w, http.StatusNotFound, "not found") })
	mux.HandleFunc("/", s.serveStatic)

	return securityHeaders(gzipJSON(mux))
}

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "same-origin")
		hd.Set("X-Frame-Options", "SAMEORIGIN")
		// a personal knowledge base (and its share links) should never end up in search engines
		hd.Set("X-Robots-Tag", "noindex, nofollow")
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
				} else if strings.HasPrefix(p, "icons/") {
					w.Header().Set("Cache-Control", "public, max-age=86400")
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
	w.Header().Set("Content-Security-Policy", s.pageCSP())
	serveStaticFile(w, r, s.static, "index.html")
}

// pageCSP is the policy of the app page. Documents render user-written markdown, SVG and
// diagrams, so this is the backstop should a sanitiser ever miss something: scripts only
// from this origin (never inline; plus the Cloudflare Web Analytics beacon), no plugins,
// no foreign frames except the draw.io editor.
// Images and media may come from anywhere, since documents embed external pictures.
func (s *Server) pageCSP() string {
	frames := "'self' blob:"
	if s.cfg.DrawioDir == "" {
		drawio := s.cfg.DrawioURL
		if drawio == "" {
			drawio = "https://embed.diagrams.net/"
		}
		if u, err := url.Parse(drawio); err == nil && u.Host != "" {
			frames += " " + u.Scheme + "://" + u.Host
		}
	}
	return strings.Join([]string{
		"default-src 'self'",
		// Cloudflare Web Analytics: injected by the proxy when the site sits behind Cloudflare
		"script-src 'self' 'wasm-unsafe-eval' blob: https://static.cloudflareinsights.com",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob: https: http:",
		"media-src 'self' data: blob: https: http:",
		// esm.sh: Excalidraw lists its CDN as the second source of every font face; the
		// bundled fonts are used, but the browser reports each blocked alternative
		"font-src 'self' data: https://esm.sh",
		"connect-src 'self' data: blob: https://cloudflareinsights.com",
		"worker-src 'self' blob:",
		"frame-src " + frames,
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'self'",
	}, "; ")
}

// clientConfig exposes the settings the frontend needs.
func (s *Server) clientConfig(w http.ResponseWriter, r *http.Request) {
	drawio := s.cfg.DrawioURL
	if s.cfg.DrawioDir != "" {
		drawio = "/drawio/"
	}
	if drawio == "" {
		drawio = "https://embed.diagrams.net/"
	}
	writeJSON(w, 200, map[string]any{
		"version":       s.cfg.Version,
		"drawio_url":    drawio,
		"max_upload_mb": s.cfg.MaxUploadMB,
		"trash_days":    s.cfg.TrashDays,
		"plantuml":      s.cfg.PlantUMLURL != "",
		"imgbed":        s.imgbedConfig().enabled(),
	})
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
