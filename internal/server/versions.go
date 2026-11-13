package server

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"log"
	"unicode/utf8"
)

// Document history is stored like git packs: most versions hold only a delta (see
// delta.go) against the version before them, every versionKeyframeEvery-th one is a full
// copy, so rebuilding a version never replays more than that many deltas. The oldest
// version kept is always a full copy: pruning materialises it before dropping its base.

const (
	versionKeyframeEvery = 50
	// a delta larger than this share of the full text is not worth it
	versionDeltaMaxRatio = 0.5
)

func contentHash(md string) string {
	h := sha256.Sum256([]byte(md))
	return hex.EncodeToString(h[:16])
}

// versionText rebuilds the full markdown of version id.
func versionText(q querier, id int64) (string, error) {
	var nodeID string
	if err := q.QueryRow(`SELECT node_id FROM doc_versions WHERE id = ?`, id).Scan(&nodeID); err != nil {
		return "", err
	}
	var key int64
	if err := q.QueryRow(`SELECT COALESCE(MAX(id), 0) FROM doc_versions WHERE node_id = ? AND id <= ? AND delta = 0`, nodeID, id).Scan(&key); err != nil {
		return "", err
	}
	if key == 0 {
		return "", errBadDelta
	}
	rows, err := q.Query(`SELECT delta, markdown FROM doc_versions WHERE node_id = ? AND id >= ? AND id <= ? ORDER BY id`, nodeID, key, id)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var text string
	for first := true; rows.Next(); first = false {
		var delta bool
		var data string
		if err := rows.Scan(&delta, &data); err != nil {
			return "", err
		}
		if first || !delta {
			text = data
			continue
		}
		if text, err = applyDelta(text, data); err != nil {
			return "", err
		}
	}
	return text, rows.Err()
}

// latestVersion returns id, time and content hash of a document's newest version
// (sql.ErrNoRows when it has none). The hash is empty for versions stored before hashes.
func latestVersion(q querier, nodeID string) (id, at int64, hash string, err error) {
	err = q.QueryRow(`SELECT id, created_at, hash FROM doc_versions WHERE node_id = ? ORDER BY id DESC LIMIT 1`, nodeID).Scan(&id, &at, &hash)
	return
}

// sameAsLatest reports whether md equals the newest stored version of the document.
func sameAsLatest(tx *sql.Tx, nodeID, md string) (bool, error) {
	id, _, hash, err := latestVersion(tx, nodeID)
	if errors.Is(err, sql.ErrNoRows) {
		return md == "", nil
	} else if err != nil {
		return false, err
	}
	if hash != "" {
		return hash == contentHash(md), nil
	}
	prev, err := versionText(tx, id)
	return err == nil && prev == md, err
}

// addVersion stores a new version of a document, as a delta against the previous one
// where that pays off, and drops the oldest versions beyond maxVersions.
func addVersion(tx *sql.Tx, nodeID, title, md string, t int64) error {
	data, delta := md, false
	prevID, _, _, err := latestVersion(tx, nodeID)
	if err == nil {
		var chain int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM doc_versions WHERE node_id = ? AND id > (SELECT COALESCE(MAX(id), 0) FROM doc_versions WHERE node_id = ? AND delta = 0)`, nodeID, nodeID).Scan(&chain); err != nil {
			return err
		}
		if chain < versionKeyframeEvery-1 {
			if prev, err := versionText(tx, prevID); err == nil {
				if d := makeDelta(prev, md); float64(len(d)) < float64(len(md))*versionDeltaMaxRatio {
					data, delta = d, true
				}
			}
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO doc_versions(node_id, title, markdown, created_at, delta, size, hash) VALUES(?,?,?,?,?,?,?)`,
		nodeID, title, data, t, delta, utf8.RuneCountInString(md), contentHash(md)); err != nil {
		return err
	}
	return pruneVersions(tx, nodeID)
}

