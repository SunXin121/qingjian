package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

var errShareView = errors.New("分享视图不存在或筛选条件暂不支持，请联系分享者调整视图")

type shareCond struct {
	Field string `json:"field"`
	Op    string `json:"op"`
	Value any    `json:"value"`
}

type shareViewConfig struct {
	Hidden []string `json:"hidden"`
	Filter *struct {
		Conj  string      `json:"conj"`
		Conds []shareCond `json:"conds"`
	} `json:"filter"`
}

// sharedTableView resolves an embedded view without treating an embed as permission
// to read the entire table. A requested view must itself occur in a covered document.
func (s *Server) sharedTableView(sh *Share, t *TableData, requested string) (string, bool, error) {
	if s.shareCovers(sh, t.ID) {
		if sh.TargetType == "node" && sh.TargetID == t.ID && sh.ViewID != nil {
			if requested != "" && requested != *sh.ViewID {
				return "", false, errShareView
			}
			return *sh.ViewID, true, nil
		}
		return "", false, nil
	}
	cond, args := shareScope(sh)
	rows, err := s.db.Query(`SELECT d.markdown FROM doc_contents d JOIN nodes n ON n.id = d.node_id
WHERE n.deleted_at IS NULL AND d.markdown LIKE ? AND `+cond+` ORDER BY n.id`, append([]any{"%" + t.ID + "%"}, args...)...)
	if err != nil {
		return "", false, err
	}
	defer rows.Close()
	var selected string
	found := false
	embedded := false
	for rows.Next() {
		var md string
		if err := rows.Scan(&md); err != nil {
			return "", false, err
		}
		for _, ref := range embeddedTables(md) {
			if ref.Table != t.ID {
				continue
			}
			embedded = true
			view := ref.View
			if view == "" && len(t.Views) > 0 {
				view = t.Views[0].ID
			}
			if requested != "" && requested != view {
				continue
			}
			if !found {
				selected, found = view, true
			}
		}
	}
	if err := rows.Err(); err != nil {
		return "", false, err
	}
	if !embedded {
		return "", false, sql.ErrNoRows
	}
	if !found {
		return "", false, errShareView
	}
	return selected, true, nil
}

// A linked table may also have an explicit embedded-view boundary in this share.
// Apply that boundary before collecting computed-field dependencies. Tables exposed
// only through a visible association retain the existing dependency-only projection.
func (s *Server) restrictLinkedShare(sh *Share, linked map[string]*TableData) error {
	for _, table := range linked {
		full, err := s.loadTableData(s.db, table.ID)
		if err != nil {
			return err
		}
		view, restricted, err := s.sharedTableView(sh, full, "")
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if restricted {
			if err := restrictShareView(full, view); err != nil {
				return err
			}
			*table = *full
		}
	}
	return nil
}

// restrictShareView applies filters before projection, so hidden filter fields never
// need to leave the server. Unknown expressions fail closed instead of exposing rows.
func restrictShareView(t *TableData, viewID string) error {
	var view *View
	for i := range t.Views {
		if t.Views[i].ID == viewID {
			view = &t.Views[i]
			break
		}
	}
	if view == nil {
		return errShareView
	}
	var cfg shareViewConfig
	if json.Unmarshal(view.Config, &cfg) != nil {
		return errShareView
	}
	tests := []func(*Record) bool{}
	if cfg.Filter != nil {
		if cfg.Filter.Conj != "and" && cfg.Filter.Conj != "or" && cfg.Filter.Conj != "" {
			return errShareView
		}
		for _, c := range cfg.Filter.Conds {
			test, err := shareCondition(t, c)
			if err != nil {
				return err
			}
			if test != nil {
				tests = append(tests, test)
			}
		}
	}
	records := make([]Record, 0, len(t.Records))
	fields := t.visibleFields(viewID)
	for _, r := range t.Records {
		match := true
		if len(tests) > 0 {
			match = cfg.Filter.Conj != "or"
			for _, test := range tests {
				hit := test(&r)
				if cfg.Filter.Conj == "or" {
					match = match || hit
				} else {
					match = match && hit
				}
			}
		}
		if !match {
			continue
		}
		data := recordData(&r)
		projected := map[string]json.RawMessage{}
		for _, f := range fields {
			if raw, ok := data[f.ID]; ok {
				projected[f.ID] = raw
			}
		}
		var err error
		r.Data, err = json.Marshal(projected)
		if err != nil {
			return err
		}
		records = append(records, r)
	}
	// Filter literals can contain private values; the browser receives already filtered
	// rows. Remove the filter as well as hidden field IDs from the view configuration.
	config := map[string]json.RawMessage{}
	if err := json.Unmarshal(view.Config, &config); err != nil {
		return errShareView
	}
	delete(config, "filter")
	delete(config, "hidden")
	view.Config, _ = json.Marshal(config)
	t.Fields, t.Records, t.Views = fields, records, []View{*view}
	return nil
}

