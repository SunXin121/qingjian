package server

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	sessionCookie   = "qj_s"
	sessionLifetime = 30 * 24 * time.Hour
	pbkdf2Iter      = 600_000
	maxLoginFails   = 5
	loginLockout    = 10 * time.Minute
)

// initAuth prepares the session secret and the admin password.
// Precedence: QINGJIAN_ADMIN_PASSWORD env > stored hash > newly generated random password.
func (s *Server) initAuth() error {
	if v, ok := s.getSetting("session_secret"); ok {
		s.secret, _ = hex.DecodeString(v)
	}
	if len(s.secret) != 32 {
		s.secret = make([]byte, 32)
		rand.Read(s.secret)
		if err := s.setSetting("session_secret", hex.EncodeToString(s.secret)); err != nil {
			return err
		}
	}

	if s.cfg.AdminPassword != "" {
		sum := sha256.Sum256([]byte("env:" + s.cfg.AdminPassword))
		s.pwFingerprint = sum[:]
		return nil
	}
	hash, ok := s.getSetting("admin_password_hash")
	if !ok {
		pw := randString(16)
		h, err := hashPassword(pw)
		if err != nil {
			return err
		}
		if err := s.setSetting("admin_password_hash", h); err != nil {
			return err
		}
		hash = h
		log.Printf("============================================================")
		log.Printf(" No QINGJIAN_ADMIN_PASSWORD set. Generated admin password:")
		log.Printf("     %s", pw)
		log.Printf(" Set QINGJIAN_ADMIN_PASSWORD to use your own password.")
		log.Printf("============================================================")
	}
	s.storedHash = hash
	sum := sha256.Sum256([]byte("hash:" + hash))
	s.pwFingerprint = sum[:]
	return nil
}

func hashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	rand.Read(salt)
	key, err := pbkdf2.Key(sha256.New, pw, salt, pbkdf2Iter, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2$%d$%x$%x", pbkdf2Iter, salt, key), nil
}

func verifyHash(pw, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil {
		return false
	}
	salt, err1 := hex.DecodeString(parts[2])
	want, err2 := hex.DecodeString(parts[3])
	if err1 != nil || err2 != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, pw, salt, iter, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

func (s *Server) checkPassword(pw string) bool {
	if s.cfg.AdminPassword != "" {
		a := sha256.Sum256([]byte(pw))
		b := sha256.Sum256([]byte(s.cfg.AdminPassword))
		return subtle.ConstantTimeCompare(a[:], b[:]) == 1
	}
	return verifyHash(pw, s.storedHash)
}

// Session token: base64(expiryUnix).base64(hmac(secret, fingerprint|expiry))
func (s *Server) sign(payload string) string {
	m := hmac.New(sha256.New, s.secret)
	m.Write(s.pwFingerprint)
	m.Write([]byte("|" + payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (s *Server) newSessionToken() (string, time.Time) {
	exp := time.Now().Add(sessionLifetime)
	payload := strconv.FormatInt(exp.Unix(), 10)
	return payload + "." + s.sign(payload), exp
}

func (s *Server) validSession(token string) bool {
	payload, sig, found := strings.Cut(token, ".")
	if !found {
		return false
	}
	if !hmac.Equal([]byte(sig), []byte(s.sign(payload))) {
		return false
	}
	exp, err := strconv.ParseInt(payload, 10, 64)
	return err == nil && time.Now().Unix() < exp
}

func (s *Server) isAdmin(r *http.Request) bool {
	c, err := r.Cookie(sessionCookie)
	return err == nil && s.validSession(c.Value)
}

func (s *Server) isSecure(r *http.Request) bool {
	return r.TLS != nil || (s.cfg.TrustProxy && r.Header.Get("X-Forwarded-Proto") == "https")
}

func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		// The proxy appends the address it saw to whatever the client sent, so only the
		// last entry is trustworthy; earlier ones are client-controlled.
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if ip := strings.TrimSpace(xff[strings.LastIndex(xff, ",")+1:]); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// sameOrigin rejects cross-site state-changing requests (defence in depth on top of SameSite=Lax).
func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := r.Host
	if fh := r.Header.Get("X-Forwarded-Host"); fh != "" {
		host = fh
	}
	return strings.EqualFold(u.Host, host)
}

func (s *Server) requireAdmin(h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.isAdmin(r) {
			httpError(w, http.StatusUnauthorized, "未登录")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && !sameOrigin(r) {
			httpError(w, http.StatusForbidden, "跨站请求被拒绝")
			return
		}
		h(w, r)
	})
}

// ---- login rate limiting ----

type loginLimiter struct {
	mu    sync.Mutex
	fails map[string]*failRecord
}

type failRecord struct {
	count int
	until time.Time
	last  time.Time
}

func newLoginLimiter() *loginLimiter { return &loginLimiter{fails: map[string]*failRecord{}} }

func (l *loginLimiter) blocked(ip string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	rec := l.fails[ip]
	if rec == nil {
		return false, 0
	}
	if d := time.Until(rec.until); d > 0 {
		return true, d
	}
	return false, 0
}

func (l *loginLimiter) fail(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	rec := l.fails[ip]
	if rec == nil || time.Since(rec.last) > loginLockout {
		rec = &failRecord{}
		l.fails[ip] = rec
	}
	rec.count++
	rec.last = time.Now()
	if rec.count >= maxLoginFails {
		rec.until = time.Now().Add(loginLockout)
		rec.count = 0
	}
	// opportunistic cleanup
	if len(l.fails) > 10000 {
		for k, v := range l.fails {
			if time.Since(v.last) > loginLockout {
				delete(l.fails, k)
			}
		}
	}
}

func (l *loginLimiter) reset(ip string) {
	l.mu.Lock()
	delete(l.fails, ip)
	l.mu.Unlock()
}

// ---- handlers ----

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		httpError(w, http.StatusForbidden, "跨站请求被拒绝")
		return
	}
	ip := s.clientIP(r)
	if blocked, d := s.limiter.blocked(ip); blocked {
		httpError(w, http.StatusTooManyRequests, fmt.Sprintf("尝试次数过多，请 %d 分钟后再试", int(d.Minutes())+1))
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := readJSON(r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if !s.checkPassword(body.Password) {
		s.limiter.fail(ip)
		time.Sleep(400 * time.Millisecond)
		httpError(w, http.StatusUnauthorized, "密码错误")
		return
	}
	s.limiter.reset(ip)
	token, exp := s.newSessionToken()
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		Expires:  exp,
		HttpOnly: true,
		Secure:   s.isSecure(r),
		SameSite: http.SameSiteLaxMode,
	})
	ok(w)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	ok(w)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"admin": s.isAdmin(r)})
}
