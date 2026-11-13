package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// ImgbedConfig points at a CloudFlare ImgBed instance (https://cfbed.sanyue.de). Exports
// can upload their images and attachments there and link to them instead of bundling
// the files into a zip.
type ImgbedConfig struct {
	URL         string `json:"url"`          // site address, e.g. https://img.example.com
	AuthCode    string `json:"auth_code"`    // upload auth code (authCode query parameter)
	Token       string `json:"token"`        // API token with the upload permission
	Channel     string `json:"channel"`      // uploadChannel; empty: the image host's default
	ChannelName string `json:"channel_name"` // channelName, for several channels of one kind
	Folder      string `json:"folder"`       // uploadFolder, e.g. qingjian/img
	NameType    string `json:"name_type"`    // uploadNameType: default | index | origin | short
}

var (
	imgbedChannels  = map[string]bool{"": true, "telegram": true, "cfr2": true, "s3": true, "discord": true, "huggingface": true, "webdav": true}
	imgbedNameTypes = map[string]bool{"": true, "default": true, "index": true, "origin": true, "short": true}
)

func (c ImgbedConfig) enabled() bool { return c.URL != "" }

// target identifies where an upload went, so cached URLs are reused only for the same
// site, channel and folder.
func (c ImgbedConfig) target() string {
	return strings.Join([]string{c.URL, c.Channel, c.ChannelName, c.Folder, c.NameType}, "|")
}

func (c *ImgbedConfig) normalize() error {
	c.URL = strings.TrimRight(strings.TrimSpace(c.URL), "/")
	c.AuthCode = strings.TrimSpace(c.AuthCode)
	c.Token = strings.TrimSpace(c.Token)
	c.ChannelName = strings.TrimSpace(c.ChannelName)
	c.Folder = strings.Trim(strings.TrimSpace(c.Folder), "/")
	if c.URL != "" {
		u, err := url.Parse(c.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" {
			return errors.New("图床地址应为 http(s):// 开头的站点地址")
		}
	}
	if !imgbedChannels[c.Channel] {
		return fmt.Errorf("未知的上传渠道 %q", c.Channel)
	}
	if !imgbedNameTypes[c.NameType] {
		return fmt.Errorf("未知的命名方式 %q", c.NameType)
	}
	return nil
}

func (s *Server) imgbedConfig() ImgbedConfig {
	var c ImgbedConfig
	if v, ok := s.getSetting("imgbed"); ok {
		json.Unmarshal([]byte(v), &c)
	}
	return c
}

func (s *Server) getImgbed(w http.ResponseWriter, r *http.Request) {
	var cached int
	if err := s.db.QueryRow(`SELECT count(*) FROM imgbed_uploads`).Scan(&cached); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"config": s.imgbedConfig(), "uploaded": cached})
}

func (s *Server) putImgbed(w http.ResponseWriter, r *http.Request) {
	var c ImgbedConfig
	if err := readJSON(r, &c); err != nil {
		httpError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if err := c.normalize(); err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	data, _ := json.Marshal(c)
	if err := s.setSetting("imgbed", string(data)); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// forgetImgbed drops the upload records, so the next export uploads every file again
// (e.g. after files were deleted on the image host).
func (s *Server) forgetImgbed(w http.ResponseWriter, r *http.Request) {
	res, err := s.db.Exec(`DELETE FROM imgbed_uploads`)
	if err != nil {
		serverError(w, err)
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]int64{"removed": n})
}

type imgbedUploader struct {
	s      *Server
	cfg    ImgbedConfig
	client *http.Client
}

func (s *Server) newImgbedUploader() (*imgbedUploader, error) {
	c := s.imgbedConfig()
	if !c.enabled() {
		return nil, errors.New("尚未配置图床，请先在「设置」中填写图床地址")
	}
	return &imgbedUploader{s: s, cfg: c, client: &http.Client{Timeout: 10 * time.Minute}}, nil
}

// uploadAll uploads the attachments (a few at a time) and returns id → public URL.
// Files uploaded before to the same target are not sent again.
func (u *imgbedUploader) uploadAll(ctx context.Context, atts []*Attachment) (map[string]string, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	out := map[string]string{}
	var (
		mu       sync.Mutex
		firstErr error
		wg       sync.WaitGroup
	)
	sem := make(chan struct{}, 4)
	for _, a := range atts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			link, err := u.upload(ctx, a)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				if firstErr == nil {
					firstErr = fmt.Errorf("上传「%s」到图床失败：%w", a.Name, err)
					cancel()
				}
				return
			}
			out[a.ID] = link
		}()
	}
	wg.Wait()
	if firstErr == nil {
		firstErr = ctx.Err()
	}
	if firstErr != nil {
		return nil, firstErr
	}
	return out, nil
}

