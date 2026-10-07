package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/png"
	"net"
	"os"
	"path/filepath"
	"sync"
	"browser-bridge/internal/localipc"
	"browser-bridge/internal/wire"
	"time"
)

type peer struct {
	w       *wire.Writer
	conn    net.Conn
	info    json.RawMessage
	done    chan struct{}
	pending map[string]chan wire.Message
	mu      sync.Mutex
}

var expectedCapabilities = []string{"semantic-targets", "screenshots-v2", "native-input", "frames-v2", "claim-tabs", "wait-dialog", "download-expect", "file-chooser", "session-windows", "background-input"}

func extensionReadiness(raw json.RawMessage) (bool, []string) {
	var details struct {
		ExtensionVersion string   `json:"extensionVersion"`
		Capabilities     []string `json:"capabilities"`
	}
	_ = decode(raw, &details)
	missing := []string{}
	for _, required := range expectedCapabilities {
		found := false
		for _, actual := range details.Capabilities {
			if actual == required {
				found = true
				break
			}
		}
		if !found {
			missing = append(missing, required)
		}
	}
	return details.ExtensionVersion == AppVersion && len(missing) == 0, missing
}

type Broker struct {
	db       *sql.DB
	mu       sync.Mutex
	peers    map[string]*peer
	locks    sync.Map
	jobs     map[string]context.CancelFunc
	stop     chan struct{}
	listener net.Listener
	shutdown sync.Once
}

