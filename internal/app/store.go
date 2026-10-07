package app

import (
	"database/sql"
	"encoding/json"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
)

func openStore(dir string) (*sql.DB, error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	p := filepath.Join(dir, "tasks.sqlite")
	db, e := sql.Open("sqlite", p)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	_, e = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, session TEXT NOT NULL, state TEXT NOT NULL, options TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items(job TEXT NOT NULL, n INTEGER NOT NULL, url TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', result TEXT, PRIMARY KEY(job,n));
UPDATE items SET state='queued',attempts=MAX(attempts-1,0) WHERE state='running';
UPDATE jobs SET state='queued' WHERE state='running';`)
	if e != nil {
		db.Close()
		return nil, e
	}
	_ = os.Chmod(p, 0600)
	return db, nil
}
func (b *Broker) saveSession(s *Session) error {
	data, e := json.Marshal(s)
	if e != nil {
		return e
	}
	_, e = b.db.Exec("INSERT OR REPLACE INTO sessions(id,owner,data) VALUES(?,?,?)", s.ID, s.Owner, string(data))
	return e
}
func (b *Broker) getSession(id, owner string, allowStopped bool) (*Session, error) {
	var data, storedOwner string
	if e := b.db.QueryRow("SELECT owner,data FROM sessions WHERE id=?", id).Scan(&storedOwner, &data); e != nil {
		return nil, fail("SESSION_NOT_FOUND", "任务不存在，请先开始任务")
	}
	if storedOwner != owner {
		return nil, fail("SESSION_ISOLATION", "不能操作其他 Codex 任务的会话")
	}
	var s Session
	if e := json.Unmarshal([]byte(data), &s); e != nil {
		return nil, e
	}
	s.Owner = storedOwner
	if s.Stopped && !allowStopped {
		return nil, fail("SESSION_STOPPED", "任务已停止。请用户明确要求后创建新任务。")
	}
	return &s, nil
}
