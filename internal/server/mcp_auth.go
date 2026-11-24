package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

const (
	ScopeMCPRead  = "mcp:read"
	ScopeMCPWrite = "mcp:write"
	ScopeMCPTrash = "mcp:trash"

	oauthCodeTTL    = 5 * time.Minute
	oauthAccessTTL  = 30 * 24 * time.Hour
	oauthRefreshTTL = 180 * 24 * time.Hour
)

var allMCPScopes = []string{ScopeMCPRead, ScopeMCPWrite, ScopeMCPTrash}

type MCPGrant struct {
	ID         string   `json:"id"`
	Kind       string   `json:"kind"` // api_key | oauth
	Name       string   `json:"name"`
	ClientID   string   `json:"client_id,omitempty"`
	Prefix     string   `json:"prefix"`
	Scopes     []string `json:"scopes"`
	CreatedAt  int64    `json:"created_at"`
	LastUsedAt *int64   `json:"last_used_at"`
	ExpiresAt  *int64   `json:"expires_at"`
}

func (g *MCPGrant) hasScope(sc string) bool {
	return slices.Contains(g.Scopes, sc)
}

func normalizeScopes(in []string) []string {
	var out []string
	for _, raw := range in {
		for _, part := range strings.Fields(raw) {
			if slices.Contains(allMCPScopes, part) && !slices.Contains(out, part) {
				out = append(out, part)
			}
		}
	}
	// mcp:write implies mcp:read so tools can inspect revisions safely
	if slices.Contains(out, ScopeMCPWrite) && !slices.Contains(out, ScopeMCPRead) {
		out = append([]string{ScopeMCPRead}, out...)
	}
	return out
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func maskTokenPrefix(tok string) string {
	if len(tok) <= 14 {
		return tok
	}
	return tok[:10] + "…" + tok[len(tok)-4:]
}

func setMCPDiscoveryCORS(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id")
	h.Set("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate")
}

// ---------- Admin Grant & API Key Management (/api/mcp/*) ----------

func (s *Server) listMCPGrants(w http.ResponseWriter, r *http.Request) {
	// Opportunistically prune expired OAuth codes
	_, _ = s.db.Exec(`DELETE FROM mcp_oauth_codes WHERE expires_at <= ?`, now())

	rows, err := s.db.Query(`SELECT id, kind, name, client_id, prefix, scopes, created_at, last_used_at, expires_at
FROM mcp_grants ORDER BY created_at DESC`)
	if err != nil {
		serverError(w, r, err)
		return
	}
	defer rows.Close()
	out := []MCPGrant{}
	t := now()
	for rows.Next() {
		var g MCPGrant
		var rawScopes string
		if err := rows.Scan(&g.ID, &g.Kind, &g.Name, &g.ClientID, &g.Prefix, &rawScopes, &g.CreatedAt, &g.LastUsedAt, &g.ExpiresAt); err != nil {
			serverError(w, r, err)
			return
		}
		if g.ExpiresAt != nil && *g.ExpiresAt <= t && g.Kind == "api_key" {
			continue
		}
		g.Scopes = normalizeScopes([]string{rawScopes})
		out = append(out, g)
	}
	if err := rows.Err(); err != nil {
		serverError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) createMCPKey(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name   string   `json:"name"`
		Scopes []string `json:"scopes"`
	}
	if err := readJSON(r, &in); err != nil {
		httpError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = "MCP API Key"
	}
	if runes := []rune(name); len(runes) > 64 {
		name = string(runes[:64])
	}
	scopes := normalizeScopes(in.Scopes)
	if len(scopes) == 0 {
		scopes = []string{ScopeMCPRead}
	}
	plain := "qj_" + randString(38)
	g := MCPGrant{
		ID:        newID(),
		Kind:      "api_key",
		Name:      name,
		Prefix:    maskTokenPrefix(plain),
		Scopes:    scopes,
		CreatedAt: now(),
	}
	if _, err := s.db.Exec(`INSERT INTO mcp_grants(id, kind, name, token_hash, prefix, scopes, created_at) VALUES(?,?,?,?,?,?,?)`,
		g.ID, g.Kind, g.Name, sha256Hex(plain), g.Prefix, strings.Join(g.Scopes, " "), g.CreatedAt); err != nil {
		serverError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"grant": g,
		"token": plain,
	})
}

