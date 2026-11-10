package server

import (
	"compress/gzip"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

// BackupConfig describes where scheduled backups go. Any combination of targets may be set.
type BackupConfig struct {
	IntervalHours int
	Keep          int // database snapshots kept per target

	Dir string // local directory

	WebDAVURL      string
	WebDAVUser     string
	WebDAVPassword string

	S3Endpoint  string // e.g. https://s3.us-east-1.amazonaws.com or http://minio:9000
	S3Region    string
	S3Bucket    string
	S3Prefix    string
	S3AccessKey string
	S3SecretKey string
}

// A backup target stores files under relative slash-separated names:
//
//	db/qingjian-20060102-150405.db.gz   database snapshots (rotated)
//	files/ab/cd/<sha256>                attachment blobs (append-only, uploaded once)
type backupTarget interface {
	Key() string  // stable identity, used for the uploaded-blob manifest
	Name() string // human readable
	Put(ctx context.Context, name string, f *os.File, size int64, sha string) error
	Delete(ctx context.Context, name string) error
}

type backupResult struct {
	Target   string `json:"target"`
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
	Snapshot string `json:"snapshot,omitempty"`
	Files    int    `json:"files"` // blobs uploaded this run
}

type backupReport struct {
	StartedAt  int64          `json:"started_at"`
	FinishedAt int64          `json:"finished_at"`
	OK         bool           `json:"ok"`
	Error      string         `json:"error,omitempty"`
	Results    []backupResult `json:"results"`
}

type backupRunner struct {
	s       *Server
	cfg     BackupConfig
	targets []backupTarget
	mu      sync.Mutex
	running bool
}

func newBackupRunner(s *Server, cfg BackupConfig) (*backupRunner, error) {
	b := &backupRunner{s: s, cfg: cfg}
	if b.cfg.Keep <= 0 {
		b.cfg.Keep = 7
	}
	if b.cfg.IntervalHours <= 0 {
		b.cfg.IntervalHours = 24
	}
	client := &http.Client{Timeout: 30 * time.Minute}
	if cfg.Dir != "" {
		dir, err := filepath.Abs(cfg.Dir)
		if err != nil {
			return nil, err
		}
		b.targets = append(b.targets, &localTarget{dir: dir})
	}
	if cfg.WebDAVURL != "" {
		u, err := url.Parse(cfg.WebDAVURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			return nil, fmt.Errorf("invalid WebDAV URL %q", cfg.WebDAVURL)
		}
		u.Path = strings.TrimSuffix(u.Path, "/") + "/"
		b.targets = append(b.targets, &webdavTarget{base: u, user: cfg.WebDAVUser, pass: cfg.WebDAVPassword, client: client, made: map[string]bool{}})
	}
	if cfg.S3Bucket != "" {
		ep := cfg.S3Endpoint
		region := nonEmpty(cfg.S3Region, "us-east-1")
		if ep == "" {
			ep = "https://s3." + region + ".amazonaws.com"
		}
		u, err := url.Parse(ep)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, fmt.Errorf("invalid S3 endpoint %q", ep)
		}
		if cfg.S3AccessKey == "" || cfg.S3SecretKey == "" {
			return nil, errors.New("S3 backup needs access key and secret key")
		}
		b.targets = append(b.targets, &s3Target{endpoint: u, region: region, bucket: cfg.S3Bucket,
			prefix: strings.Trim(cfg.S3Prefix, "/"), ak: cfg.S3AccessKey, sk: cfg.S3SecretKey, client: client})
	}
	return b, nil
}

func (b *backupRunner) enabled() bool { return len(b.targets) > 0 }

func (b *backupRunner) lastReport() *backupReport {
	v, ok := b.s.getSetting("backup_last")
	if !ok {
		return nil
	}
	var r backupReport
	if json.Unmarshal([]byte(v), &r) != nil {
		return nil
	}
	return &r
}

