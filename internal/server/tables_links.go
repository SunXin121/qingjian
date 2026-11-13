package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Link fields (关联) store the ids of records in another table (or the same one). A
// two-way link has a paired field in the other table; the server keeps both sides in sync.
// Lookups, rollups and formulas are computed in the browser, which needs the linked
// tables: they are sent along with the table (trimmed to what is needed on share pages).

type fieldOpts struct {
	Table    string `json:"table,omitempty"`
	Pair     string `json:"pair,omitempty"`
	PairName string `json:"pairName,omitempty"`
	Link     string `json:"link,omitempty"`
	Target   string `json:"target,omitempty"`
	Expr     string `json:"expr,omitempty"`
}

func parseOpts(raw json.RawMessage) fieldOpts {
	var o fieldOpts
	json.Unmarshal(raw, &o)
	return o
}

// setOptKeys returns the options object with keys set (nil value: removed).
func setOptKeys(raw json.RawMessage, kv map[string]any) string {
	m := map[string]any{}
	json.Unmarshal(raw, &m)
	for k, v := range kv {
		if v == nil {
			delete(m, k)
		} else {
			m[k] = v
		}
	}
	b, _ := json.Marshal(m)
	return string(b)
}

const maxLinkedTables = 30

func (t *TableData) field(id string) *Field {
	for i := range t.Fields {
		if t.Fields[i].ID == id {
			return &t.Fields[i]
		}
	}
	return nil
}

// linkedTables loads every table reachable from t through link fields.
func (s *Server) linkedTables(q querier, t *TableData) map[string]*TableData {
	out := map[string]*TableData{}
	queue := []*TableData{t}
	for len(queue) > 0 && len(out) < maxLinkedTables {
		cur := queue[0]
		queue = queue[1:]
		for _, f := range cur.Fields {
			if f.Type != "link" {
				continue
			}
			id := parseOpts(f.Options).Table
			if id == "" || id == t.ID || out[id] != nil {
				continue
			}
			lt, err := s.loadTableData(q, id)
			if err != nil {
				continue
			}
			lt.Views = []View{}
			out[id] = lt
			queue = append(queue, lt)
		}
	}
	return out
}

var reExprRef = regexp.MustCompile(`\{#([0-9a-z]+)\}`)

// trimLinked keeps only what the root table's link, lookup, rollup and formula fields
// read from the linked tables: their primary fields, the fields looked up (and whatever
// those depend on) and the records actually linked to.
func trimLinked(root *TableData, linked map[string]*TableData) {
	tables := map[string]*TableData{root.ID: root}
	for id, t := range linked {
		tables[id] = t
	}
	needF := map[string]map[string]bool{}
	needR := map[string]map[string]bool{}
	mark := func(m map[string]map[string]bool, tid, id string) bool {
		if tables[tid] == nil || id == "" {
			return false
		}
		if m[tid] == nil {
			m[tid] = map[string]bool{}
		}
		if m[tid][id] {
			return false
		}
		m[tid][id] = true
		return true
	}
	for _, f := range root.Fields {
		mark(needF, root.ID, f.ID)
	}
	for _, r := range root.Records {
		mark(needR, root.ID, r.ID)
	}
	for changed := true; changed; {
		changed = false
		for tid, fields := range needF {
			t := tables[tid]
			for fid := range fields {
				f := t.field(fid)
				if f == nil {
					continue
				}
				o := parseOpts(f.Options)
				switch f.Type {
				case "link":
					if lt := tables[o.Table]; lt != nil && len(lt.Fields) > 0 {
						changed = mark(needF, o.Table, lt.Fields[0].ID) || changed
					}
				case "lookup", "rollup":
					changed = mark(needF, tid, o.Link) || changed
					if l := t.field(o.Link); l != nil {
						changed = mark(needF, parseOpts(l.Options).Table, o.Target) || changed
					}
				case "formula":
					for _, m := range reExprRef.FindAllStringSubmatch(o.Expr, -1) {
						changed = mark(needF, tid, m[1]) || changed
					}
				}
			}
		}
		for tid, recs := range needR {
			t := tables[tid]
			for _, f := range t.Fields {
				if f.Type != "link" || !needF[tid][f.ID] {
					continue
				}
				target := parseOpts(f.Options).Table
				for i := range t.Records {
					r := &t.Records[i]
					if !recs[r.ID] {
						continue
					}
					var ids []string
					json.Unmarshal(recordData(r)[f.ID], &ids)
					for _, id := range ids {
						changed = mark(needR, target, id) || changed
					}
				}
			}
		}
	}
	for id, t := range linked {
		fields := t.Fields[:0:0]
		for _, f := range t.Fields {
			if needF[id][f.ID] {
				fields = append(fields, f)
			}
		}
		recs := t.Records[:0:0]
		for _, r := range t.Records {
			if !needR[id][r.ID] {
				continue
			}
			data := recordData(&r)
			for k := range data {
				if !needF[id][k] {
					delete(data, k)
				}
			}
			r.Data, _ = json.Marshal(data)
			recs = append(recs, r)
		}
		t.Fields, t.Records = fields, recs
	}
}