func (s *Server) revokeMCPGrant(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	res, err := s.db.Exec(`DELETE FROM mcp_grants WHERE id = ?`, id)
	if err != nil {
		serverError(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpError(w, http.StatusNotFound, "授权不存在")
		return
	}
	ok(w)
}

// authenticateMCP resolves an Authorization: Bearer token against mcp_grants.
func (s *Server) authenticateMCP(r *http.Request) (*MCPGrant, int, string) {
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	scheme, rest, found := strings.Cut(auth, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") || strings.TrimSpace(rest) == "" {
		return nil, http.StatusUnauthorized, "missing bearer token"
	}
	tok := strings.TrimSpace(rest)
	ip := "mcp:" + s.clientIP(r)
	if blocked, _ := s.limiter.blocked(ip); blocked {
		return nil, http.StatusTooManyRequests, "too many failed authentication attempts"
	}
	hash := sha256Hex(tok)
	var g MCPGrant
	var rawScopes, storedHash string
	err := s.db.QueryRow(`SELECT id, kind, name, client_id, token_hash, prefix, scopes, created_at, last_used_at, expires_at
FROM mcp_grants WHERE token_hash = ?`, hash).
		Scan(&g.ID, &g.Kind, &g.Name, &g.ClientID, &storedHash, &g.Prefix, &rawScopes, &g.CreatedAt, &g.LastUsedAt, &g.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) || subtle.ConstantTimeCompare([]byte(storedHash), []byte(hash)) != 1 {
		s.limiter.fail(ip)
		return nil, http.StatusUnauthorized, "invalid or revoked token"
	} else if err != nil {
		return nil, http.StatusInternalServerError, "internal error"
	}
	if g.ExpiresAt != nil && *g.ExpiresAt <= now() {
		return nil, http.StatusUnauthorized, "access token expired"
	}
	s.limiter.reset(ip)
	g.Scopes = normalizeScopes([]string{rawScopes})
	t := now()
	if g.LastUsedAt == nil || t-*g.LastUsedAt > 30_000 {
		_, _ = s.db.Exec(`UPDATE mcp_grants SET last_used_at = ? WHERE id = ?`, t, g.ID)
	}
	return &g, http.StatusOK, ""
}

// ---------- OAuth 2.1 Discovery, Dynamic Registration & PKCE ----------

func (s *Server) serveOAuthProtectedResource(w http.ResponseWriter, r *http.Request) {
	setMCPDiscoveryCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	origin := s.requestOrigin(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 origin + "/mcp",
		"authorization_servers":    []string{origin},
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         allMCPScopes,
	})
}

func (s *Server) serveOAuthAuthorizationServer(w http.ResponseWriter, r *http.Request) {
	setMCPDiscoveryCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	origin := s.requestOrigin(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                origin,
		"authorization_endpoint":                origin + "/oauth/authorize",
		"token_endpoint":                        origin + "/oauth/token",
		"registration_endpoint":                 origin + "/oauth/register",
		"revocation_endpoint":                   origin + "/oauth/revoke",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none"},
		"scopes_supported":                      allMCPScopes,
	})
}

func validRedirectURI(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Fragment != "" {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme == "javascript" || scheme == "data" || scheme == "vbscript" || scheme == "file" {
		return false
	}
	if scheme == "https" {
		return u.Host != ""
	}
	if scheme == "http" {
		host := u.Hostname()
		if host == "localhost" || host == "127.0.0.1" || host == "::1" {
			return true
		}
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			return true
		}
		return false
	}
	// Custom native desktop/mobile app schemes (e.g. cursor://, claude://)
	return strings.Contains(scheme, "-") || len(scheme) >= 3
}

func (s *Server) handleOAuthRegister(w http.ResponseWriter, r *http.Request) {
	setMCPDiscoveryCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var in struct {
		ClientName   string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
	}
	if err := readJSON(r, &in); err != nil || len(in.RedirectURIs) == 0 || len(in.RedirectURIs) > 10 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_client_metadata"})
		return
	}
	cleanURIs := make([]string, 0, len(in.RedirectURIs))
	for _, uri := range in.RedirectURIs {
		uri = strings.TrimSpace(uri)
		if !validRedirectURI(uri) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_redirect_uri"})
			return
		}
		cleanURIs = append(cleanURIs, uri)
	}
	name := strings.TrimSpace(in.ClientName)
	if name == "" {
		name = "MCP Client"
	}
	if runes := []rune(name); len(runes) > 80 {
		name = string(runes[:80])
	}
	clientID := "qjc_" + randString(20)
	t := now()
	rawURIs, _ := json.Marshal(cleanURIs)
	if _, err := s.db.Exec(`INSERT INTO mcp_oauth_clients(client_id, client_name, redirect_uris, created_at) VALUES(?,?,?,?)`,
		clientID, name, string(rawURIs), t); err != nil {
		serverError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id":                  clientID,
		"client_name":                name,
		"redirect_uris":              cleanURIs,
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "none",
		"client_id_issued_at":        t / 1000,
	})
}