// loop runs backups on schedule. A failed run is retried after an hour.
func (b *backupRunner) loop() {
	if !b.enabled() {
		return
	}
	time.Sleep(2 * time.Minute)
	t := time.NewTicker(10 * time.Minute)
	defer t.Stop()
	for {
		due := true
		if last := b.lastReport(); last != nil {
			wait := time.Duration(b.cfg.IntervalHours) * time.Hour
			if !last.OK && wait > time.Hour {
				wait = time.Hour
			}
			due = time.Since(time.UnixMilli(last.StartedAt)) >= wait
		}
		if due {
			b.start()
		}
		<-t.C
	}
}

// start launches a run in the background; false if one is already running.
func (b *backupRunner) start() bool {
	b.mu.Lock()
	if b.running {
		b.mu.Unlock()
		return false
	}
	b.running = true
	b.mu.Unlock()
	go func() {
		defer func() {
			b.mu.Lock()
			b.running = false
			b.mu.Unlock()
		}()
		rep := b.run(context.Background())
		if rep.OK {
			log.Printf("backup: finished in %s", time.Duration(rep.FinishedAt-rep.StartedAt)*time.Millisecond)
		} else {
			log.Printf("backup: failed: %s", rep.Error)
		}
	}()
	return true
}

func (b *backupRunner) isRunning() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.running
}

func (b *backupRunner) run(ctx context.Context) *backupReport {
	rep := &backupReport{StartedAt: now(), OK: true}
	defer func() {
		rep.FinishedAt = now()
		if data, err := json.Marshal(rep); err == nil {
			b.s.setSetting("backup_last", string(data))
		}
	}()
	snap, size, sum, err := b.snapshotDB()
	if err != nil {
		rep.OK, rep.Error = false, "数据库快照失败："+err.Error()
		return rep
	}
	defer os.Remove(snap)
	name := "db/qingjian-" + time.UnixMilli(rep.StartedAt).Format("20060102-150405") + ".db.gz"
	var errs []string
	for _, t := range b.targets {
		res := b.runTarget(ctx, t, snap, name, size, sum)
		if !res.OK {
			rep.OK = false
			errs = append(errs, t.Name()+": "+res.Error)
		}
		rep.Results = append(rep.Results, res)
	}
	rep.Error = strings.Join(errs, "; ")
	return rep
}

// snapshotDB writes a consistent, gzipped copy of the database to a temp file.
func (b *backupRunner) snapshotDB() (file string, size int64, sum string, err error) {
	raw := filepath.Join(b.s.cfg.DataDir, "backup-"+randString(8)+".db")
	defer os.Remove(raw)
	if _, err := b.s.db.Exec(`VACUUM INTO ?`, raw); err != nil {
		return "", 0, "", err
	}
	src, err := os.Open(raw)
	if err != nil {
		return "", 0, "", err
	}
	defer src.Close()
	gzPath := raw + ".gz"
	dst, err := os.Create(gzPath)
	if err != nil {
		return "", 0, "", err
	}
	h := sha256.New()
	zw := gzip.NewWriter(io.MultiWriter(dst, h))
	_, err = io.Copy(zw, src)
	if err == nil {
		err = zw.Close()
	}
	if cerr := dst.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(gzPath)
		return "", 0, "", err
	}
	return gzPath, fileSize(gzPath), hex.EncodeToString(h.Sum(nil)), nil
}

func putFile(ctx context.Context, t backupTarget, name, p string, sha string) error {
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	return t.Put(ctx, name, f, st.Size(), sha)
}