// ---------- keeping two-way links in sync ----------

type pairInfo struct{ table, pair string }

// linkSync mirrors changes of two-way link fields into the paired fields.
type linkSync struct {
	tx      *sql.Tx
	tableID string
	t       int64
	pairs   map[string]pairInfo // field id -> pair; nil: reload
	touched map[string]bool     // other tables changed
}

func (l *linkSync) invalidate() { l.pairs = nil }

func (l *linkSync) load() error {
	if l.pairs != nil {
		return nil
	}
	rows, err := l.tx.Query(`SELECT id, options FROM bt_fields WHERE table_node_id = ? AND type = 'link'`, l.tableID)
	if err != nil {
		return err
	}
	defer rows.Close()
	l.pairs = map[string]pairInfo{}
	for rows.Next() {
		var id, opts string
		if err := rows.Scan(&id, &opts); err != nil {
			return err
		}
		o := parseOpts(json.RawMessage(opts))
		if o.Pair != "" && o.Table != "" && o.Table != l.tableID {
			l.pairs[id] = pairInfo{o.Table, o.Pair}
		}
	}
	return rows.Err()
}

func idList(raw json.RawMessage) []string {
	var ids []string
	json.Unmarshal(raw, &ids)
	return ids
}

// recordValues reads a record's data (nil when the record does not exist).
func recordValues(q querier, tableID, id string) (map[string]json.RawMessage, error) {
	var raw string
	err := q.QueryRow(`SELECT data FROM bt_records WHERE id = ? AND table_node_id = ?`, id, tableID).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	m := map[string]json.RawMessage{}
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, err
	}
	return m, nil
}

// before returns the current values of the record's two-way link fields.
func (l *linkSync) before(recID string) (map[string][]string, error) {
	if err := l.load(); err != nil || len(l.pairs) == 0 {
		return nil, err
	}
	data, err := recordValues(l.tx, l.tableID, recID)
	if err != nil {
		return nil, err
	}
	out := map[string][]string{}
	for fid := range l.pairs {
		out[fid] = idList(data[fid])
	}
	return out, nil
}

