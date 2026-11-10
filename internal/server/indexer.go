package server

import (
	"database/sql"
	"log"
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
)

// indexDoc updates the search index for a saved document, now or later depending on size.
func indexDoc(tx *sql.Tx, id, title, md string, t int64) error {
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
		rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
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
	var title, md string
	err = tx.QueryRow(`SELECT n.title, d.markdown FROM nodes n JOIN doc_contents d ON d.node_id = n.id WHERE n.id = ?`, id).Scan(&title, &md)
	if err == sql.ErrNoRows {
		return tx.Commit() // purged meanwhile
	} else if err != nil {
		return err
	}
	if err := reindexDoc(tx, id, title, md); err != nil {
		return err
	}
	return tx.Commit()
}
