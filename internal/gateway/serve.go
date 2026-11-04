package gateway

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

// What makes the gateway a web server as well as an API: the interface it serves, a login that
// leaves a session cookie (so the page never keeps the token), a limit on wrong guesses, and
// the headers a page on the Internet should carry. Everything here is off or inert for a
// gateway that only listens on this machine for a program with the bearer token.

// sessionCookie is the cookie a signed-in browser carries.
const sessionCookie = "kitties_session"

// sessionAge is how long a sign-in lasts.
const sessionAge = 30 * 24 * time.Hour

// WithWeb serves the web interface from web (the build of the page; index.html at its root).
// Without it the gateway serves its small built-in page.
func (s *Server) WithWeb(web fs.FS) *Server {
	s.web = web
	return s
}

// WithPublicURL sets the address the gateway is reached at from outside. The OAuth sign-ins
// return the browser there, and an https address marks the cookies Secure.
func (s *Server) WithPublicURL(u string) *Server {
	s.publicURL = strings.TrimRight(u, "/")
	return s
}

// WithProxy says a reverse proxy is in front: its X-Forwarded-* headers are believed.
func (s *Server) WithProxy(trust bool) *Server {
	s.trustProxy = trust
	return s
}

// WithLocalToken sets whether /v1/local-token may hand the token to a client on this machine.
func (s *Server) WithLocalToken(on bool) *Server {
	s.noLocalToken = !on
	return s
}

// WithTLS makes Listen serve https with the certificate and key files.
func (s *Server) WithTLS(cert, key string) *Server {
	s.tlsCert, s.tlsKey = cert, key
	return s
}

// sessionValue is what a valid session cookie holds: a keyed hash of the token, so the cookie
// never carries the token, and changes with it.
func (s *Server) sessionValue() string {
	mac := hmac.New(sha256.New, []byte(s.token))
	mac.Write([]byte("kitties-session-v1"))
	return hex.EncodeToString(mac.Sum(nil))
}

// credentials says what a request presented and whether it is right: tokenGiven when something
// was offered at all (a wrong guess counts against the client, silence does not), cookie when
// the session cookie carried it (which makes the request subject to the same-origin check).
func (s *Server) credentials(r *http.Request) (valid, given, cookie bool) {
	if s.token == "" {
		return false, false, false
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if got == r.Header.Get("Authorization") {
		got = r.URL.Query().Get("token")
	}
	if got != "" {
		return subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1, true, false
	}
	if c, err := r.Cookie(sessionCookie); err == nil && c.Value != "" {
		return subtle.ConstantTimeCompare([]byte(c.Value), []byte(s.sessionValue())) == 1, true, true
	}
	return false, false, false
}

// isHTTPS reports whether the person is on https: this listener's TLS, a proxy that said so,
// or a public address that is https.
func (s *Server) isHTTPS(r *http.Request) bool {
	if r.TLS != nil || strings.HasPrefix(s.publicURL, "https://") {
		return true
	}
	return s.trustProxy && strings.EqualFold(firstOf(r.Header.Get("X-Forwarded-Proto")), "https")
}

// requestHost is the host the person typed: the proxy's word when it is trusted.
func (s *Server) requestHost(r *http.Request) string {
	if s.trustProxy {
		if h := firstOf(r.Header.Get("X-Forwarded-Host")); h != "" {
			return h
		}
	}
	return r.Host
}

// clientIP is who is asking, for the sign-in limit: the proxy's word (the address its own
// hop appended, the last one) when it is trusted, the peer otherwise.
func (s *Server) clientIP(r *http.Request) string {
	if s.trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
				return ip
			}
		}
		if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func firstOf(list string) string {
	return strings.TrimSpace(strings.Split(list, ",")[0])
}

// sameSite reports whether a browser request comes from this gateway's own page: its Origin
// names a host the gateway answers to, or (no Origin) the browser says it is same-origin.
func (s *Server) sameSite(r *http.Request) bool {
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host == "" {
			return false
		}
		hosts := []string{r.Host, s.requestHost(r)}
		if s.publicURL != "" {
			if p, err := url.Parse(s.publicURL); err == nil {
				hosts = append(hosts, p.Host)
			}
		}
		for _, h := range hosts {
			if strings.EqualFold(u.Host, h) {
				return true
			}
		}
		return false
	}
	return r.Header.Get("Sec-Fetch-Site") == "same-origin"
}

// safeMethod is a method that changes nothing.
func safeMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

// limiter counts wrong guesses per client over a window.
type limiter struct {
	mu     sync.Mutex
	hits   map[string][]time.Time
	max    int
	window time.Duration
	now    func() time.Time
}

func newLimiter(max int, window time.Duration) *limiter {
	return &limiter{hits: map[string][]time.Time{}, max: max, window: window, now: time.Now}
}

// prune drops the hits that left the window; callers hold the lock.
func (l *limiter) prune(key string) []time.Time {
	cut := l.now().Add(-l.window)
	kept := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(l.hits, key)
		return nil
	}
	l.hits[key] = kept
	return kept
}

// wait is how long key must wait before another guess counts, zero when it may try.
func (l *limiter) wait(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	kept := l.prune(key)
	if len(kept) < l.max {
		return 0
	}
	return kept[0].Add(l.window).Sub(l.now())
}

// fail records a wrong guess.
func (l *limiter) fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.hits) > 10000 {
		// A flood of addresses must not grow the table without end: forget the quiet ones.
		for k := range l.hits {
			l.prune(k)
		}
	}
	l.hits[key] = append(l.hits[key], l.now())
}

// reset forgets key's guesses (it signed in).
func (l *limiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.hits, key)
}

