package server

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// A table embedded in a document: ```table {"table":"<id>","view":"<view id>"} ```
var reTableEmbed = regexp.MustCompile("(?s)```[ \\t]*table[ \\t]*\\r?\\n(.*?)\\r?\\n[ \\t]*```")

type tableEmbed struct {
	Table string `json:"table"`
	View  string `json:"view"`
}

func embeddedTables(md string) []tableEmbed {
	var out []tableEmbed
	for _, m := range reTableEmbed.FindAllStringSubmatch(md, -1) {
		var e tableEmbed
		if json.Unmarshal([]byte(strings.TrimSpace(m[1])), &e) == nil && e.Table != "" {
			out = append(out, e)
		}
	}
	return out
}

type fieldOptions struct {
	Precision *int `json:"precision"`
	Choices   []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"choices"`
}

type viewConfig struct {
	Hidden []string `json:"hidden"`
	Order  []string `json:"order"`
}

type attValue struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// visibleFields returns the fields a view shows, in its column order.
func (t *TableData) visibleFields(viewID string) []Field {
	var cfg viewConfig
	for _, v := range t.Views {
		if v.ID == viewID || viewID == "" {
			json.Unmarshal(v.Config, &cfg)
			break
		}
	}
	hidden := map[string]bool{}
	for _, id := range cfg.Hidden {
		hidden[id] = true
	}
	pos := map[string]int{}
	for i, id := range cfg.Order {
		pos[id] = i + 1
	}
	fields := make([]Field, 0, len(t.Fields))
	for i, f := range t.Fields {
		// the primary field is always shown, first
		if i == 0 || !hidden[f.ID] {
			fields = append(fields, f)
		}
	}
	rank := func(i int) int {
		if i == 0 {
			return -1
		}
		if p, ok := pos[fields[i].ID]; ok {
			return p
		}
		return 1 << 20
	}
	// stable insertion sort: fields are few
	for i := 1; i < len(fields); i++ {
		for j := i; j > 0 && rank(j) < rank(j-1); j-- {
			fields[j], fields[j-1] = fields[j-1], fields[j]
		}
	}
	return fields
}

// cellText renders a value as plain text; markdown=true renders attachments as links.
func cellText(f *Field, r *Record, data map[string]json.RawMessage, markdown bool) string {
	switch f.Type {
	case "autonumber":
		return strconv.FormatInt(r.Seq, 10)
	case "created_time":
		return time.UnixMilli(r.CreatedAt).Format("2006-01-02 15:04")
	case "modified_time":
		return time.UnixMilli(r.UpdatedAt).Format("2006-01-02 15:04")
	}
	raw, ok := data[f.ID]
	if !ok || string(raw) == "null" {
		return ""
	}
	var opts fieldOptions
	json.Unmarshal(f.Options, &opts)
	choice := func(id string) string {
		for _, c := range opts.Choices {
			if c.ID == id {
				return c.Name
			}
		}
		return ""
	}
	switch f.Type {
	case "number":
		var v float64
		if json.Unmarshal(raw, &v) != nil {
			return ""
		}
		prec := -1
		if opts.Precision != nil {
			prec = *opts.Precision
		}
		return strconv.FormatFloat(v, 'f', prec, 64)
	case "select":
		var id string
		json.Unmarshal(raw, &id)
		return choice(id)
	case "multiselect":
		var ids []string
		json.Unmarshal(raw, &ids)
		names := make([]string, 0, len(ids))
		for _, id := range ids {
			if n := choice(id); n != "" {
				names = append(names, n)
			}
		}
		return strings.Join(names, ", ")
	case "checkbox":
		var b bool
		json.Unmarshal(raw, &b)
		if b {
			return "✓"
		}
		return ""
	case "attachment":
		var atts []attValue
		json.Unmarshal(raw, &atts)
		parts := make([]string, 0, len(atts))
		for _, a := range atts {
			if markdown && a.URL != "" {
				parts = append(parts, "["+strings.NewReplacer("[", `\[`, "]", `\]`).Replace(a.Name)+"]("+a.URL+")")
			} else {
				parts = append(parts, a.Name)
			}
		}
		return strings.Join(parts, ", ")
	default: // text, longtext, url, date
		var v string
		if json.Unmarshal(raw, &v) != nil {
			return strings.Trim(string(raw), `"`)
		}
		return v
	}
}

func recordData(r *Record) map[string]json.RawMessage {
	m := map[string]json.RawMessage{}
	json.Unmarshal(r.Data, &m)
	return m
}

const maxEmbedRows = 500

// markdown renders a view of the table as a GFM table.
func (t *TableData) markdown(viewID string) string {
	fields := t.visibleFields(viewID)
	esc := strings.NewReplacer("|", `\|`, "\r\n", "<br>", "\n", "<br>")
	var b strings.Builder
	b.WriteString("|")
	for _, f := range fields {
		b.WriteString(" " + esc.Replace(f.Name) + " |")
	}
	b.WriteString("\n|")
	for range fields {
		b.WriteString(" --- |")
	}
	for i := range t.Records {
		if i == maxEmbedRows {
			break
		}
		r := &t.Records[i]
		data := recordData(r)
		b.WriteString("\n|")
		for j := range fields {
			b.WriteString(" " + esc.Replace(cellText(&fields[j], r, data, true)) + " |")
		}
	}
	return b.String()
}

// csv renders every field and record (UTF-8 with BOM so Excel detects the encoding).
func (t *TableData) csv() string {
	var buf bytes.Buffer
	buf.WriteString("\uFEFF")
	w := csv.NewWriter(&buf)
	w.UseCRLF = true
	header := make([]string, len(t.Fields))
	for i, f := range t.Fields {
		header[i] = f.Name
	}
	w.Write(header)
	for i := range t.Records {
		r := &t.Records[i]
		data := recordData(r)
		row := make([]string, len(t.Fields))
		for j := range t.Fields {
			row[j] = cellText(&t.Fields[j], r, data, false)
		}
		w.Write(row)
	}
	w.Flush()
	return buf.String()
}

// embedMarkdown replaces table embeds by a markdown rendering of the referenced view.
func (s *Server) embedMarkdown(md string) string {
	return reTableEmbed.ReplaceAllStringFunc(md, func(block string) string {
		m := reTableEmbed.FindStringSubmatch(block)
		var e tableEmbed
		if json.Unmarshal([]byte(strings.TrimSpace(m[1])), &e) != nil || e.Table == "" {
			return block
		}
		t, err := s.loadTableData(s.db, e.Table)
		if err != nil {
			return ""
		}
		title := nonEmpty(t.Title, "未命名表格")
		return "**" + title + "**\n\n" + t.markdown(e.View)
	})
}