func (b *backupRunner) runTarget(ctx context.Context, t backupTarget, snap, name string, size int64, sum string) backupResult {
	res := backupResult{Target: t.Name()}
	fail := func(err error) backupResult {
		res.Error = err.Error()
		return res
	}
	if err := putFile(ctx, t, name, snap, sum); err != nil {
		return fail(fmt.Errorf("上传数据库快照：%w", err))
	}
	res.Snapshot = name

	// attachment blobs not yet uploaded to this target
	rows, err := b.s.db.Query(`SELECT DISTINCT sha256 FROM attachments WHERE sha256 NOT IN (SELECT sha256 FROM backup_blobs WHERE target = ?)`, t.Key())
	if err != nil {
		return fail(err)
	}
	var pending []string
	for rows.Next() {
		var sha string
		rows.Scan(&sha)
		pending = append(pending, sha)
	}
	rows.Close()
	for _, sha := range pending {
		p := b.s.blobPath(sha)
		if _, err := os.Stat(p); err != nil {
			continue // removed by cleanup meanwhile
		}
		if err := putFile(ctx, t, "files/"+sha[:2]+"/"+sha[2:4]+"/"+sha, p, sha); err != nil {
			return fail(fmt.Errorf("上传附件：%w", err))
		}
		b.s.db.Exec(`INSERT OR IGNORE INTO backup_blobs(target, sha256) VALUES(?, ?)`, t.Key(), sha)
		res.Files++
	}

	// rotate database snapshots
	key := "backup_snapshots:" + t.Key()
	var snaps []string
	if v, ok := b.s.getSetting(key); ok {
		json.Unmarshal([]byte(v), &snaps)
	}
	snaps = append(snaps, name)
	for len(snaps) > b.cfg.Keep {
		if err := t.Delete(ctx, snaps[0]); err != nil {
			log.Printf("backup: rotate %s on %s: %v", snaps[0], t.Name(), err)
		}
		snaps = snaps[1:]
	}
	if data, err := json.Marshal(snaps); err == nil {
		b.s.setSetting(key, string(data))
	}
	res.OK = true
	return res
}

// ---------- HTTP ----------

func (s *Server) backupStatus(w http.ResponseWriter, r *http.Request) {
	b := s.backup
	targets := []string{}
	for _, t := range b.targets {
		targets = append(targets, t.Name())
	}
	writeJSON(w, 200, map[string]any{
		"enabled":        b.enabled(),
		"interval_hours": b.cfg.IntervalHours,
		"keep":           b.cfg.Keep,
		"targets":        targets,
		"running":        b.isRunning(),
		"last":           b.lastReport(),
	})
}

func (s *Server) backupRun(w http.ResponseWriter, r *http.Request) {
	if !s.backup.enabled() {
		httpError(w, 400, "未配置备份目标")
		return
	}
	if !s.backup.start() {
		httpError(w, 409, "备份正在进行中")
		return
	}
	writeJSON(w, 202, map[string]bool{"started": true})
}

// ---------- local directory ----------

type localTarget struct{ dir string }

func (t *localTarget) Key() string  { return "local:" + t.dir }
func (t *localTarget) Name() string { return "本地目录 " + t.dir }

func (t *localTarget) Put(ctx context.Context, name string, f *os.File, size int64, sha string) error {
	dst := filepath.Join(t.dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".part"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, f)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

func (t *localTarget) Delete(ctx context.Context, name string) error {
	err := os.Remove(filepath.Join(t.dir, filepath.FromSlash(name)))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// ---------- WebDAV ----------

type webdavTarget struct {
	base       *url.URL // always ends with '/'
	user, pass string
	client     *http.Client
	mu         sync.Mutex
	made       map[string]bool // collections known to exist
}

func (t *webdavTarget) Key() string { return "webdav:" + t.base.String() }
func (t *webdavTarget) Name() string {
	u := *t.base
	u.User = nil
	return "WebDAV " + u.String()
}

func (t *webdavTarget) url(name string) string {
	u := *t.base
	u.Path += name
	return u.String()
}

func (t *webdavTarget) do(ctx context.Context, method, name string, body io.Reader, size int64) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, t.url(name), body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.ContentLength = size
	}
	if t.user != "" || t.pass != "" {
		req.SetBasicAuth(t.user, t.pass)
	}
	resp, err := t.client.Do(req)
	if err != nil {
		return nil, err
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	return resp, nil
}

func (t *webdavTarget) mkcols(ctx context.Context, dir string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	cur := ""
	for _, part := range strings.Split(dir, "/") {
		cur += part + "/"
		if t.made[cur] {
			continue
		}
		resp, err := t.do(ctx, "MKCOL", cur, nil, 0)
		if err != nil {
			return err
		}
		// 201 created; 405 already exists
		if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusMethodNotAllowed && resp.StatusCode/100 != 2 {
			return fmt.Errorf("MKCOL %s: %s", cur, resp.Status)
		}
		t.made[cur] = true
	}
	return nil
}

func (t *webdavTarget) Put(ctx context.Context, name string, f *os.File, size int64, sha string) error {
	if err := t.mkcols(ctx, path.Dir(name)); err != nil {
		return err
	}
	resp, err := t.do(ctx, http.MethodPut, name, f, size)
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("PUT %s: %s", name, resp.Status)
	}
	return nil
}