// apply mirrors the difference between old and new link values of a record. next holds
// only the fields that were written (a delete passes every pair field as empty).
func (l *linkSync) apply(recID string, old map[string][]string, next map[string]json.RawMessage) error {
	for fid, p := range l.pairs {
		raw, ok := next[fid]
		if !ok {
			continue
		}
		was := map[string]bool{}
		for _, id := range old[fid] {
			was[id] = true
		}
		now := map[string]bool{}
		for _, id := range idList(raw) {
			now[id] = true
			if !was[id] {
				if err := l.mirror(p, id, recID, true); err != nil {
					return err
				}
			}
		}
		for id := range was {
			if !now[id] {
				if err := l.mirror(p, id, recID, false); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// mirror adds / removes src in the pair field of record target of the other table.
func (l *linkSync) mirror(p pairInfo, target, src string, add bool) error {
	data, err := recordValues(l.tx, p.table, target)
	if err != nil || data == nil {
		return err
	}
	ids := idList(data[p.pair])
	out := make([]string, 0, len(ids)+1)
	found := false
	for _, id := range ids {
		if id == src {
			found = true
			if !add {
				continue
			}
		}
		out = append(out, id)
	}
	if add == found {
		return nil
	}
	if add {
		out = append(out, src)
	}
	if len(out) == 0 {
		_, err = l.tx.Exec(`UPDATE bt_records SET data = json_remove(data, ?), updated_at = ? WHERE id = ? AND table_node_id = ?`, `$."`+p.pair+`"`, l.t, target, p.table)
	} else {
		b, _ := json.Marshal(out)
		_, err = l.tx.Exec(`UPDATE bt_records SET data = json_set(data, ?, json(?)), updated_at = ? WHERE id = ? AND table_node_id = ?`, `$."`+p.pair+`"`, string(b), l.t, target, p.table)
	}
	if l.touched == nil {
		l.touched = map[string]bool{}
	}
	l.touched[p.table] = true
	return err
}

// pairField creates (or re-attaches) the field paired with link field id of this table and
// returns the options to store for the field: without pairName, and without pair when
// no pair could be set up. Existing links are mirrored into the new pair field.
func (l *linkSync) pairField(id string, options json.RawMessage) (string, error) {
	o := parseOpts(options)
	if o.Pair == "" {
		return setOptKeys(options, map[string]any{"pairName": nil}), nil
	}
	drop := setOptKeys(options, map[string]any{"pairName": nil, "pair": nil})
	if o.Table == "" || o.Table == l.tableID || !reBTID.MatchString(o.Pair) {
		return drop, nil
	}
	var typ string
	err := l.tx.QueryRow(`SELECT type FROM nodes WHERE id = ? AND deleted_at IS NULL`, o.Table).Scan(&typ)
	if err == sql.ErrNoRows || (err == nil && typ != "table") {
		return drop, nil
	}
	if err != nil {
		return "", err
	}
	var ptype, popts, ptable string
	err = l.tx.QueryRow(`SELECT type, options, table_node_id FROM bt_fields WHERE id = ?`, o.Pair).Scan(&ptype, &popts, &ptable)
	switch {
	case err == sql.ErrNoRows:
		var sortKey float64
		if err := l.tx.QueryRow(`SELECT COALESCE(MAX(sort), 0) + 1 FROM bt_fields WHERE table_node_id = ?`, o.Table).Scan(&sortKey); err != nil {
			return "", err
		}
		popt, _ := json.Marshal(map[string]any{"table": l.tableID, "pair": id})
		if _, err := l.tx.Exec(`INSERT INTO bt_fields(id, table_node_id, name, type, options, sort) VALUES(?,?,?,?,?,?)`,
			o.Pair, o.Table, nonEmpty(o.PairName, "关联"), "link", string(popt), sortKey); err != nil {
			return "", err
		}
	case err != nil:
		return "", err
	default:
		po := parseOpts(json.RawMessage(popts))
		if ptable != o.Table || ptype != "link" || po.Table != l.tableID || (po.Pair != "" && po.Pair != id) {
			return drop, nil
		}
		if _, err := l.tx.Exec(`UPDATE bt_fields SET options = ? WHERE id = ?`, setOptKeys(json.RawMessage(popts), map[string]any{"pair": id}), o.Pair); err != nil {
			return "", err
		}
	}
	if l.touched == nil {
		l.touched = map[string]bool{}
	}
	l.touched[o.Table] = true
	// back-fill: records already linked show up on the other side
	rows, err := l.tx.Query(`SELECT id, json_extract(data, ?) FROM bt_records WHERE table_node_id = ? AND json_extract(data, ?) IS NOT NULL`, `$."`+id+`"`, l.tableID, `$."`+id+`"`)
	if err != nil {
		return "", err
	}
	type link struct {
		rec string
		ids []string
	}
	var links []link
	for rows.Next() {
		var rec string
		var raw sql.NullString
		if err := rows.Scan(&rec, &raw); err != nil {
			rows.Close()
			return "", err
		}
		links = append(links, link{rec, idList(json.RawMessage(raw.String))})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", err
	}
	sort.Slice(links, func(i, j int) bool { return links[i].rec < links[j].rec })
	p := pairInfo{o.Table, o.Pair}
	for _, lk := range links {
		for _, target := range lk.ids {
			if err := l.mirror(p, target, lk.rec, true); err != nil {
				return "", err
			}
		}
	}
	l.invalidate()
	return setOptKeys(options, map[string]any{"pairName": nil}), nil
}

// unpair turns the field paired with a link field into a one-way link (it keeps its values).
func (l *linkSync) unpair(id string, options string) error {
	o := parseOpts(json.RawMessage(options))
	if o.Pair == "" || o.Table == "" {
		return nil
	}
	var popts string
	err := l.tx.QueryRow(`SELECT options FROM bt_fields WHERE id = ? AND table_node_id = ?`, o.Pair, o.Table).Scan(&popts)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if parseOpts(json.RawMessage(popts)).Pair != id {
		return nil
	}
	_, err = l.tx.Exec(`UPDATE bt_fields SET options = ? WHERE id = ?`, setOptKeys(json.RawMessage(popts), map[string]any{"pair": nil}), o.Pair)
	l.invalidate()
	return err
}

// ---------- plain-text rendering of computed values (exports) ----------

// withLinked attaches the linked tables used to render link / lookup / rollup values.
func (s *Server) withLinked(t *TableData) *TableData {
	linked := s.linkedTables(s.db, t)
	all := map[string]*TableData{t.ID: t}
	for id, lt := range linked {
		all[id] = lt
	}
	for _, x := range all {
		x.ctx = all
	}
	return t
}

func (t *TableData) tableByID(id string) *TableData {
	if id == t.ID {
		return t
	}
	return t.ctx[id]
}

func (t *TableData) record(id string) *Record {
	if t.recIdx == nil {
		t.recIdx = make(map[string]*Record, len(t.Records))
		for i := range t.Records {
			t.recIdx[t.Records[i].ID] = &t.Records[i]
		}
	}
	return t.recIdx[id]
}

// linked returns the linked table and records of a link field value.
func (t *TableData) linked(link *Field, data map[string]json.RawMessage) (*TableData, []*Record) {
	lt := t.tableByID(parseOpts(link.Options).Table)
	if lt == nil {
		return nil, nil
	}
	var out []*Record
	for _, id := range idList(data[link.ID]) {
		if r := lt.record(id); r != nil {
			out = append(out, r)
		}
	}
	return lt, out
}

var numericTypes = map[string]bool{"number": true, "rating": true, "progress": true, "autonumber": true}

// lookupItems: the target field's values over the linked records (numbers as float64).
func (t *TableData) lookupItems(f *Field, data map[string]json.RawMessage, depth int) []any {
	o := parseOpts(f.Options)
	link := t.field(o.Link)
	if link == nil || link.Type != "link" || depth > 8 {
		return nil
	}
	lt, recs := t.linked(link, data)
	if lt == nil {
		return nil
	}
	target := lt.field(o.Target)
	if target == nil {
		return nil
	}
	var out []any
	for _, r := range recs {
		d := recordData(r)
		if numericTypes[target.Type] && target.Type != "autonumber" {
			var v float64
			if json.Unmarshal(d[target.ID], &v) == nil {
				out = append(out, v)
			}
			continue
		}
		if target.Type == "lookup" {
			out = append(out, lt.lookupItems(target, d, depth+1)...)
			continue
		}
		if s := lt.text(target, r, d, false, depth+1); s != "" {
			if target.Type == "autonumber" {
				out = append(out, float64(r.Seq))
			} else {
				out = append(out, s)
			}
		}
	}
	return out
}

func itemText(v any) string {
	if f, ok := v.(float64); ok {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

func (t *TableData) rollupText(f *Field, data map[string]json.RawMessage, depth int) string {
	items := t.lookupItems(f, data, depth)
	var o struct {
		Agg       string `json:"agg"`
		Precision *int   `json:"precision"`
	}
	json.Unmarshal(f.Options, &o)
	switch o.Agg {
	case "count":
		return strconv.Itoa(len(items))
	case "unique":
		seen := map[string]bool{}
		for _, v := range items {
			seen[strings.ToLower(strings.TrimSpace(itemText(v)))] = true
		}
		return strconv.Itoa(len(seen))
	case "concat", "concat_unique":
		seen := map[string]bool{}
		var parts []string
		for _, v := range items {
			s := itemText(v)
			if s == "" || (o.Agg == "concat_unique" && seen[s]) {
				continue
			}
			seen[s] = true
			parts = append(parts, s)
		}
		return strings.Join(parts, ", ")
	case "earliest", "latest":
		var ds []string
		for _, v := range items {
			if s, ok := v.(string); ok && len(s) >= 10 && s[4] == '-' {
				ds = append(ds, s)
			}
		}
		if len(ds) == 0 {
			return ""
		}
		sort.Strings(ds)
		if o.Agg == "earliest" {
			return ds[0]
		}
		return ds[len(ds)-1]
	}
	var nums []float64
	for _, v := range items {
		switch x := v.(type) {
		case float64:
			nums = append(nums, x)
		case string:
			if n, err := strconv.ParseFloat(strings.ReplaceAll(x, ",", ""), 64); err == nil {
				nums = append(nums, n)
			}
		}
	}
	if len(nums) == 0 {
		return ""
	}
	sum, lo, hi := 0.0, nums[0], nums[0]
	for _, n := range nums {
		sum += n
		lo, hi = min(lo, n), max(hi, n)
	}
	var v float64
	switch o.Agg {
	case "avg":
		v = sum / float64(len(nums))
	case "min":
		v = lo
	case "max":
		v = hi
	default:
		v = sum
	}
	prec := -1
	if o.Precision != nil {
		prec = *o.Precision
	} else if o.Agg == "avg" {
		prec = 2
	}
	return strconv.FormatFloat(v, 'f', prec, 64)
}

// text renders any field of the table, computed link / lookup / rollup values included.
// Formulas are evaluated in the browser only and export as empty.
func (t *TableData) text(f *Field, r *Record, data map[string]json.RawMessage, markdown bool, depth int) string {
	switch f.Type {
	case "link":
		lt, recs := t.linked(f, data)
		if lt == nil || len(lt.Fields) == 0 {
			return ""
		}
		primary := &lt.Fields[0]
		parts := make([]string, 0, len(recs))
		for _, lr := range recs {
			s := ""
			if primary.Type != "link" && primary.Type != "lookup" && primary.Type != "rollup" {
				s = cellText(primary, lr, recordData(lr), false)
			}
			parts = append(parts, nonEmpty(s, "未命名记录"))
		}
		return strings.Join(parts, ", ")
	case "lookup":
		items := t.lookupItems(f, data, depth)
		parts := make([]string, 0, len(items))
		for _, v := range items {
			parts = append(parts, itemText(v))
		}
		return strings.Join(parts, ", ")
	case "rollup":
		return t.rollupText(f, data, depth)
	case "formula":
		return ""
	}
	return cellText(f, r, data, markdown)
}