func pruneVersions(tx *sql.Tx, nodeID string) error {
	var cut int64
	var delta bool
	err := tx.QueryRow(`SELECT id, delta FROM doc_versions WHERE node_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?`, nodeID, maxVersions-1).Scan(&cut, &delta)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	var older int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM doc_versions WHERE node_id = ? AND id < ?`, nodeID, cut).Scan(&older); err != nil {
		return err
	}
	if older == 0 {
		return nil
	}
	if delta {
		text, err := versionText(tx, cut)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE doc_versions SET markdown = ?, delta = 0 WHERE id = ?`, text, cut); err != nil {
			return err
		}
	}
	_, err = tx.Exec(`DELETE FROM doc_versions WHERE node_id = ? AND id < ?`, nodeID, cut)
	return err
}

// compactVersions converts history stored before deltas existed (every version a full
// copy) into the delta layout. It runs once in the background, a few rows per transaction.
func (s *Server) compactVersions() {
	if v, _ := s.getSetting("versions_compacted"); v == "1" {
		return
	}
	rows, err := s.db.Query(`SELECT DISTINCT node_id FROM doc_versions`)
	if err != nil {
		log.Printf("compact versions: %v", err)
		return
	}
	var nodes []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			log.Printf("compact versions: %v", err)
			return
		}
		nodes = append(nodes, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		log.Printf("compact versions: %v", err)
		return
	}
	var saved int64
	for _, n := range nodes {
		select {
		case <-s.stop:
			return
		default:
		}
		x, err := s.compactNodeVersions(n)
		if err != nil {
			log.Printf("compact versions of %s: %v", n, err)
			return
		}
		saved += x
	}
	if err := s.setSetting("versions_compacted", "1"); err != nil {
		log.Printf("compact versions: %v", err)
	}
	if saved > 0 {
		log.Printf("history: stored %d MB less by keeping versions as deltas", saved>>20)
	}
}

func (s *Server) compactNodeVersions(nodeID string) (saved int64, err error) {
	rows, err := s.db.Query(`SELECT id FROM doc_versions WHERE node_id = ? ORDER BY id`, nodeID)
	if err != nil {
		return 0, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	var prevText string
	prevID := int64(0)
	chain := 0
	for start := 0; start < len(ids); start += 10 {
		tx, err := s.db.Begin()
		if err != nil {
			return saved, err
		}
		for _, id := range ids[start:min(start+10, len(ids))] {
			var delta bool
			var data string
			if err := tx.QueryRow(`SELECT delta, markdown FROM doc_versions WHERE id = ?`, id).Scan(&delta, &data); errors.Is(err, sql.ErrNoRows) {
				prevID = 0 // pruned meanwhile
				continue
			} else if err != nil {
				tx.Rollback()
				return saved, err
			}
			text := data
			if delta {
				if prevID == 0 {
					if text, err = versionText(tx, id); err != nil {
						tx.Rollback()
						return saved, err
					}
				} else if text, err = applyDelta(prevText, data); err != nil {
					tx.Rollback()
					return saved, err
				}
				chain++
			} else if prevID != 0 && chain < versionKeyframeEvery-1 {
				if d := makeDelta(prevText, text); float64(len(d)) < float64(len(text))*versionDeltaMaxRatio {
					// only while the base is still there (the history may be pruned concurrently)
					res, err := tx.Exec(`UPDATE doc_versions SET markdown = ?, delta = 1 WHERE id = ? AND EXISTS (SELECT 1 FROM doc_versions WHERE id = ?)`, d, id, prevID)
					if err != nil {
						tx.Rollback()
						return saved, err
					}
					if n, _ := res.RowsAffected(); n > 0 {
						saved += int64(len(text) - len(d))
						chain++
					} else {
						chain = 0
					}
				} else {
					chain = 0
				}
			} else {
				chain = 0
			}
			if _, err := tx.Exec(`UPDATE doc_versions SET hash = ?, size = ? WHERE id = ? AND hash = ''`, contentHash(text), utf8.RuneCountInString(text), id); err != nil {
				tx.Rollback()
				return saved, err
			}
			prevID, prevText = id, text
		}
		if err := tx.Commit(); err != nil {
			return saved, err
		}
	}
	return saved, nil
}
