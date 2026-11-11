package server

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
	"sync"
)

// Icon sets ship with the frontend as icons/<prefix>.json (see web/scripts/build-icons.mjs):
// {"width":24,"height":24,"icons":{"name":"<svg body>" | ["<body>",w,h,left,top]}}.
// A knowledge base icon "prefix:name" is rendered from there as a standalone SVG.

var reIconPart = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

type iconSet struct {
	width, height float64
	icons         map[string]json.RawMessage
}

type iconSets struct {
	mu   sync.Mutex
	sets map[string]*iconSet // nil value: set missing
}

func (c *iconSets) get(static fs.FS, prefix string) *iconSet {
	c.mu.Lock()
	defer c.mu.Unlock()
	if set, ok := c.sets[prefix]; ok {
		return set
	}
	if c.sets == nil {
		c.sets = map[string]*iconSet{}
	}
	var set *iconSet
	if static != nil {
		if raw, err := fs.ReadFile(static, "icons/"+prefix+".json"); err == nil {
			var data struct {
				Width  float64                    `json:"width"`
				Height float64                    `json:"height"`
				Icons  map[string]json.RawMessage `json:"icons"`
			}
			if json.Unmarshal(raw, &data) == nil {
				set = &iconSet{width: data.Width, height: data.Height, icons: data.Icons}
			}
		}
	}
	c.sets[prefix] = set
	return set
}

// svg renders one icon, or "" when the set has no such icon.
func (set *iconSet) svg(name string) string {
	raw, ok := set.icons[name]
	if !ok {
		return ""
	}
	var body string
	w, h, left, top := set.width, set.height, 0.0, 0.0
	if json.Unmarshal(raw, &body) != nil {
		var parts []any
		if json.Unmarshal(raw, &parts) != nil || len(parts) != 5 {
			return ""
		}
		body, _ = parts[0].(string)
		w, _ = parts[1].(float64)
		h, _ = parts[2].(float64)
		left, _ = parts[3].(float64)
		top, _ = parts[4].(float64)
	}
	if body == "" || w <= 0 || h <= 0 {
		return ""
	}
	return fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="%g %g %g %g" width="%g" height="%g">%s</svg>`, left, top, w, h, w, h, body)
}

func (s *Server) serveIcon(w http.ResponseWriter, r *http.Request) {
	prefix, name := r.PathValue("set"), strings.TrimSuffix(r.PathValue("name"), ".svg")
	if !reIconPart.MatchString(prefix) || !reIconPart.MatchString(name) || !strings.HasSuffix(r.PathValue("name"), ".svg") {
		http.NotFound(w, r)
		return
	}
	set := s.icons.get(s.static, prefix)
	if set == nil {
		http.NotFound(w, r)
		return
	}
	svg := set.svg(name)
	if svg == "" {
		http.NotFound(w, r)
		return
	}
	hd := w.Header()
	hd.Set("Content-Type", "image/svg+xml")
	hd.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	hd.Set("Cache-Control", "public, max-age=604800")
	w.Write([]byte(svg))
}