func (s *Server) resolveOAuthClient(clientID, redirectURI string) (clientName string, err error) {
	if clientID == "" || !validRedirectURI(redirectURI) {
		return "", errors.New("invalid client or redirect_uri")
	}
	var rawURIs string
	err = s.db.QueryRow(`SELECT client_name, redirect_uris FROM mcp_oauth_clients WHERE client_id = ?`, clientID).
		Scan(&clientName, &rawURIs)
	if errors.Is(err, sql.ErrNoRows) {
		// Allow URL-based client_id metadata (MCP 2025-06-18 client ID metadata convention) if redirect_uri is loopback or matches origin
		if u, uerr := url.Parse(clientID); uerr == nil && (u.Scheme == "https" || u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1") {
			ru, _ := url.Parse(redirectURI)
			if ru != nil && (ru.Hostname() == "localhost" || ru.Hostname() == "127.0.0.1" || strings.EqualFold(ru.Host, u.Host)) {
				return u.Host, nil
			}
		}
		return "", errors.New("unknown client_id")
	} else if err != nil {
		return "", err
	}
	var allowed []string
	_ = json.Unmarshal([]byte(rawURIs), &allowed)
	if !slices.Contains(allowed, redirectURI) {
		return "", errors.New("redirect_uri mismatch")
	}
	return clientName, nil
}

func (s *Server) getOAuthAuthorizeInfo(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	clientID := strings.TrimSpace(q.Get("client_id"))
	redirectURI := strings.TrimSpace(q.Get("redirect_uri"))
	respType := strings.TrimSpace(q.Get("response_type"))
	challenge := strings.TrimSpace(q.Get("code_challenge"))
	method := strings.TrimSpace(q.Get("code_challenge_method"))
	if respType != "code" || challenge == "" || !strings.EqualFold(method, "S256") {
		httpError(w, http.StatusBadRequest, "仅支持带 PKCE (S256) 的 OAuth 2.1 授权码模式")
		return
	}
	clientName, err := s.resolveOAuthClient(clientID, redirectURI)
	if err != nil {
		httpError(w, http.StatusBadRequest, "无效的客户端或回调地址")
		return
	}
	reqScopes := normalizeScopes([]string{q.Get("scope")})
	if len(reqScopes) == 0 {
		reqScopes = []string{ScopeMCPRead, ScopeMCPWrite}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"client_id":        clientID,
		"client_name":      clientName,
		"redirect_uri":     redirectURI,
		"requested_scopes": reqScopes,
	})
}

func (s *Server) approveOAuthAuthorize(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Approve             bool     `json:"approve"`
		ClientID            string   `json:"client_id"`
		RedirectURI         string   `json:"redirect_uri"`
		CodeChallenge       string   `json:"code_challenge"`
		CodeChallengeMethod string   `json:"code_challenge_method"`
		State               string   `json:"state"`
		Scopes              []string `json:"scopes"`
	}
	if err := readJSON(r, &in); err != nil {
		httpError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if !strings.EqualFold(in.CodeChallengeMethod, "S256") || strings.TrimSpace(in.CodeChallenge) == "" {
		httpError(w, http.StatusBadRequest, "缺少有效的 PKCE code_challenge")
		return
	}
	if _, err := s.resolveOAuthClient(in.ClientID, in.RedirectURI); err != nil {
		httpError(w, http.StatusBadRequest, "无效的客户端或回调地址")
		return
	}
	target, err := url.Parse(in.RedirectURI)
	if err != nil {
		httpError(w, http.StatusBadRequest, "无效的回调地址")
		return
	}
	qp := target.Query()
	if in.State != "" {
		qp.Set("state", in.State)
	}
	if !in.Approve {
		qp.Set("error", "access_denied")
		target.RawQuery = qp.Encode()
		writeJSON(w, http.StatusOK, map[string]string{"redirect_to": target.String()})
		return
	}
	scopes := normalizeScopes(in.Scopes)
	if len(scopes) == 0 {
		scopes = []string{ScopeMCPRead}
	}
	code := "qja_" + randString(36)
	exp := time.Now().Add(oauthCodeTTL).UnixMilli()
	if _, err := s.db.Exec(`INSERT INTO mcp_oauth_codes(code_hash, client_id, redirect_uri, code_challenge, scopes, expires_at) VALUES(?,?,?,?,?,?)`,
		sha256Hex(code), in.ClientID, in.RedirectURI, strings.TrimSpace(in.CodeChallenge), strings.Join(scopes, " "), exp); err != nil {
		serverError(w, r, err)
		return
	}
	qp.Set("code", code)
	target.RawQuery = qp.Encode()
	writeJSON(w, http.StatusOK, map[string]string{"redirect_to": target.String()})
}

func parseOAuthFormOrJSON(r *http.Request) map[string]string {
	out := map[string]string{}
	ct := strings.ToLower(r.Header.Get("Content-Type"))
	if strings.Contains(ct, "application/json") {
		_ = readJSON(r, &out)
		return out
	}
	_ = r.ParseForm()
	for k, vals := range r.Form {
		if len(vals) > 0 {
			out[k] = vals[0]
		}
	}
	return out
}

