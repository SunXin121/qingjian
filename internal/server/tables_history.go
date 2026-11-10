package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"sort"
	"strconv"
)

// 记录修改历史. Every record change made through the ops endpoint is logged with the old
// and new value of each touched field. Quick successive edits of the same fields are
// merged into one entry, so typing, fixing a typo or undoing does not flood the log.

const (
	historyMergeWindow = 60_000 // ms
	historyPageSize    = 50
)

type historyChange struct {
	Field string `json:"field"`
	// name and type of the field at the time, for fields deleted or retyped since
	Name string          `json:"name"`
	Type string          `json:"type"`
	Old  json.RawMessage `json:"old,omitempty"`
	New  json.RawMessage `json:"new,omitempty"`
}

type historyEntry struct {
	ID        int64           `json:"id"`
	Action    string          `json:"action"` // create | update | delete | restore
	Changes   []historyChange `json:"changes"`
	CreatedAt int64           `json:"created_at"`
	UpdatedAt int64           `json:"updated_at"`
}

type fieldMeta struct {
	name, typ string
	order     int
}

// historyWriter logs the record ops of one request; it lives inside the ops transaction.
type historyWriter struct {
	tx      *sql.Tx
	tableID string
	t       int64
	fields  map[string]fieldMeta // nil: (re)load on next use
}

func (h *historyWriter) invalidateFields() { h.fields = nil }

func (h *historyWriter) field(id string) (fieldMeta, bool, error) {
	if h.fields == nil {
		rows, err := h.tx.Query(`SELECT id, name, type FROM bt_fields WHERE table_node_id = ? ORDER BY sort, rowid`, h.tableID)
		if err != nil {
			return fieldMeta{}, false, err
		}
		defer rows.Close()
		h.fields = map[string]fieldMeta{}
		for i := 0; rows.Next(); i++ {
			var fid string
			var m fieldMeta
			if err := rows.Scan(&fid, &m.name, &m.typ); err != nil {
				return fieldMeta{}, false, err
			}
			m.order = i
			h.fields[fid] = m
		}
		if err := rows.Err(); err != nil {
			return fieldMeta{}, false, err
		}
	}
	m, ok := h.fields[id]
	return m, ok, nil
}

// recordData returns the stored values of a record, or ok=false if it does not exist.
func (h *historyWriter) recordData(id string) (map[string]json.RawMessage, bool, error) {
	var raw string
	err := h.tx.QueryRow(`SELECT data FROM bt_records WHERE id = ? AND table_node_id = ?`, id, h.tableID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	} else if err != nil {
		return nil, false, err
	}
	data := map[string]json.RawMessage{}
	json.Unmarshal([]byte(raw), &data)
	return data, true, nil
}

// normValue maps "no value" (missing, null) to nil.
func normValue(v json.RawMessage) json.RawMessage {
	if len(v) == 0 || string(v) == "null" {
		return nil
	}
	return v
}

func sameJSON(a, b json.RawMessage) bool {
	a, b = normValue(a), normValue(b)
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return string(a) == string(b)
	}
	return reflect.DeepEqual(x, y)
}

// diff builds the changes between old values and new ones (only keys present in next),
// ordered like the table's fields. Unknown fields are skipped.
func (h *historyWriter) diff(old, next map[string]json.RawMessage) ([]historyChange, error) {
	type item struct {
		c     historyChange
		order int
	}
	var items []item
	for k, v := range next {
		if sameJSON(old[k], v) {
			continue
		}
		m, ok, err := h.field(k)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		items = append(items, item{historyChange{Field: k, Name: m.name, Type: m.typ, Old: normValue(old[k]), New: normValue(v)}, m.order})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].order < items[j].order })
	out := make([]historyChange, len(items))
	for i, it := range items {
		out[i] = it.c
	}
	return out, nil
}

func (h *historyWriter) insert(recordID, action string, changes []historyChange) error {
	if changes == nil {
		changes = []historyChange{}
	}
	raw, _ := json.Marshal(changes)
	_, err := h.tx.Exec(`INSERT INTO bt_record_history(table_node_id, record_id, action, changes, created_at, updated_at) VALUES(?,?,?,?,?,?)`,
		h.tableID, recordID, action, string(raw), h.t, h.t)
	return err
}

// updateChanges returns what a merge patch would change in a record; ok=false if the
// record does not exist.
func (h *historyWriter) updateChanges(recordID string, patch json.RawMessage) ([]historyChange, bool, error) {
	old, ok, err := h.recordData(recordID)
	if err != nil || !ok {
		return nil, ok, err
	}
	next := map[string]json.RawMessage{}
	if err := json.Unmarshal(patch, &next); err != nil {
		return nil, true, opError{"记录格式错误"}
	}
	changes, err := h.diff(old, next)
	return changes, true, err
}