func RunBroker() error {
	if e := localipc.EnsureDir(); e != nil {
		return e
	}
	l, e := localipc.Listen()
	if e != nil {
		return e
	}
	defer l.Close()
	db, e := openStore(localipc.DataDir())
	if e != nil {
		return e
	}
	defer db.Close()
	b := &Broker{db: db, peers: map[string]*peer{}, jobs: map[string]context.CancelFunc{}, stop: make(chan struct{}), listener: l}
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-b.stop:
				return
			case <-ticker.C:
				b.mu.Lock()
				ids := []string{}
				for id := range b.peers {
					ids = append(ids, id)
				}
				b.mu.Unlock()
				for _, id := range ids {
					b.resumeJobs(id)
				}
			}
		}
	}()
	for {
		c, e := l.Accept()
		if e != nil {
			select {
			case <-b.stop:
				return nil
			default:
				return e
			}
		}
		go b.handle(c)
	}
}
func (b *Broker) handle(c net.Conn) {
	defer c.Close()
	r := &wire.Reader{R: c}
	w := &wire.Writer{W: c}
	_ = c.SetReadDeadline(time.Now().Add(15 * time.Second))
	m, e := r.Read()
	if e != nil {
		_ = w.Write(wire.Message{Kind: "response", ID: m.ID, Error: rpcError(e)})
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	if m.Kind == "hello" && m.Method == "native" {
		b.native(c, r, w, m)
		return
	}
	if m.Kind != "request" || m.ID == "" || m.Client == "" {
		_ = w.Write(wire.Message{Kind: "response", ID: m.ID, Error: rpcError(fail("INVALID_REQUEST", "缺少请求或客户端标识"))})
		return
	}
	deadline := time.UnixMilli(m.Deadline)
	if m.Deadline == 0 || deadline.After(time.Now().Add(2*time.Minute)) {
		deadline = time.Now().Add(2 * time.Minute)
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	result, e := b.dispatch(ctx, m)
	resp := wire.Message{Kind: "response", ID: m.ID, Result: result}
	if e != nil {
		resp.Error = rpcError(e)
	}
	_ = w.Write(resp)
}
func (b *Broker) native(c net.Conn, r *wire.Reader, w *wire.Writer, m wire.Message) {
	if m.Profile == "" {
		return
	}
	p := &peer{w: w, conn: c, info: m.Params, done: make(chan struct{}), pending: map[string]chan wire.Message{}}
	b.mu.Lock()
	old := b.peers[m.Profile]
	b.peers[m.Profile] = p
	b.mu.Unlock()
	if old != nil {
		old.conn.Close()
	}
	defer func() {
		close(p.done)
		b.mu.Lock()
		if b.peers[m.Profile] == p {
			delete(b.peers, m.Profile)
		}
		b.mu.Unlock()
	}()
	_ = w.Write(wire.Message{Kind: "event", Method: "connected", Params: wire.Raw(map[string]any{"version": AppVersion, "protocol": wire.Version})})
	var hello struct {
		Stopped []string `json:"stoppedSessionIds"`
	}
	_ = decode(m.Params, &hello)
	for _, id := range hello.Stopped {
		b.stopSession(id, m.Profile)
	}
	go b.resumeJobs(m.Profile)
	for {
		msg, e := r.Read()
		if e != nil {
			return
		}
		if msg.Kind == "event" && msg.Method == "session.stop" {
			b.stopSession(msg.Session, m.Profile)
			continue
		}
		if msg.Kind == "event" && msg.Method == "ui.screenshot" {
			go func(msg wire.Message) {
				var owner, data string
				if b.db.QueryRow("SELECT owner,data FROM sessions WHERE id=?", msg.Session).Scan(&owner, &data) != nil {
					return
				}
				var s Session
				_ = json.Unmarshal([]byte(data), &s)
				if s.Profile != m.Profile {
					return
				}
				ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
				defer cancel()
				result, err := b.dispatch(ctx, wire.Message{Method: "page.screenshot", Client: owner, Session: msg.Session, Params: msg.Params})
				response := wire.Message{Kind: "event", Method: "ui.screenshot.result", ID: msg.ID, Result: result}
				if err != nil {
					response.Error = rpcError(err)
				}
				_ = w.Write(response)
			}(msg)
			continue
		}
		if msg.Kind == "response" {
			p.mu.Lock()
			ch := p.pending[msg.ID]
			p.mu.Unlock()
			if ch != nil {
				select {
				case ch <- msg:
				default:
				}
			}
		}
	}
}
func (b *Broker) call(ctx context.Context, s *Session, method string, in Input) (json.RawMessage, error) {
	b.mu.Lock()
	p := b.peers[s.Profile]
	b.mu.Unlock()
	if p == nil {
		return nil, fail("BROWSER_DISCONNECTED", "Chrome 扩展尚未连接。打开对应配置文件的 Chrome，检查扩展状态。")
	}
	var hello struct {
		Capabilities []string `json:"capabilities"`
	}
	_ = decode(p.info, &hello)
	required := requiredCapability(method, in)
	if required != "" {
		found := false
		for _, c := range hello.Capabilities {
			if c == required {
				found = true
			}
		}
		if !found {
			return nil, fail("UPGRADE_REQUIRED", "Chrome 扩展不支持此能力，请同时升级扩展和本机服务至 v0.2.0")
		}
	}
	m := request(method, in)
	m.Session = s.ID
	m.Profile = s.Profile
	if deadline, ok := ctx.Deadline(); ok {
		m.Deadline = deadline.UnixMilli()
	}
	ch := make(chan wire.Message, 1)
	p.mu.Lock()
	p.pending[m.ID] = ch
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.pending, m.ID); p.mu.Unlock() }()
	if e := p.w.Write(m); e != nil {
		return nil, &wire.Error{Code: "CONNECTION_LOST", Message: "本机连接已断开，请重新观察页面。", Uncertain: isMutation(method)}
	}
	select {
	case resp := <-ch:
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp.Result, nil
	case <-ctx.Done():
		return nil, &wire.Error{Code: "TIMEOUT", Message: "超过截止时间；修改结果可能不明，重新观察后再决定。", Uncertain: isMutation(method)}
	case <-p.done:
		return nil, &wire.Error{Code: "CONNECTION_LOST", Message: "连接中断；重新观察后再决定，禁止自动重放提交或上传。", Uncertain: isMutation(method)}
	}
}
func isMutation(method string) bool {
	switch method {
	case "tab.open", "tab.close", "tab.focus", "tab.claim", "tab.release", "page.act", "page.navigate", "page.dialog", "file.upload", "download.start", "download.expect":
		return true
	}
	return false
}
func (b *Broker) dispatch(ctx context.Context, m wire.Message) (json.RawMessage, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	var in Input
	if e := decode(m.Params, &in); e != nil {
		return nil, e
	}
	if in.SessionID == "" {
		in.SessionID = m.Session
	}
	switch m.Method {
	case "connection.status":
		b.mu.Lock()
		ps := []map[string]any{}
		for id, p := range b.peers {
			ready, missing := extensionReadiness(p.info)
			ps = append(ps, map[string]any{"profileId": id, "details": p.info, "upgradeRequired": !ready, "missingCapabilities": missing})
		}
		b.mu.Unlock()
		return wire.Raw(map[string]any{"version": AppVersion, "protocol": wire.Version, "transport": "native-messaging + current-user IPC", "profiles": ps, "proxyIndependent": true, "minimumChromeVersion": 125, "toolCount": len(toolSpecs)}), nil
	case "service.shutdown":
		b.shutdown.Do(func() { close(b.stop); b.listener.Close() })
		return wire.Raw(map[string]bool{"stopped": true}), nil
	case "session.start":
		return b.startSession(ctx, m.Client, in)
	}
	s, e := b.getSession(in.SessionID, m.Client, m.Method == "session.end" || m.Method == "batch.status" || m.Method == "batch.export" || m.Method == "download.status")
	if e != nil {
		return nil, e
	}
	switch m.Method {
	case "session.end":
		b.stopSession(s.ID, s.Profile)
		return b.call(ctx, s, "session.end", in)
	case "session.update":
		return b.updateSession(ctx, s, in)
	case "batch.create":
		return b.createJob(s, in)
	case "batch.status":
		return b.jobStatus(s, in.JobID)
	case "batch.cancel":
		return b.cancelJob(s, in.JobID)
	case "batch.retry":
		return b.retryJob(s, in.JobID)
	case "batch.export":
		return b.exportJob(s, in.JobID, in.Format)
	}
	if in.URL != "" {
		if e = s.checkURL(in.URL); e != nil {
			return nil, e
		}
	}
	if m.Method == "file.upload" {
		if len(in.Files) == 0 {
			return nil, fail("NO_FILE", "请指定已授权文件")
		}
		for i, p := range in.Files {
			in.Files[i], e = safeFile(p, s.Files)
			if e != nil {
				return nil, e
			}
		}
	}
	allowed := map[string]bool{"tabs.list": true, "tab.open": true, "tab.close": true, "tab.focus": true, "tab.claim": true, "tab.release": true, "page.observe": true, "page.find": true, "page.wait": true, "page.dialog": true, "page.screenshot": true, "page.act": true, "page.navigate": true, "file.upload": true, "download.start": true, "download.status": true, "download.expect": true}
	if !allowed[m.Method] {
		return nil, fail("UNKNOWN_METHOD", "不支持该操作")
	}
	if e = validateInput(m.Method, in); e != nil {
		return nil, e
	}
	lockkey := fmt.Sprintf("%s:%d", s.Profile, in.TabID)
	lock, _ := b.locks.LoadOrStore(lockkey, &sync.Mutex{})
	lock.(*sync.Mutex).Lock()
	defer lock.(*sync.Mutex).Unlock()
	// Recheck after waiting: the stop button invalidates queued work.
	if _, e = b.getSession(s.ID, m.Client, m.Method == "download.status"); e != nil {
		return nil, e
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	if isMutation(m.Method) && !(m.Method == "page.dialog" && (in.Action == "" || in.Action == "read")) {
		return b.once(ctx, s, m.Method, in)
	}
	out, e := b.call(ctx, s, m.Method, in)
	if e == nil && m.Method == "page.screenshot" {
		out, e = saveScreenshot(s, out)
	}
	return out, e
}
func (b *Broker) once(ctx context.Context, s *Session, method string, in Input) (json.RawMessage, error) {
	if in.RequestID == "" {
		return nil, fail("OPERATION_ID_REQUIRED", "修改操作需要唯一 operationId；遇到断线使用原编号查询，不能换编号自动重试。")
	}
	key := s.ID + ":" + in.RequestID
	hash := fmt.Sprintf("%x", sha256.Sum256(append([]byte(method), wire.Raw(in)...)))
	var fingerprint, state, result string
	e := b.db.QueryRow("SELECT fingerprint,state,COALESCE(result,'') FROM operations WHERE id=?", key).Scan(&fingerprint, &state, &result)
	if e == nil {
		if hash != fingerprint {
			return nil, fail("DUPLICATE_ID_CONFLICT", "同一 operationId 不能代表不同操作")
		}
		if state == "done" {
			var resp wire.Message
			_ = json.Unmarshal([]byte(result), &resp)
			if resp.Error != nil {
				return nil, resp.Error
			}
			return resp.Result, nil
		}
		return nil, &wire.Error{Code: "OUTCOME_UNKNOWN", Message: "此操作已开始，结果不明。请先重新观察页面；禁止自动重放。", Uncertain: true}
	}
	if e != sql.ErrNoRows {
		return nil, e
	}
	if _, e = b.db.Exec("INSERT INTO operations(id,fingerprint,state) VALUES(?,?,'pending')", key, hash); e != nil {
		return nil, fail("DUPLICATE_IN_FLIGHT", "相同操作已在处理中；请勿重复提交")
	}
	out, e := b.call(ctx, s, method, in)
	resp := wire.Message{Result: out}
	if e != nil {
		resp.Error = rpcError(e)
	}
	_, storeErr := b.db.Exec("UPDATE operations SET state='done',result=? WHERE id=?", string(wire.Raw(resp)), key)
	if storeErr != nil {
		return nil, &wire.Error{Code: "OUTCOME_UNKNOWN", Message: "操作已发送，但记录保存失败，请重新观察页面。", Uncertain: true}
	}
	return out, e
}
func (b *Broker) startSession(ctx context.Context, owner string, in Input) (json.RawMessage, error) {
	if in.ResumeToken != "" {
		rows, e := b.db.Query("SELECT data FROM sessions")
		if e != nil {
			return nil, e
		}
		var found *Session
		for rows.Next() {
			var data string
			_ = rows.Scan(&data)
			var s Session
			_ = json.Unmarshal([]byte(data), &s)
			if s.ResumeToken == in.ResumeToken {
				found = &s
				break
			}
		}
		rows.Close()
		if found == nil {
			return nil, fail("INVALID_RESUME_TOKEN", "恢复凭据无效")
		}
		if found.Stopped {
			return nil, fail("SESSION_STOPPED", "已停止任务不可恢复，请新建任务")
		}
		found.Owner = owner
		if e = b.saveSession(found); e != nil {
			return nil, e
		}
		window, e := b.call(ctx, found, "session.start", Input{SessionID: found.ID, Name: found.Name, Origins: found.Origins})
		if e != nil {
			return nil, e
		}
		go b.resumeJobs(found.Profile)
		return sessionWindowResult(found, window), nil
	}
	if in.ProfileID == "" {
		b.mu.Lock()
		if len(b.peers) == 1 {
			for id := range b.peers {
				in.ProfileID = id
			}
		}
		b.mu.Unlock()
	}
	if in.ProfileID == "" {
		return nil, fail("SELECT_PROFILE", "请先查看连接状态并选择 profileId；有多个配置文件时必须明确指定")
	}
	if in.OutputDir == "" {
		in.OutputDir = filepath.Join(localipc.DataDir(), "results", ID())
	}
	out, e := secureDir(in.OutputDir)
	if e != nil {
		return nil, e
	}
	s := &Session{ID: ID(), Owner: owner, Profile: in.ProfileID, Name: in.Name, Output: out, ResumeToken: ID()}
	if s.Name == "" {
		s.Name = "Codex 网页任务"
	}
	if e = applyAuthorization(s, in); e != nil {
		return nil, e
	}
	window, e := b.call(ctx, s, "session.start", Input{SessionID: s.ID, Name: s.Name, Origins: s.Origins})
	if e != nil {
		return nil, e
	}
	if e = b.saveSession(s); e != nil {
		return nil, e
	}
	return sessionWindowResult(s, window), nil
}

// Window IDs are live Chrome metadata; do not persist them as identities in SQLite.
func sessionWindowResult(s *Session, window json.RawMessage) json.RawMessage {
	var result map[string]any
	_ = json.Unmarshal(wire.Raw(s), &result)
	var metadata map[string]any
	_ = json.Unmarshal(window, &metadata)
	for _, key := range []string{"windowId", "windowMode", "focusPolicy"} {
		if value, ok := metadata[key]; ok {
			result[key] = value
		}
	}
	return wire.Raw(result)
}
func applyAuthorization(s *Session, in Input) error {
	// origins is a deprecated compatibility field, not a website allowlist.
	s.Origins = nil
	for _, p := range in.Files {
		if !filepath.IsAbs(p) {
			return fail("INVALID_FILE", "授权文件必须是绝对路径")
		}
		p, e := filepath.EvalSymlinks(p)
		if e != nil {
			return e
		}
		i, e := os.Stat(p)
		if e != nil || !i.Mode().IsRegular() {
			return fail("INVALID_FILE", "授权文件必须是普通文件")
		}
		s.Files = append(s.Files, p)
	}
	return nil
}
func (b *Broker) updateSession(ctx context.Context, s *Session, in Input) (json.RawMessage, error) {
	if e := applyAuthorization(s, in); e != nil {
		return nil, e
	}
	_, e := b.call(ctx, s, "session.start", Input{SessionID: s.ID, Name: s.Name, Origins: s.Origins})
	if e != nil {
		return nil, e
	}
	e = b.saveSession(s)
	return wire.Raw(s), e
}
func (b *Broker) stopSession(id, profile string) {
	var data, owner string
	if b.db.QueryRow("SELECT owner,data FROM sessions WHERE id=?", id).Scan(&owner, &data) != nil {
		return
	}
	var s Session
	_ = json.Unmarshal([]byte(data), &s)
	if s.Profile != profile {
		return
	}
	s.Owner = owner
	s.Stopped = true
	_ = b.saveSession(&s)
	rows, e := b.db.Query("SELECT id FROM jobs WHERE session=? AND state IN ('running','queued')", id)
	if e == nil {
		ids := []string{}
		for rows.Next() {
			var j string
			_ = rows.Scan(&j)
			ids = append(ids, j)
		}
		rows.Close()
		for _, j := range ids {
			_, _ = b.cancelJob(&s, j)
		}
	}
	b.mu.Lock()
	p := b.peers[profile]
	b.mu.Unlock()
	if p != nil {
		_ = p.w.Write(wire.Message{Kind: "event", Method: "session.stopped", Session: id})
	}
}
func saveScreenshot(s *Session, raw json.RawMessage) (json.RawMessage, error) {
	var p map[string]any
	if e := decode(raw, &p); e != nil {
		return nil, e
	}
	images, ok := p["images"].([]any)
	if !ok {
		images = []any{map[string]any{"data": p["data"]}}
	}
	for i, v := range images {
		im, ok := v.(map[string]any)
		if !ok {
			return nil, fail("INVALID_IMAGE", "无效截图")
		}
		data, _ := im["data"].(string)
		binary, e := base64.StdEncoding.DecodeString(data)
		if e != nil {
			return nil, e
		}
		cfg, e := png.DecodeConfig(bytes.NewReader(binary))
		if e != nil {
			return nil, e
		}
		path := filepath.Join(s.Output, "screenshot-"+ID()+".png")
		if e = os.WriteFile(path, binary, 0600); e != nil {
			return nil, e
		}
		im["path"] = path
		im["width"] = cfg.Width
		im["height"] = cfg.Height
		im["imageIndex"] = i
		im["mimeType"] = "image/png"
		if i == 0 {
			p["path"] = path
			p["mimeType"] = "image/png"
		}
	}
	p["images"] = images
	delete(p, "data")
	return wire.Raw(p), nil
}

func requiredCapability(method string, in Input) string {
	switch method {
	case "page.find":
		return "semantic-targets"
	case "tab.claim", "tab.release":
		return "claim-tabs"
	case "page.wait", "page.dialog":
		return "wait-dialog"
	case "download.expect":
		return "download-expect"
	case "page.screenshot":
		if in.Mode != "" && in.Mode != "viewport" {
			return "screenshots-v2"
		}
	case "page.act":
		if in.Target != nil || in.Destination != nil || in.Action != "click" && in.Action != "fill" && in.Action != "select" && in.Action != "scroll" && in.Action != "submit" {
			return "native-input"
		}
	case "file.upload":
		if in.ChooserID != "" {
			return "file-chooser"
		}
	case "tabs.list":
		if in.Scope == "available" {
			return "claim-tabs"
		}
	}
	return ""
}
func validateInput(method string, in Input) error {
	if in.TimeoutSeconds < 0 || in.TimeoutSeconds > 90 {
		return fail("INVALID_TIMEOUT", "超时范围为1至90秒")
	}
	if method == "page.screenshot" && in.Mode == "region" && (in.Region == nil || in.Region.Width <= 0 || in.Region.Height <= 0 || in.Region.X < 0 || in.Region.Y < 0) {
		return fail("INVALID_REGION", "需要有效截图区域")
	}
	if method == "page.act" {
		if in.Target != nil && in.Element != "" {
			return fail("INVALID_TARGET", "元素和坐标目标只能选择一种")
		}
		for _, m := range in.Modifiers {
			if m != "Alt" && m != "Control" && m != "Meta" && m != "Shift" {
				return fail("INVALID_KEY", "未知修饰键")
			}
		}
	}
	if method == "file.upload" && in.ChooserID == "" && (in.Element == "" || in.Version == "") {
		return fail("TARGET_REQUIRED", "需要最新文件控件或文件选择请求")
	}
	if method == "download.status" && in.DownloadID == 0 && in.ExpectationID == "" {
		return fail("DOWNLOAD_REQUIRED", "需要下载编号或下载等待编号")
	}
	return nil
}