func shareEmpty(v any) bool {
	if v == nil || v == "" || v == false {
		return true
	}
	if a, ok := v.([]any); ok {
		return len(a) == 0
	}
	return false
}

func shareString(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

func shareDate(v any) string {
	if n, ok := v.(float64); ok {
		return time.UnixMilli(int64(n)).Format("2006-01-02")
	}
	s, ok := v.(string)
	if !ok {
		return ""
	}
	if len(s) > 10 {
		return s[:10]
	}
	return s
}

func shareCondition(t *TableData, c shareCond) (func(*Record) bool, error) {
	f := t.field(c.Field)
	// Checkbox conditions are active even without a value (the editor treats it as false).
	if (f == nil || f.Type != "checkbox") && c.Op != "empty" && c.Op != "not_empty" {
		if c.Value == nil || strings.TrimSpace(shareString(c.Value)) == "" {
			return nil, nil
		}
		if a, ok := c.Value.([]any); ok && len(a) == 0 {
			return nil, nil
		}
	}
	if f == nil || c.Op == "expr" {
		return nil, errShareView
	}
	if f.Type == "formula" || f.Type == "lookup" || f.Type == "rollup" || f.Type == "link" {
		return nil, errShareView
	}
	allowed := ""
	switch f.Type {
	case "number", "autonumber", "rating", "progress":
		allowed = " is is_not gt gte lt lte empty not_empty "
	case "select":
		allowed = " is is_not empty not_empty "
	case "multiselect":
		allowed = " contains not_contains empty not_empty "
	case "date", "created_time", "modified_time":
		allowed = " is lt gt empty not_empty "
	case "checkbox":
		allowed = " is "
	case "attachment":
		allowed = " contains empty not_empty "
	default:
		allowed = " contains not_contains is is_not empty not_empty "
	}
	if !strings.Contains(allowed, " "+c.Op+" ") {
		return nil, errShareView
	}
	targetDate := shareString(c.Value)
	switch targetDate {
	case "today":
		targetDate = time.Now().Format("2006-01-02")
	case "yesterday":
		targetDate = time.Now().AddDate(0, 0, -1).Format("2006-01-02")
	case "tomorrow":
		targetDate = time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	}
	return func(r *Record) bool {
		var value any
		json.Unmarshal(recordData(r)[f.ID], &value)
		switch f.Type {
		case "autonumber":
			value = float64(r.Seq)
		case "created_time":
			value = float64(r.CreatedAt)
		case "modified_time":
			value = float64(r.UpdatedAt)
		}
		if c.Op == "empty" {
			return shareEmpty(value)
		}
		if c.Op == "not_empty" {
			return !shareEmpty(value)
		}
		switch f.Type {
		case "checkbox":
			a, _ := value.(bool)
			b, _ := c.Value.(bool)
			return a == b
		case "number", "autonumber", "rating", "progress":
			n, ok := value.(float64)
			if !ok {
				return c.Op == "is_not"
			}
			x, err := strconv.ParseFloat(shareString(c.Value), 64)
			if err != nil {
				return false
			}
			if f.Type == "progress" {
				x /= 100
			}
			switch c.Op {
			case "is":
				return n == x
			case "is_not":
				return n != x
			case "gt":
				return n > x
			case "gte":
				return n >= x
			case "lt":
				return n < x
			case "lte":
				return n <= x
			}
		case "select", "multiselect":
			ids, ok := c.Value.([]any)
			if !ok {
				ids = []any{c.Value}
			}
			values := []any{value}
			if f.Type == "multiselect" {
				values, _ = value.([]any)
			}
			hit := false
			for _, a := range ids {
				for _, b := range values {
					if shareString(a) == shareString(b) {
						hit = true
					}
				}
			}
			if c.Op == "is_not" || c.Op == "not_contains" {
				return !hit
			}
			return hit
		case "date", "created_time", "modified_time":
			d := shareDate(value)
			if d == "" {
				return false
			}
			switch c.Op {
			case "is":
				return d == targetDate
			case "lt":
				return d < targetDate
			case "gt":
				return d > targetDate
			}
		default:
			text := strings.ToLower(cellText(f, r, recordData(r), false))
			q := strings.ToLower(strings.TrimSpace(shareString(c.Value)))
			switch c.Op {
			case "contains":
				return strings.Contains(text, q)
			case "not_contains":
				return !strings.Contains(text, q)
			case "is":
				return text == q
			case "is_not":
				return text != q
			}
		}
		return false
	}, nil
}