func (t *webdavTarget) Delete(ctx context.Context, name string) error {
	resp, err := t.do(ctx, http.MethodDelete, name, nil, 0)
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 && resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("DELETE %s: %s", name, resp.Status)
	}
	return nil
}

// ---------- S3 (path-style, Signature V4) ----------

type s3Target struct {
	endpoint               *url.URL
	region, bucket, prefix string
	ak, sk                 string
	client                 *http.Client
}

const emptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func (t *s3Target) Key() string {
	return "s3:" + t.endpoint.Host + "/" + t.bucket + "/" + t.prefix
}
func (t *s3Target) Name() string { return "S3 " + t.bucket + "/" + t.prefix }

// s3Escape percent-encodes everything except RFC 3986 unreserved characters.
func s3Escape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if ('A' <= c && c <= 'Z') || ('a' <= c && c <= 'z') || ('0' <= c && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

func (t *s3Target) do(ctx context.Context, method, name string, body io.Reader, size int64, payloadHash string) error {
	segs := []string{t.bucket}
	if t.prefix != "" {
		segs = append(segs, strings.Split(t.prefix, "/")...)
	}
	segs = append(segs, strings.Split(name, "/")...)
	escaped := make([]string, len(segs))
	for i, s := range segs {
		escaped[i] = s3Escape(s)
	}
	base := strings.TrimSuffix(t.endpoint.EscapedPath(), "/")
	uri := base + "/" + strings.Join(escaped, "/")
	u := *t.endpoint
	u.RawPath = uri
	u.Path, _ = url.PathUnescape(uri)
	u.RawQuery = ""

	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return err
	}
	if body != nil {
		req.ContentLength = size
	}
	amzDate := time.Now().UTC().Format("20060102T150405Z")
	date := amzDate[:8]
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payloadHash)
	const signed = "host;x-amz-content-sha256;x-amz-date"
	canonical := strings.Join([]string{
		method, uri, "",
		"host:" + req.URL.Host + "\nx-amz-content-sha256:" + payloadHash + "\nx-amz-date:" + amzDate + "\n",
		signed, payloadHash,
	}, "\n")
	scope := date + "/" + t.region + "/s3/aws4_request"
	sum := sha256.Sum256([]byte(canonical))
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(sum[:])
	key := hmacSHA256([]byte("AWS4"+t.sk), date)
	key = hmacSHA256(key, t.region)
	key = hmacSHA256(key, "s3")
	key = hmacSHA256(key, "aws4_request")
	sig := hex.EncodeToString(hmacSHA256(key, toSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+t.ak+"/"+scope+", SignedHeaders="+signed+", Signature="+sig)

	resp, err := t.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 && !(method == http.MethodDelete && resp.StatusCode == http.StatusNotFound) {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("%s %s: %s %s", method, name, resp.Status, strings.TrimSpace(string(msg)))
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	return nil
}

func (t *s3Target) Put(ctx context.Context, name string, f *os.File, size int64, sha string) error {
	return t.do(ctx, http.MethodPut, name, f, size, sha)
}

func (t *s3Target) Delete(ctx context.Context, name string) error {
	return t.do(ctx, http.MethodDelete, name, nil, 0, emptySHA256)
}
