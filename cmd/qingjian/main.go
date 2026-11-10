package main

import (
	"context"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"qingjian/internal/server"
	"qingjian/web"
)

// version is set at build time via -ldflags "-X main.version=..."
var version = "dev"

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int64) int64 {
	if v, err := strconv.ParseInt(os.Getenv(key), 10, 64); err == nil && v > 0 {
		return v
	}
	return def
}

func main() {
	cfg := server.Config{
		Addr:          env("QINGJIAN_ADDR", ":8080"),
		DataDir:       env("QINGJIAN_DATA", "./data"),
		AdminPassword: os.Getenv("QINGJIAN_ADMIN_PASSWORD"),
		MaxUploadMB:   envInt("QINGJIAN_MAX_UPLOAD_MB", 100),
		TrustProxy:    env("QINGJIAN_TRUST_PROXY", "") == "1",
		TrashDays:     int(envInt("QINGJIAN_TRASH_DAYS", 30)),
		Version:       version,
		DrawioURL:     os.Getenv("QINGJIAN_DRAWIO_URL"),
		DrawioDir:     os.Getenv("QINGJIAN_DRAWIO_DIR"),
		Backup: server.BackupConfig{
			IntervalHours:  int(envInt("QINGJIAN_BACKUP_INTERVAL_HOURS", 24)),
			Keep:           int(envInt("QINGJIAN_BACKUP_KEEP", 7)),
			Dir:            os.Getenv("QINGJIAN_BACKUP_DIR"),
			WebDAVURL:      os.Getenv("QINGJIAN_BACKUP_WEBDAV_URL"),
			WebDAVUser:     os.Getenv("QINGJIAN_BACKUP_WEBDAV_USER"),
			WebDAVPassword: os.Getenv("QINGJIAN_BACKUP_WEBDAV_PASSWORD"),
			S3Endpoint:     os.Getenv("QINGJIAN_BACKUP_S3_ENDPOINT"),
			S3Region:       os.Getenv("QINGJIAN_BACKUP_S3_REGION"),
			S3Bucket:       os.Getenv("QINGJIAN_BACKUP_S3_BUCKET"),
			S3Prefix:       os.Getenv("QINGJIAN_BACKUP_S3_PREFIX"),
			S3AccessKey:    os.Getenv("QINGJIAN_BACKUP_S3_ACCESS_KEY"),
			S3SecretKey:    os.Getenv("QINGJIAN_BACKUP_S3_SECRET_KEY"),
		},
	}

	static, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		log.Fatal(err)
	}
	if _, err := fs.Stat(static, "index.html"); err != nil {
		log.Printf("warning: frontend not built (web/dist/index.html missing); only the API is served")
		static = nil
	}

	srv, err := server.New(cfg, static)
	if err != nil {
		log.Fatal(err)
	}
	defer srv.Close()

	hs := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		log.Printf("Qingjian %s listening on %s (data: %s)", version, cfg.Addr, cfg.DataDir)
		if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	hs.Shutdown(ctx)
}