// tooMany answers a client that guessed too often.
func tooMany(w http.ResponseWriter, wait time.Duration) {
	secs := int(wait/time.Second) + 1
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	fail(w, http.StatusTooManyRequests, errors.New("too many wrong tokens; try again in "+strconv.Itoa(secs)+" seconds"))
}

// auth checks what a request presents: the bearer token, the token query (the page's image and
// event-stream links, outside a browser session) or the session cookie. Wrong guesses are
// counted per client and refused after too many; a request authorised by the cookie alone
// that changes something must come from the gateway's own page.
func (s *Server) auth(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := s.clientIP(r)
		if wait := s.limit.wait(ip); wait > 0 {
			tooMany(w, wait)
			return
		}
		valid, given, cookie := s.credentials(r)
		if !valid {
			if given {
				s.limit.fail(ip)
			}
			fail(w, http.StatusUnauthorized, errors.New("a valid bearer token is required"))
			return
		}
		if cookie && !safeMethod(r.Method) && !s.sameSite(r) {
			fail(w, http.StatusForbidden, errors.New("a request that changes something must come from the gateway's own page"))
			return
		}
		if s.admission != nil && !maintenanceExempt(r) {
			ctx, release, err := s.admission.Enter(r.Context())
			if err != nil {
				fail(w, http.StatusServiceUnavailable, err)
				return
			}
			defer release()
			r = r.WithContext(ctx)
		}
		next(w, r)
	})
}

// handleLogin trades the token for a session cookie, so the page never keeps the token.
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if wait := s.limit.wait(ip); wait > 0 {
		tooMany(w, wait)
		return
	}
	if !s.sameSite(r) {
		fail(w, http.StatusForbidden, errors.New("sign in from the gateway's own page"))
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, errors.New("send the token as JSON: {\"token\": \"...\"}"))
		return
	}
	body.Token = strings.TrimSpace(body.Token)
	if s.token == "" || subtle.ConstantTimeCompare([]byte(body.Token), []byte(s.token)) != 1 {
		s.limit.fail(ip)
		fail(w, http.StatusUnauthorized, errors.New("that is not the gateway's token"))
		return
	}
	s.limit.reset(ip)
	http.SetCookie(w, s.cookie(r, s.sessionValue(), int(sessionAge/time.Second)))
	w.Header().Set("Cache-Control", "no-store")
	reply(w, http.StatusOK, map[string]any{"ok": true})
}

// handleLogout ends the session.
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if !s.sameSite(r) {
		fail(w, http.StatusForbidden, errors.New("sign out from the gateway's own page"))
		return
	}
	http.SetCookie(w, s.cookie(r, "", -1))
	reply(w, http.StatusOK, map[string]any{"ok": true})
}

// cookie builds the session cookie: out of reach of scripts, never sent along with another
// site's requests, and Secure on https.
func (s *Server) cookie(r *http.Request, value string, maxAge int) *http.Cookie {
	return &http.Cookie{Name: sessionCookie, Value: value, Path: "/", MaxAge: maxAge, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: s.isHTTPS(r)}
}

// handleSession tells the page where it stands, so it knows whether to ask for the token.
func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	valid, _, _ := s.credentials(r)
	w.Header().Set("Cache-Control", "no-store")
	reply(w, http.StatusOK, map[string]any{"signed_in": valid, "local_token": s.localTokenOK(r) == nil})
}

// hostIsLoopback reports whether a Host header names this machine. A page of another site that
// pointed its own name at 127.0.0.1 (DNS rebinding) reaches the gateway with another host.
func hostIsLoopback(host string) bool {
	h, _, err := net.SplitHostPort(host)
	if err != nil {
		h = strings.Trim(host, "[]")
	}
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// localTokenOK says why a request may not have the token, or nil when it may: it comes from
// this machine, addressed to this machine, directly (a proxy's requests look local too, so any
// sign of one refuses), and the gateway allows it at all.
func (s *Server) localTokenOK(r *http.Request) error {
	switch {
	case s.noLocalToken:
		return errors.New("this gateway does not hand its token out; sign in with it")
	case s.token == "":
		return errNoToken
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		return errors.New("the token is only handed out on this machine")
	}
	if s.trustProxy || r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("X-Forwarded-Host") != "" || r.Header.Get("X-Real-IP") != "" || r.Header.Get("Forwarded") != "" {
		return errors.New("the token is not handed out through a proxy")
	}
	if !hostIsLoopback(r.Host) {
		return errors.New("the token is only handed out to a page opened on this machine's own address")
	}
	if origin := r.Header.Get("Origin"); origin != "" && !sameOrigin(origin, r.Host) {
		return errors.New("the token is not handed to another site")
	}
	return nil
}

var errNoToken = errors.New("the gateway has no token")

// contentSecurity is the policy of the interface: its own scripts, styles and images only,
// nothing framed, nothing sent elsewhere.
const contentSecurity = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

// secure adds the headers every response carries.
func (s *Server) secure(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Frame-Options", "DENY")
	if s.isHTTPS(r) {
		h.Set("Strict-Transport-Security", "max-age=31536000")
	}
}

// handleStatic serves the interface: index.html at the root (never cached, it names the
// hashed assets), every other file with the cache its name allows. A path the build does not
// have is a 404; the page routes with the hash, so nothing else needs the index.
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	f, err := s.web.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		h.Set("Content-Type", ct)
	}
	switch {
	case name == "index.html":
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Cache-Control", "no-cache")
		h.Set("Content-Security-Policy", contentSecurity)
	case strings.HasPrefix(name, "assets/"):
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	default:
		h.Set("Cache-Control", "public, max-age=3600")
	}
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		data, err := io.ReadAll(f)
		if err != nil {
			http.Error(w, "unreadable", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write(data)
		return
	}
	http.ServeContent(w, r, name, time.Time{}, rs)
}
