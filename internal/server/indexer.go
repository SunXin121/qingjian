package server

import (
	"database/sql"
	"encoding/json"
	"log"
	"strconv"
	"strings"
	"time"
)

// Full-text indexing of long documents is deferred. Rebuilding the trigram index of a
// document costs about 2 s per million characters while holding the write lock, far too
// much for an autosave every few seconds. Short documents are indexed inside the save;
// long ones are queued in fts_pending (so a restart does not lose the work) and indexed
// once they have not been saved for ftsQuietPeriod.

const (
	ftsInlineBytes = 64 << 10
	ftsQuietPeriod = 10 * time.Second
	// tables are indexed this long after their last edit
	tableIndexDelay = 3 * time.Second
)

// indexDoc records the links of a saved document and updates its search index, now or
// later depending on size.
func indexDoc(tx *sql.Tx, id, title, md string, t int64) error {
	if err := updateLinks(tx, id, md); err != nil {
		return err
	}
	if len(md) <= ftsInlineBytes {
		if _, err := tx.Exec(`DELETE FROM fts_pending WHERE node_id = ?`, id); err != nil {
			return err
		}
		return reindexDoc(tx, id, title, md)
	}
	_, err := tx.Exec(`INSERT INTO fts_pending(node_id, due_at) VALUES(?, ?) ON CONFLICT(node_id) DO UPDATE SET due_at = excluded.due_at`,
		id, t+ftsQuietPeriod.Milliseconds())
	return err
}

func reindexDoc(tx *sql.Tx, id, title, md string) error {
	if _, err := tx.Exec(`DELETE FROM docs_fts WHERE node_id = ?`, id); err != nil {
		return err
	}
	_, err := tx.Exec(`INSERT INTO docs_fts(node_id, title, body) VALUES(?,?,?)`, id, title, searchableText(md))
	return err
}

func (s *Server) indexLoop() {
	defer close(s.indexDone)
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		s.indexPending(now())
		select {
		case <-s.stop:
			return
		case <-t.C:
		}
	}
}

// indexPending indexes the queued documents whose quiet period ended before `at`.
func (s *Server) indexPending(at int64) {
	rows, err := s.db.Query(`SELECT node_id FROM fts_pending WHERE due_at <= ? ORDER BY due_at LIMIT 20`, at)
	if err != nil {
		log.Printf("search index: %v", err)
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			log.Printf("search index: %v", err)
			return
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		log.Printf("search index: %v", err)
		return
	}
	for _, id := range ids {
		if err := s.indexOne(id, at); err != nil {
			log.Printf("search index %s: %v", id, err)
		}
	}
}

func (s *Server) indexOne(id string, at int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// saved again since it was picked: leave it for later
	res, err := tx.Exec(`DELETE FROM fts_pending WHERE node_id = ? AND due_at <= ?`, id, at)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil
	}
	var typ, title string
	err = tx.QueryRow(`SELECT type, title FROM nodes WHERE id = ?`, id).Scan(&typ, &title)
	if err == sql.ErrNoRows {
		return tx.Commit() // purged meanwhile
	} else if err != nil {
		return err
	}
	if typ == "table" {
		body, err := tableSearchText(tx, id)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM docs_fts WHERE node_id = ?`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO docs_fts(node_id, title, body) VALUES(?,?,?)`, id, title, body); err != nil {
			return err
		}
		return tx.Commit()
	}
	var md string
	err = tx.QueryRow(`SELECT markdown FROM doc_contents WHERE node_id = ?`, id).Scan(&md)
	if err == sql.ErrNoRows {
		return tx.Commit()
	} else if err != nil {
		return err
	}
	if err := reindexDoc(tx, id, title, md); err != nil {
		return err
	}
	return tx.Commit()
}

// queueTableIndex schedules a table's records for full-text indexing. Tables are edited
// in bursts of small ops, so the index is always rebuilt later, off the request.
func queueTableIndex(tx *sql.Tx, id string, t int64) error {
	_, err := tx.Exec(`INSERT INTO fts_pending(node_id, due_at) VALUES(?, ?) ON CONFLICT(node_id) DO UPDATE SET due_at = excluded.due_at`,
		id, t+tableIndexDelay.Milliseconds())
	return err
}

// tableSearchText is what search sees of a table: one line per record with the values of
// its text-like fields and the names of the chosen options.
func tableSearchText(tx *sql.Tx, id string) (string, error) {
	rows, err := tx.Query(`SELECT id, type, options FROM bt_fields WHERE table_node_id = ? ORDER BY sort, rowid`, id)
	if err != nil {
		return "", err
	}
	type field struct {
		id      string
		choices map[string]string // select / multiselect: choice id → name
	}
	var fields []field
	for rows.Next() {
		var fid, typ, opts string
		if err := rows.Scan(&fid, &typ, &opts); err != nil {
			rows.Close()
			return "", err
		}
		switch typ {
		case "text", "longtext", "url", "phone", "email", "number":
			fields = append(fields, field{id: fid})
		case "select", "multiselect":
			var o struct {
				Choices []struct{ ID, Name string } `json:"choices"`
			}
			json.Unmarshal([]byte(opts), &o)
			f := field{id: fid, choices: map[string]string{}}
			for _, c := range o.Choices {
				f.choices[c.ID] = c.Name
			}
			fields = append(fields, f)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", err
	}
	rows, err = tx.Query(`SELECT data FROM bt_records WHERE table_node_id = ? ORDER BY sort, seq`, id)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return "", err
		}
		var data map[string]any
		if json.Unmarshal([]byte(raw), &data) != nil {
			continue
		}
		wrote := false
		put := func(s string) {
			if s = strings.TrimSpace(s); s == "" {
				return
			}
			if wrote {
				b.WriteString(" · ")
			}
			b.WriteString(s)
			wrote = true
		}
		for _, f := range fields {
			switch v := data[f.id].(type) {
			case string:
				if f.choices != nil {
					put(f.choices[v])
				} else {
					put(v)
				}
			case float64:
				put(strconv.FormatFloat(v, 'f', -1, 64))
			case []any:
				for _, x := range v {
					if cid, ok := x.(string); ok && f.choices != nil {
						put(f.choices[cid])
					}
				}
			}
		}
		if wrote {
			b.WriteByte('\n')
		}
	}
	return b.String(), rows.Err()
}

// backfillTableIndex queues every existing table once, for databases created before
// table records were searchable.
func (s *Server) backfillTableIndex() error {
	if _, done := s.getSetting("tables_indexed"); done {
		return nil
	}
	if _, err := s.db.Exec(`INSERT INTO fts_pending(node_id, due_at) SELECT id, 0 FROM nodes WHERE type = 'table' ON CONFLICT(node_id) DO NOTHING`); err != nil {
		return err
	}
	return s.setSetting("tables_indexed", "1")
}
