package server

import (
	"database/sql"
	"fmt"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// migrations are applied in order; never edit an existing entry, only append.
var migrations = []string{
	`
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE repos (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT '',
  sort        REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE TABLE nodes (
  id         TEXT PRIMARY KEY,
  repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  parent_id  TEXT,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  sort       REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  trash_root INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX nodes_repo_parent ON nodes(repo_id, parent_id);
CREATE INDEX nodes_updated ON nodes(updated_at);
CREATE TABLE doc_contents (
  node_id    TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  markdown   TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE doc_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  markdown   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX doc_versions_node ON doc_versions(node_id, created_at);
CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  sha256     TEXT NOT NULL,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX attachments_sha ON attachments(sha256);
CREATE VIRTUAL TABLE docs_fts USING fts5(node_id UNINDEXED, title, body, tokenize = 'trigram');
`,
}

func openDB(dataDir string) (*sql.DB, error) {
	path := filepath.Join(dataDir, "qingjian.db")
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func migrate(db *sql.DB) error {
	var version int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	for i := version; i < len(migrations); i++ {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) getSetting(key string) (string, bool) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	if err != nil {
		return "", false
	}
	return v, true
}

func (s *Server) setSetting(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}
