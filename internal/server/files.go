package server

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Attachment struct {
	ID        string `json:"id"`
	SHA256    string `json:"sha256"`
	Name      string `json:"name"`
	Mime      string `json:"mime"`
	Size      int64  `json:"size"`
	CreatedAt int64  `json:"created_at"`
	URL       string `json:"url"`
}

func fileURL(id, name string) string { return "/files/" + id + "/" + url.PathEscape(name) }

func (s *Server) blobPath(sum string) string {
	return filepath.Join(s.filesDir, sum[:2], sum[2:4], sum)
}

func sanitizeName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`/\:*?"<>|`, r) {
			return '_'
		}
		return r
	}, name)
	if name == "" || name == "." || name == ".." {
		name = "file"
	}
	if len(name) > 200 {
		ext := filepath.Ext(name)
		if len(ext) > 20 {
			ext = ""
		}
		name = name[:200-len(ext)] + ext
	}
	return name
}

func (s *Server) uploadFile(w http.ResponseWriter, r *http.Request) {
	limit := s.cfg.MaxUploadMB << 20
	r.Body = http.MaxBytesReader(w, r.Body, limit+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		httpError(w, http.StatusBadRequest, "需要 multipart/form-data")
		return
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			httpError(w, http.StatusBadRequest, "缺少 file 字段")
			return
		}
		if err != nil {
			httpError(w, http.StatusBadRequest, "上传失败："+err.Error())
			return
		}
		if part.FormName() != "file" {
			part.Close()
			continue
		}
		att, err := s.storeUpload(part, part.FileName(), part.Header.Get("Content-Type"), limit)
		part.Close()
		if err != nil {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) || errors.Is(err, errTooLarge) {
				httpError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("文件超过 %dMB 限制", s.cfg.MaxUploadMB))
				return
			}
			serverError(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, att)
		return
	}
}

var errTooLarge = errors.New("file too large")

func (s *Server) storeUpload(src io.Reader, name, contentType string, limit int64) (*Attachment, error) {
	tmp, err := os.CreateTemp(filepath.Join(s.filesDir, "tmp"), "up-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	head := make([]byte, 512)
	n, _ := io.ReadFull(src, head)
	head = head[:n]
	h.Write(head)
	tmp.Write(head)
	size, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(src, limit-int64(n)+1))
	size += int64(n)
	if err != nil {
		tmp.Close()
		return nil, err
	}
	if size > limit {
		tmp.Close()
		return nil, errTooLarge
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}
	sum := hex.EncodeToString(h.Sum(nil))
	dst := s.blobPath(sum)
	// held until the attachment row exists so cleanup can't remove the blob in between
	s.blobMu.Lock()
	defer s.blobMu.Unlock()
	if _, err := os.Stat(dst); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return nil, err
		}
		if err := os.Rename(tmp.Name(), dst); err != nil {
			return nil, err
		}
	}

	name = sanitizeName(name)
	mt := strings.TrimSpace(strings.Split(contentType, ";")[0])
	if mt == "" || mt == "application/octet-stream" {
		mt = mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
	}
	if mt == "" {
		mt = http.DetectContentType(head)
	}
	mt = strings.Split(mt, ";")[0]
	att := &Attachment{ID: randString(20), SHA256: sum, Name: name, Mime: mt, Size: size, CreatedAt: now()}
	if _, err := s.db.Exec(`INSERT INTO attachments(id, sha256, name, mime, size, created_at) VALUES(?,?,?,?,?,?)`,
		att.ID, att.SHA256, att.Name, att.Mime, att.Size, att.CreatedAt); err != nil {
		return nil, err
	}
	att.URL = fileURL(att.ID, att.Name)
	return att, nil
}

func (s *Server) loadAttachment(id string) (*Attachment, error) {
	var a Attachment
	err := s.db.QueryRow(`SELECT id, sha256, name, mime, size, created_at FROM attachments WHERE id = ?`, id).
		Scan(&a.ID, &a.SHA256, &a.Name, &a.Mime, &a.Size, &a.CreatedAt)
	if err != nil {
		return nil, err
	}
	a.URL = fileURL(a.ID, a.Name)
	return &a, nil
}

// inline-safe types are displayed in the browser; everything else downloads.
func inlineType(mt string) bool {
	switch {
	case strings.HasPrefix(mt, "image/"), strings.HasPrefix(mt, "video/"), strings.HasPrefix(mt, "audio/"),
		mt == "application/pdf", strings.HasPrefix(mt, "text/plain"), mt == "application/json":
		return true
	}
	return false
}

// serveFile serves attachments by their unguessable id. Responses are sandboxed so an
// uploaded SVG/HTML can never run script on this origin.
func (s *Server) serveFile(w http.ResponseWriter, r *http.Request) {
	a, err := s.loadAttachment(r.PathValue("id"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(s.blobPath(a.SHA256))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	hd := w.Header()
	hd.Set("Content-Type", a.Mime)
	hd.Set("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox")
	hd.Set("Cache-Control", "private, max-age=31536000, immutable")
	disp := "attachment"
	if inlineType(a.Mime) && r.URL.Query().Get("download") == "" {
		disp = "inline"
	}
	hd.Set("Content-Disposition", mime.FormatMediaType(disp, map[string]string{"filename": a.Name}))
	http.ServeContent(w, r, "", time.UnixMilli(a.CreatedAt), f)
}