func (h *historyWriter) logUpdate(recordID string, changes []historyChange) error {
	if len(changes) == 0 {
		return nil
	}
	// merge into the previous entry when it touched the same fields moments ago
	var (
		lastID     int64
		lastAction string
		lastRaw    string
		lastAt     int64
	)
	err := h.tx.QueryRow(`SELECT id, action, changes, updated_at FROM bt_record_history WHERE record_id = ? AND table_node_id = ? ORDER BY id DESC LIMIT 1`,
		recordID, h.tableID).Scan(&lastID, &lastAction, &lastRaw, &lastAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil && lastAction == "update" && h.t-lastAt <= historyMergeWindow {
		var prev []historyChange
		json.Unmarshal([]byte(lastRaw), &prev)
		if sameFields(prev, changes) {
			oldOf := map[string]json.RawMessage{}
			for _, c := range prev {
				oldOf[c.Field] = c.Old
			}
			merged := changes[:0]
			for _, c := range changes {
				c.Old = oldOf[c.Field]
				if !sameJSON(c.Old, c.New) {
					merged = append(merged, c)
				}
			}
			if len(merged) == 0 {
				// the edits cancel out (e.g. undo): forget them
				_, err = h.tx.Exec(`DELETE FROM bt_record_history WHERE id = ?`, lastID)
				return err
			}
			raw, _ := json.Marshal(merged)
			_, err = h.tx.Exec(`UPDATE bt_record_history SET changes = ?, updated_at = ? WHERE id = ?`, string(raw), h.t, lastID)
			return err
		}
	}
	return h.insert(recordID, "update", changes)
}

func sameFields(a, b []historyChange) bool {
	if len(a) != len(b) {
		return false
	}
	set := map[string]bool{}
	for _, c := range a {
		set[c.Field] = true
	}
	for _, c := range b {
		if !set[c.Field] {
			return false
		}
	}
	return true
}

// logCreate records a new record with its initial values; re-creating a record that has
// history (undoing a delete) is logged as a restore.
func (h *historyWriter) logCreate(recordID string, data string) error {
	var one int
	err := h.tx.QueryRow(`SELECT 1 FROM bt_record_history WHERE record_id = ? AND table_node_id = ? LIMIT 1`, recordID, h.tableID).Scan(&one)
	if err == nil {
		return h.insert(recordID, "restore", nil)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	next := map[string]json.RawMessage{}
	json.Unmarshal([]byte(data), &next)
	changes, err := h.diff(nil, next)
	if err != nil {
		return err
	}
	return h.insert(recordID, "create", changes)
}

func (h *historyWriter) logDelete(recordID string) error {
	return h.insert(recordID, "delete", nil)
}

// recordHistory lists a record's change log, newest first, a page at a time.
func (s *Server) recordHistory(w http.ResponseWriter, r *http.Request) {
	tableID, recordID := r.PathValue("id"), r.PathValue("rid")
	q := `SELECT id, action, changes, created_at, updated_at FROM bt_record_history WHERE table_node_id = ? AND record_id = ?`
	args := []any{tableID, recordID}
	if before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64); before > 0 {
		q += ` AND id < ?`
		args = append(args, before)
	}
	q += ` ORDER BY id DESC LIMIT ?`
	args = append(args, historyPageSize+1)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	out := []historyEntry{}
	for rows.Next() {
		var e historyEntry
		var raw string
		if err := rows.Scan(&e.ID, &e.Action, &raw, &e.CreatedAt, &e.UpdatedAt); err != nil {
			httpError(w, 500, err.Error())
			return
		}
		e.Changes = []historyChange{}
		json.Unmarshal([]byte(raw), &e.Changes)
		out = append(out, e)
	}
	more := len(out) > historyPageSize
	if more {
		out = out[:historyPageSize]
	}
	writeJSON(w, 200, map[string]any{"entries": out, "more": more})
}

// purgeDeletedRecordHistory drops the log of records deleted before cutoff (ms).
func purgeDeletedRecordHistory(tx *sql.Tx, cutoff int64) error {
	_, err := tx.Exec(`DELETE FROM bt_record_history
WHERE record_id NOT IN (SELECT id FROM bt_records)
  AND record_id IN (SELECT record_id FROM bt_record_history GROUP BY record_id HAVING MAX(updated_at) < ?)`, cutoff)
	return err
}
