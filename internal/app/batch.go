package app

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"browser-bridge/internal/wire"
	"time"
)

type item struct {
	N        int             `json:"index"`
	URL      string          `json:"url"`
	State    string          `json:"state"`
	Attempts int             `json:"attempts"`
	Error    string          `json:"error,omitempty"`
	Result   json.RawMessage `json:"result,omitempty"`
}

func (b *Broker) createJob(s *Session, in Input) (json.RawMessage, error) {
	if len(in.URLs) == 0 || len(in.URLs) > 100 {
		return nil, fail("BATCH_LIMIT", "每批接受 1 至 100 个链接")
	}
	if in.Concurrency == 0 {
		in.Concurrency = 3
	}
	if in.Concurrency < 1 || in.Concurrency > 3 {
		return nil, fail("CONCURRENCY_LIMIT", "并发数必须在 1 至 3 之间")
	}
	if in.TimeoutSeconds == 0 {
		in.TimeoutSeconds = 45
	}
	if in.TimeoutSeconds < 1 || in.TimeoutSeconds > 90 {
		return nil, fail("TIMEOUT_LIMIT", "单页超时应为 1 至 90 秒")
	}
	urls := []string{}
	seen := map[string]bool{}
	for _, u := range in.URLs {
		n, e := normalizeURL(u)
		if e != nil {
			return nil, e
		}
		if e = s.checkURL(n); e != nil {
			return nil, e
		}
		if !seen[n] {
			seen[n] = true
			urls = append(urls, n)
		}
	}
	duplicateCount := len(in.URLs) - len(urls)
	id := ID()
	in.URLs = nil
	tx, e := b.db.Begin()
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	_, e = tx.Exec("INSERT INTO jobs VALUES(?,?,'queued',?,?)", id, s.ID, string(wire.Raw(in)), time.Now().UTC().Format(time.RFC3339))
	if e != nil {
		return nil, e
	}
	for i, u := range urls {
		if _, e = tx.Exec("INSERT INTO items(job,n,url,state) VALUES(?,?,?,'queued')", id, i, u); e != nil {
			return nil, e
		}
	}
	if e = tx.Commit(); e != nil {
		return nil, e
	}
	go b.runJob(s, id, in)
	return wire.Raw(map[string]any{"jobId": id, "total": len(urls), "duplicatesRemoved": duplicateCount}), nil
}
func (b *Broker) jobSession(s *Session, id string) error {
	var sid string
	if e := b.db.QueryRow("SELECT session FROM jobs WHERE id=?", id).Scan(&sid); e != nil {
		return fail("JOB_NOT_FOUND", "批量任务不存在")
	}
	if sid != s.ID {
		return fail("SESSION_ISOLATION", "不能读取其他任务的采集结果")
	}
	return nil
}
func (b *Broker) jobStatus(s *Session, id string) (json.RawMessage, error) {
	if e := b.jobSession(s, id); e != nil {
		return nil, e
	}
	var state, created string
	_ = b.db.QueryRow("SELECT state,created FROM jobs WHERE id=?", id).Scan(&state, &created)
	items, e := b.items(id, false)
	if e != nil {
		return nil, e
	}
	counts := map[string]int{}
	for _, i := range items {
		counts[i.State]++
	}
	return wire.Raw(map[string]any{"jobId": id, "state": state, "createdAt": created, "total": len(items), "counts": counts, "items": items}), nil
}
func (b *Broker) items(id string, withResult bool) ([]item, error) {
	rows, e := b.db.Query("SELECT n,url,state,attempts,error,COALESCE(result,'null') FROM items WHERE job=? ORDER BY n", id)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []item{}
	for rows.Next() {
		var i item
		var raw string
		if e = rows.Scan(&i.N, &i.URL, &i.State, &i.Attempts, &i.Error, &raw); e != nil {
			return nil, e
		}
		if withResult {
			i.Result = json.RawMessage(raw)
		}
		out = append(out, i)
	}
	return out, rows.Err()
}
func (b *Broker) cancelJob(s *Session, id string) (json.RawMessage, error) {
	if e := b.jobSession(s, id); e != nil {
		return nil, e
	}
	_, e := b.db.Exec("UPDATE jobs SET state='cancelled' WHERE id=? AND state IN ('queued','running')", id)
	if e != nil {
		return nil, e
	}
	b.mu.Lock()
	cancel := b.jobs[id]
	p := b.peers[s.Profile]
	b.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	_, _ = b.db.Exec("UPDATE items SET state='cancelled' WHERE job=? AND state IN ('queued','running')", id)
	if p != nil {
		_ = p.w.Write(wire.Message{Kind: "event", Method: "batch.cancelled", Session: s.ID, Params: wire.Raw(map[string]string{"jobId": id})})
	}
	return b.jobStatus(s, id)
}
func (b *Broker) retryJob(s *Session, id string) (json.RawMessage, error) {
	if e := b.jobSession(s, id); e != nil {
		return nil, e
	}
	var state, opts string
	_ = b.db.QueryRow("SELECT state,options FROM jobs WHERE id=?", id).Scan(&state, &opts)
	if state == "running" || state == "queued" {
		return nil, fail("JOB_RUNNING", "请等待当前批次完成后再重试失败项")
	}
	_, e := b.db.Exec("UPDATE items SET state='queued',attempts=0,error='' WHERE job=? AND state='failed'", id)
	if e != nil {
		return nil, e
	}
	_, _ = b.db.Exec("UPDATE jobs SET state='queued' WHERE id=?", id)
	var in Input
	_ = json.Unmarshal([]byte(opts), &in)
	go b.runJob(s, id, in)
	return b.jobStatus(s, id)
}
func (b *Broker) resumeJobs(profile string) {
	rows, e := b.db.Query("SELECT j.id,j.options,s.data,s.owner FROM jobs j JOIN sessions s ON s.id=j.session WHERE j.state='queued'")
	if e != nil {
		return
	}
	type rec struct {
		id string
		in Input
		s  Session
	}
	rs := []rec{}
	for rows.Next() {
		var r rec
		var opts, data string
		_ = rows.Scan(&r.id, &opts, &data, &r.s.Owner)
		_ = json.Unmarshal([]byte(opts), &r.in)
		owner := r.s.Owner
		_ = json.Unmarshal([]byte(data), &r.s)
		r.s.Owner = owner
		if r.s.Profile == profile && !r.s.Stopped {
			rs = append(rs, r)
		}
	}
	rows.Close()
	for _, r := range rs {
		r := r
		go b.runJob(&r.s, r.id, r.in)
	}
}
func (b *Broker) runJob(s *Session, id string, in Input) {
	ctx, cancel := context.WithCancel(context.Background())
	b.mu.Lock()
	if b.jobs[id] != nil {
		b.mu.Unlock()
		cancel()
		return
	}
	b.jobs[id] = cancel
	b.mu.Unlock()
	defer func() { cancel(); b.mu.Lock(); delete(b.jobs, id); b.mu.Unlock() }()
	r, e := b.db.Exec("UPDATE jobs SET state='running' WHERE id=? AND state='queued'", id)
	if e != nil {
		return
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return
	}
	// Restored reads reconcile the browser session; no mutation ledger entries are replayed.
	setup, done := context.WithTimeout(ctx, 10*time.Second)
	_, e = b.call(setup, s, "session.start", Input{SessionID: s.ID, Name: s.Name, Origins: s.Origins})
	done()
	if e != nil {
		_, _ = b.db.Exec("UPDATE jobs SET state='queued' WHERE id=? AND state='running'", id)
		return
	}
	b.mu.Lock()
	p := b.peers[s.Profile]
	b.mu.Unlock()
	if p != nil {
		_ = p.w.Write(wire.Message{Kind: "event", Method: "batch.started", Session: s.ID, Params: wire.Raw(map[string]string{"jobId": id})})
	}
	all, e := b.items(id, false)
	if e != nil {
		return
	}
	queue := make(chan item, len(all))
	for _, i := range all {
		if i.State == "queued" {
			queue <- i
		}
	}
	close(queue)
	var wg sync.WaitGroup
	workers := in.Concurrency
	if workers < 1 {
		workers = 3
	}
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range queue {
				if ctx.Err() != nil {
					return
				}
				b.collectItem(ctx, s, id, in, i)
				b.progress(s, id)
			}
		}()
	}
	wg.Wait()
	var pending int
	_ = b.db.QueryRow("SELECT COUNT(*) FROM items WHERE job=? AND state IN ('queued','running')", id).Scan(&pending)
	state := "completed"
	if pending > 0 {
		state = "queued"
	}
	_, _ = b.db.Exec("UPDATE jobs SET state=? WHERE id=? AND state='running'", state, id)
	b.progress(s, id)
}
func (b *Broker) collectItem(ctx context.Context, s *Session, job string, in Input, i item) {
	for attempt := i.Attempts; attempt < 3; attempt++ {
		if ctx.Err() != nil {
			return
		}
		_, e := b.db.Exec("UPDATE items SET state='running',attempts=attempts+1 WHERE job=? AND n=? AND state IN ('queued','running')", job, i.N)
		if e != nil {
			return
		}
		seconds := in.TimeoutSeconds
		if seconds < 1 {
			seconds = 45
		}
		pageCtx, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
		out, e := b.readPage(pageCtx, s, job, i.URL, in.Screenshot)
		cancel()
		if ctx.Err() != nil {
			return
		}
		if e == nil {
			_, _ = b.db.Exec("UPDATE items SET state='done',result=?,error='' WHERE job=? AND n=? AND state='running'", string(out), job, i.N)
			return
		}
		er := rpcError(e)
		if er.Code == "BROWSER_DISCONNECTED" || er.Code == "CONNECTION_LOST" {
			_, _ = b.db.Exec("UPDATE items SET state='queued',attempts=MAX(attempts-1,0),error=? WHERE job=? AND n=? AND state='running'", er.Code+": "+er.Message, job, i.N)
			return
		}
		terminal := attempt == 2 || er.Code == "POLICY_DENIED" || er.Code == "BROWSER_PERMISSION_REQUIRED" || er.Code == "SESSION_STOPPED" || er.Code == "HOST_DENIED"
		state := "running"
		if terminal {
			state = "failed"
		}
		_, _ = b.db.Exec("UPDATE items SET state=?,error=? WHERE job=? AND n=? AND state='running'", state, er.Code+": "+er.Message, job, i.N)
		if terminal {
			return
		}
	}
}
func (b *Broker) readPage(ctx context.Context, s *Session, job, url string, screenshot bool) (json.RawMessage, error) {
	raw, e := b.call(ctx, s, "tab.open", Input{SessionID: s.ID, URL: url, JobID: job})
	if e != nil {
		return nil, e
	}
	var tab struct {
		TabID int `json:"tabId"`
	}
	if e = decode(raw, &tab); e != nil {
		return nil, e
	}
	defer func() {
		clean, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_, _ = b.call(clean, s, "tab.close", Input{SessionID: s.ID, TabID: tab.TabID, JobID: job})
	}()
	raw, e = b.call(ctx, s, "page.observe", Input{SessionID: s.ID, TabID: tab.TabID, JobID: job})
	if e != nil {
		return nil, e
	}
	var page map[string]any
	if e = decode(raw, &page); e != nil {
		return nil, e
	}
	page["collectedAt"] = time.Now().UTC().Format(time.RFC3339)
	page["inputUrl"] = url
	if screenshot {
		pic, e := b.call(ctx, s, "page.screenshot", Input{SessionID: s.ID, TabID: tab.TabID, JobID: job})
		if e != nil {
			return nil, e
		}
		saved, e := saveScreenshot(s, pic)
		if e != nil {
			return nil, e
		}
		var v map[string]any
		_ = decode(saved, &v)
		page["screenshotPath"] = v["path"]
	}
	return wire.Raw(page), nil
}
func (b *Broker) progress(s *Session, id string) {
	status, e := b.jobStatus(s, id)
	if e != nil {
		return
	}
	var v map[string]any
	_ = decode(status, &v)
	delete(v, "items")
	b.mu.Lock()
	p := b.peers[s.Profile]
	b.mu.Unlock()
	if p != nil {
		_ = p.w.Write(wire.Message{Kind: "event", Session: s.ID, Method: "batch.progress", Params: wire.Raw(v)})
	}
}
func (b *Broker) exportJob(s *Session, id, format string) (json.RawMessage, error) {
	if e := b.jobSession(s, id); e != nil {
		return nil, e
	}
	if format != "jsonl" && format != "csv" && format != "markdown" {
		return nil, fail("EXPORT_FORMAT", "请选择 jsonl、csv 或 markdown")
	}
	items, e := b.items(id, true)
	if e != nil {
		return nil, e
	}
	dir := filepath.Join(s.Output, "batch-"+id+"-"+ID()[:8])
	if e = os.Mkdir(dir, 0700); e != nil {
		return nil, e
	}
	paths := []string{}
	if format == "markdown" {
		for _, i := range items {
			var p struct {
				Title     string `json:"title"`
				URL       string `json:"url"`
				Body      string `json:"body"`
				Collected string `json:"collectedAt"`
				Links     []struct {
					Text string `json:"text"`
					URL  string `json:"url"`
				} `json:"links"`
				Tables [][][]string `json:"tables"`
			}
			_ = decode(i.Result, &p)
			var text strings.Builder
			fmt.Fprintf(&text, "# %s\n\n来源：%s\n\n最终网址：%s\n\n采集时间：%s\n\n状态：%s\n\n%s\n\n%s\n", p.Title, i.URL, p.URL, p.Collected, i.State, i.Error, p.Body)
			if len(p.Links) > 0 {
				text.WriteString("\n## 链接\n\n")
				for _, l := range p.Links {
					fmt.Fprintf(&text, "- %s — %s\n", l.Text, l.URL)
				}
			}
			for ti, t := range p.Tables {
				fmt.Fprintf(&text, "\n## 表格 %d\n\n", ti+1)
				for ri, row := range t {
					clean := make([]string, len(row))
					for j, c := range row {
						clean[j] = strings.NewReplacer("|", "\\|", "\n", " ").Replace(c)
					}
					text.WriteString("| " + strings.Join(clean, " | ") + " |\n")
					if ri == 0 {
						text.WriteString("|" + strings.Repeat(" --- |", len(row)) + "\n")
					}
				}
			}
			pfile := filepath.Join(dir, fmt.Sprintf("%03d.md", i.N+1))
			if e = os.WriteFile(pfile, []byte(text.String()), 0600); e != nil {
				return nil, e
			}
			paths = append(paths, pfile)
		}
	} else {
		path := filepath.Join(dir, "results."+format)
		f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return nil, e
		}
		if format == "jsonl" {
			enc := json.NewEncoder(f)
			for _, i := range items {
				if e = enc.Encode(i); e != nil {
					break
				}
			}
		} else {
			_, _ = f.Write([]byte{0xef, 0xbb, 0xbf})
			w := csv.NewWriter(f)
			e = w.Write([]string{"序号", "输入网址", "状态", "尝试次数", "错误", "标题", "最终网址", "采集时间", "正文", "链接JSON", "表格JSON"})
			for _, i := range items {
				var p map[string]any
				_ = decode(i.Result, &p)
				str := func(k string) string { v, _ := p[k].(string); return csvSafe(v) }
				e = w.Write([]string{fmt.Sprint(i.N + 1), csvSafe(i.URL), i.State, fmt.Sprint(i.Attempts), csvSafe(i.Error), str("title"), str("url"), str("collectedAt"), str("body"), csvSafe(string(wire.Raw(p["links"]))), csvSafe(string(wire.Raw(p["tables"])))})
				if e != nil {
					break
				}
			}
			w.Flush()
			if e == nil {
				e = w.Error()
			}
		}
		closeErr := f.Close()
		if e != nil {
			return nil, e
		}
		if closeErr != nil {
			return nil, closeErr
		}
		paths = append(paths, path)
	}
	return wire.Raw(map[string]any{"directory": dir, "files": paths, "format": format, "total": len(items)}), nil
}
func csvSafe(s string) string {
	trim := strings.TrimLeft(s, " \t\r\n")
	if len(trim) > 0 && strings.ContainsRune("=+-@", rune(trim[0])) {
		return "'" + s
	}
	return s
}