func verifyPKCES256(verifier, challenge string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	sum := sha256.Sum256([]byte(verifier))
	got := base64.RawURLEncoding.EncodeToString(sum[:])
	return subtle.ConstantTimeCompare([]byte(got), []byte(challenge)) == 1
}

func (s *Server) handleOAuthToken(w http.ResponseWriter, r *http.Request) {
	setMCPDiscoveryCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	params := parseOAuthFormOrJSON(r)
	grantType := strings.TrimSpace(params["grant_type"])

	switch grantType {
	case "authorization_code":
		code := strings.TrimSpace(params["code"])
		verifier := strings.TrimSpace(params["code_verifier"])
		clientID := strings.TrimSpace(params["client_id"])
		redirectURI := strings.TrimSpace(params["redirect_uri"])
		if code == "" || verifier == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
			return
		}
		codeHash := sha256Hex(code)
		var storedClient, storedRedirect, challenge, rawScopes string
		var expiresAt int64
		err := s.withTx(func(tx *sql.Tx) error {
			err := tx.QueryRow(`SELECT client_id, redirect_uri, code_challenge, scopes, expires_at FROM mcp_oauth_codes WHERE code_hash = ?`, codeHash).
				Scan(&storedClient, &storedRedirect, &challenge, &rawScopes, &expiresAt)
			if err != nil {
				return err
			}
			_, err = tx.Exec(`DELETE FROM mcp_oauth_codes WHERE code_hash = ?`, codeHash)
			return err
		})
		if err != nil || expiresAt <= now() {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
			return
		}
		if (clientID != "" && clientID != storedClient) || (redirectURI != "" && redirectURI != storedRedirect) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
			return
		}
		if !verifyPKCES256(verifier, challenge) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant", "error_description": "PKCE verification failed"})
			return
		}
		clientName, _ := s.resolveOAuthClient(storedClient, storedRedirect)
		if clientName == "" {
			clientName = "OAuth Client"
		}
		access := "qjo_" + randString(38)
		refresh := "qjr_" + randString(38)
		t := now()
		exp := time.Now().Add(oauthAccessTTL).UnixMilli()
		if _, err := s.db.Exec(`INSERT INTO mcp_grants(id, kind, name, client_id, token_hash, refresh_hash, prefix, scopes, created_at, expires_at)
VALUES(?,?,?,?,?,?,?,?,?,?)`,
			newID(), "oauth", clientName, storedClient, sha256Hex(access), sha256Hex(refresh), maskTokenPrefix(access), rawScopes, t, exp); err != nil {
			serverError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"access_token":  access,
			"token_type":    "Bearer",
			"expires_in":    int(oauthAccessTTL.Seconds()),
			"refresh_token": refresh,
			"scope":         rawScopes,
		})

	case "refresh_token":
		rt := strings.TrimSpace(params["refresh_token"])
		if rt == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
			return
		}
		rtHash := sha256Hex(rt)
		var id, rawScopes string
		var createdAt int64
		err := s.db.QueryRow(`SELECT id, scopes, created_at FROM mcp_grants WHERE kind = 'oauth' AND refresh_hash = ?`, rtHash).
			Scan(&id, &rawScopes, &createdAt)
		if err != nil || time.Since(time.UnixMilli(createdAt)) > oauthRefreshTTL {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
			return
		}
		access := "qjo_" + randString(38)
		newRefresh := "qjr_" + randString(38)
		exp := time.Now().Add(oauthAccessTTL).UnixMilli()
		if _, err := s.db.Exec(`UPDATE mcp_grants SET token_hash = ?, refresh_hash = ?, prefix = ?, expires_at = ?, last_used_at = ? WHERE id = ?`,
			sha256Hex(access), sha256Hex(newRefresh), maskTokenPrefix(access), exp, now(), id); err != nil {
			serverError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"access_token":  access,
			"token_type":    "Bearer",
			"expires_in":    int(oauthAccessTTL.Seconds()),
			"refresh_token": newRefresh,
			"scope":         rawScopes,
		})

	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported_grant_type"})
	}
}

func (s *Server) handleOAuthRevoke(w http.ResponseWriter, r *http.Request) {
	setMCPDiscoveryCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	params := parseOAuthFormOrJSON(r)
	tok := strings.TrimSpace(params["token"])
	if tok != "" {
		h := sha256Hex(tok)
		_, _ = s.db.Exec(`DELETE FROM mcp_grants WHERE token_hash = ? OR refresh_hash = ?`, h, h)
	}
	w.WriteHeader(http.StatusOK)
}
