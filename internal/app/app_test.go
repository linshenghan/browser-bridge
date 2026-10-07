package app

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"browser-bridge/internal/wire"
	"testing"
	"time"
)

func testBroker(t *testing.T) (*Broker, *Session) {
	t.Helper()
	db, e := openStore(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	b := &Broker{db: db, peers: map[string]*peer{}, jobs: map[string]context.CancelFunc{}}
	s := &Session{ID: ID(), Owner: "client-a", Profile: "profile-a", Origins: []string{"https://example.com"}, Output: t.TempDir(), ResumeToken: ID()}
	if e = b.saveSession(s); e != nil {
		t.Fatal(e)
	}
	return b, s
}
func fakeNative(t *testing.T, b *Broker, s *Session, fn func(wire.Message) wire.Message) *atomic.Int32 {
	t.Helper()
	a, z := net.Pipe()
	p := &peer{w: &wire.Writer{W: a}, conn: a, done: make(chan struct{}), pending: map[string]chan wire.Message{}}
	b.peers[s.Profile] = p
	count := &atomic.Int32{}
	t.Cleanup(func() { a.Close(); z.Close() })
	go func() {
		r := &wire.Reader{R: z}
		for {
			m, e := r.Read()
			if e != nil {
				return
			}
			count.Add(1)
			resp := fn(m)
			p.mu.Lock()
			ch := p.pending[m.ID]
			p.mu.Unlock()
			if ch != nil {
				ch <- resp
			}
		}
	}()
	return count
}
func TestMutationExecutedOnce(t *testing.T) {
	b, s := testBroker(t)
	count := fakeNative(t, b, s, func(m wire.Message) wire.Message {
		return wire.Message{Result: wire.Raw(map[string]bool{"saved": true})}
	})
	in := Input{SessionID: s.ID, TabID: 1, RequestID: "save-1", Action: "submit", Version: "v1"}
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if _, e := b.once(ctx, s, "page.act", in); e != nil {
			t.Fatal(e)
		}
	}
	if count.Load() != 1 {
		t.Fatalf("executed %d times", count.Load())
	}
	in.Text = "changed"
	if _, e := b.once(ctx, s, "page.act", in); rpcError(e).Code != "DUPLICATE_ID_CONFLICT" {
		t.Fatal(e)
	}
}
func TestUncertainMutationNotReplayed(t *testing.T) {
	b, s := testBroker(t)
	count := fakeNative(t, b, s, func(m wire.Message) wire.Message {
		time.Sleep(80 * time.Millisecond)
		return wire.Message{Result: wire.Raw(map[string]bool{"saved": true})}
	})
	in := Input{RequestID: "uncertain", Action: "submit"}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, e := b.once(ctx, s, "page.act", in)
	if e == nil || !rpcError(e).Uncertain {
		t.Fatal(e)
	}
	_, e = b.once(context.Background(), s, "page.act", in)
	if e == nil || !rpcError(e).Uncertain {
		t.Fatal(e)
	}
	if count.Load() != 1 {
		t.Fatal("mutation replayed")
	}
}
func TestPendingSurvivesRestart(t *testing.T) {
	b, s := testBroker(t)
	in := Input{RequestID: "pending"}
	key := s.ID + ":" + in.RequestID
	fingerprint := fmt.Sprintf("%x", sha256.Sum256(append([]byte("file.upload"), wire.Raw(in)...)))
	_, _ = b.db.Exec("INSERT INTO operations VALUES(?,?,'pending',NULL)", key, fingerprint)
	var n int
	_ = b.db.QueryRow("SELECT count(*) FROM operations WHERE state='pending'").Scan(&n)
	if n != 1 {
		t.Fatal("pending ledger lost")
	}
	if _, e := b.once(context.Background(), s, "file.upload", in); e == nil || rpcError(e).Code != "OUTCOME_UNKNOWN" {
		t.Fatal("replayed unknown upload")
	}
}
func TestSessionAndFileBoundaries(t *testing.T) {
	b, s := testBroker(t)
	if _, e := b.getSession(s.ID, "client-b", false); e == nil {
		t.Fatal("cross-session accepted")
	}
	file := filepath.Join(t.TempDir(), "allowed.txt")
	_ = os.WriteFile(file, []byte("test"), 0600)
	if _, e := safeFile(file, []string{file}); e != nil {
		t.Fatal(e)
	}
	if _, e := safeFile(file, nil); e == nil {
		t.Fatal("unauthorized file accepted")
	}
	if _, e := safeFile("../allowed.txt", []string{file}); e == nil {
		t.Fatal("relative file accepted")
	}
	if e := s.checkURL("https://new-site.example/"); e != nil {
		t.Fatal("ordinary site should not require an allowlist", e)
	}
	if _, e := normalizeURL("https://username:password@example.com/"); e == nil {
		t.Fatal("URL credentials accepted")
	}
}
func TestAllSitesAccessWithLegacySessions(t *testing.T) {
	// There is no built-in host blocklist: only scheme and credential rules apply.
	for _, u := range []string{"https://a.example/x", "https://b.cdn.example/", "http://example.com:8080/p"} {
		if _, e := normalizeURL(u); e != nil {
			t.Fatalf("ordinary host rejected: %s: %v", u, e)
		}
	}
	for _, origins := range [][]string{nil, {"https://old-site.example"}} {
		s := &Session{Origins: origins}
		for _, u := range []string{"https://new-site.example/", "http://localhost:9090/", "https://other.example:8443/path"} {
			if e := s.checkURL(u); e != nil {
				t.Fatalf("normal URL rejected: %s: %v", u, e)
			}
		}
		for _, u := range []string{"chrome://settings/", "file:///private.txt", "javascript:alert(1)"} {
			if e := s.checkURL(u); e == nil {
				t.Fatalf("protected URL accepted: %s", u)
			}
		}
		if e := applyAuthorization(s, Input{Origins: []string{"*"}}); e != nil || len(s.Origins) != 0 {
			t.Fatalf("legacy origin field must not reintroduce a website allowlist: %v", e)
		}
	}
}
func TestStopRejectsQueuedActions(t *testing.T) {
	b, s := testBroker(t)
	b.stopSession(s.ID, s.Profile)
	m := request("page.act", Input{SessionID: s.ID, RequestID: "stopped", Action: "submit"})
	m.Client = s.Owner
	_, e := b.dispatch(context.Background(), m)
	if e == nil || rpcError(e).Code != "SESSION_STOPPED" {
		t.Fatal(e)
	}
}
func TestSQLiteReadRecovery(t *testing.T) {
	dir := t.TempDir()
	db, e := openStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	_, e = db.Exec("INSERT INTO jobs VALUES('j','s','running','{}','now');INSERT INTO items(job,n,url,state,attempts) VALUES('j',0,'https://example.com','running',1);INSERT INTO operations VALUES('op','hash','pending',NULL)")
	if e != nil {
		t.Fatal(e)
	}
	db.Close()
	db, e = openStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	var state string
	_ = db.QueryRow("SELECT state FROM items").Scan(&state)
	if state != "queued" {
		t.Fatal(state)
	}
	_ = db.QueryRow("SELECT state FROM operations").Scan(&state)
	if state != "pending" {
		t.Fatal("mutation was recovered")
	}
}
func TestURLDedupAndCSV(t *testing.T) {
	a, e := normalizeURL("https://Example.com/a?x=1&y=2#part")
	if e != nil || a != "https://example.com/a?x=1&y=2" {
		t.Fatal(a, e)
	}
	b, _ := normalizeURL("https://example.com/a?y=2&x=1")
	if a == b {
		t.Fatal("query meaning was altered")
	}
	for _, v := range []string{"=1+1", " @cmd", "\t+1", "-2"} {
		if !strings.HasPrefix(csvSafe(v), "'") {
			t.Fatal("CSV formula unescaped")
		}
	}
}
func TestExportContainsTablesAndFailures(t *testing.T) {
	b, s := testBroker(t)
	_, e := b.db.Exec("INSERT INTO jobs VALUES('job',?,'completed','{}','now')", s.ID)
	if e != nil {
		t.Fatal(e)
	}
	page := map[string]any{"title": "标题", "url": "https://example.com/", "body": "正文", "tables": [][][]string{{{"名称", "数量"}, {"测试", "1"}}}, "links": []map[string]string{{"text": "链接", "url": "https://example.com/"}}}
	_, e = b.db.Exec("INSERT INTO items(job,n,url,state,result) VALUES('job',0,'https://example.com','done',?)", string(wire.Raw(page)))
	if e != nil {
		t.Fatal(e)
	}
	for _, format := range []string{"jsonl", "csv", "markdown"} {
		raw, e := b.exportJob(s, "job", format)
		if e != nil {
			t.Fatal(e)
		}
		var result struct {
			Files []string `json:"files"`
		}
		_ = json.Unmarshal(raw, &result)
		if len(result.Files) != 1 {
			t.Fatal("missing export")
		}
		data, _ := os.ReadFile(result.Files[0])
		if !strings.Contains(string(data), "数量") {
			t.Fatal("tables lost")
		}
	}
}