func (u *imgbedUploader) upload(ctx context.Context, a *Attachment) (string, error) {
	target := u.cfg.target()
	var cached string
	if u.s.db.QueryRow(`SELECT url FROM imgbed_uploads WHERE target = ? AND sha256 = ?`, target, a.SHA256).Scan(&cached) == nil {
		return cached, nil
	}
	f, err := os.Open(u.s.blobPath(a.SHA256))
	if err != nil {
		return "", err
	}
	defer f.Close()

	q := url.Values{"returnFormat": {"full"}}
	for k, v := range map[string]string{"authCode": u.cfg.AuthCode, "uploadChannel": u.cfg.Channel, "channelName": u.cfg.ChannelName,
		"uploadFolder": u.cfg.Folder, "uploadNameType": u.cfg.NameType} {
		if v != "" {
			q.Set(k, v)
		}
	}
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		h := textproto.MIMEHeader{}
		h.Set("Content-Disposition", `form-data; name="file"; filename="`+quoteEscaper.Replace(nonEmpty(a.Name, a.ID))+`"`)
		h.Set("Content-Type", nonEmpty(a.Mime, "application/octet-stream"))
		part, err := mw.CreatePart(h)
		if err == nil {
			_, err = io.Copy(part, f)
		}
		if err == nil {
			err = mw.Close()
		}
		pw.CloseWithError(err)
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.cfg.URL+"/upload?"+q.Encode(), pr)
	if err != nil {
		pr.Close()
		return "", err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if u.cfg.Token != "" {
		req.Header.Set("Authorization", "Bearer "+u.cfg.Token)
	}
	resp, err := u.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("%s %s", resp.Status, imgbedErrorText(body))
	}
	link, err := u.parseLink(body)
	if err != nil {
		return "", err
	}
	u.s.db.Exec(`INSERT OR REPLACE INTO imgbed_uploads(target, sha256, url, created_at) VALUES(?, ?, ?, ?)`, target, a.SHA256, link, now())
	return link, nil
}

var quoteEscaper = strings.NewReplacer("\\", "\\\\", `"`, "\\\"", "\r", "", "\n", "")

type imgbedFile struct {
	Src       string `json:"src"`
	PublicURL string `json:"publicUrl"`
}

// parseLink reads the upload response ([{"src": ..}] or {"src": ..}) into an absolute URL.
func (u *imgbedUploader) parseLink(body []byte) (string, error) {
	var list []imgbedFile
	if json.Unmarshal(body, &list) != nil || len(list) == 0 {
		var one imgbedFile
		if json.Unmarshal(body, &one) != nil || (one.Src == "" && one.PublicURL == "") {
			return "", fmt.Errorf("无法识别图床的返回：%s", imgbedErrorText(body))
		}
		list = []imgbedFile{one}
	}
	link := nonEmpty(list[0].PublicURL, list[0].Src)
	if link == "" {
		return "", fmt.Errorf("图床没有返回链接：%s", imgbedErrorText(body))
	}
	if strings.HasPrefix(link, "/") {
		link = u.cfg.URL + link
	}
	return link, nil
}

func imgbedErrorText(body []byte) string {
	var e struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &e) == nil && (e.Error != "" || e.Message != "") {
		return nonEmpty(e.Error, e.Message)
	}
	t := strings.TrimSpace(string(body))
	if r := []rune(t); len(r) > 300 {
		t = string(r[:300]) + "…"
	}
	return t
}
