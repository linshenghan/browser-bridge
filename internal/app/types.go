package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"browser-bridge/internal/wire"
	"time"
)

const AppVersion = "0.2.1"
const HostName = "com.browser_bridge.native"

func ID() string                  { b := make([]byte, 16); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func fail(code, msg string) error { return &wire.Error{Code: code, Message: msg} }
func rpcError(err error) *wire.Error {
	var e *wire.Error
	if errors.As(err, &e) {
		return e
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &wire.Error{Code: "TIMEOUT", Message: "操作超时，请重新观察页面；提交和上传不可自动重试。"}
	}
	return &wire.Error{Code: "BRIDGE_ERROR", Message: err.Error()}
}
func decode(raw json.RawMessage, out any) error {
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	return json.Unmarshal(raw, out)
}
func normalizeURL(s string) (string, error) {
	u, e := url.Parse(strings.TrimSpace(s))
	if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return "", fail("INVALID_URL", "仅接受不含用户名密码的 http/https 网址")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	if (u.Scheme == "https" && u.Port() == "443") || (u.Scheme == "http" && u.Port() == "80") {
		u.Host = u.Hostname()
		if strings.Contains(u.Host, ":") {
			u.Host = "[" + u.Host + "]"
		}
	}
	u.Fragment = ""
	if u.Path == "" {
		u.Path = "/"
	}
	return u.String(), nil
}
func origin(s string) string { u, _ := url.Parse(s); return u.Scheme + "://" + u.Host }
func safeFile(path string, allowed []string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", fail("FILE_NOT_AUTHORIZED", "文件必须使用用户授权的绝对路径")
	}
	p, e := filepath.EvalSymlinks(path)
	if e != nil {
		return "", e
	}
	info, e := os.Stat(p)
	if e != nil || !info.Mode().IsRegular() {
		return "", fail("INVALID_FILE", "只能上传普通文件")
	}
	for _, a := range allowed {
		ap, e := filepath.EvalSymlinks(a)
		if e != nil {
			continue
		}
		if filepath.Clean(ap) == filepath.Clean(p) {
			return p, nil
		}
	}
	return "", fail("FILE_NOT_AUTHORIZED", "该文件不在本任务明确授权的文件清单中")
}
func secureDir(p string) (string, error) {
	if !filepath.IsAbs(p) {
		return "", fail("INVALID_DIRECTORY", "输出目录必须使用绝对路径")
	}
	if e := os.MkdirAll(p, 0700); e != nil {
		return "", e
	}
	return filepath.EvalSymlinks(p)
}

type Session struct {
	ID          string   `json:"sessionId"`
	Owner       string   `json:"-"`
	Profile     string   `json:"profileId"`
	Name        string   `json:"name"`
	Origins     []string `json:"origins"`
	Files       []string `json:"authorizedFiles"`
	Output      string   `json:"outputDir"`
	Stopped     bool     `json:"stopped"`
	ResumeToken string   `json:"resumeToken,omitempty"`
}
type Input struct {
	SessionID      string   `json:"sessionId,omitempty"`
	ProfileID      string   `json:"profileId,omitempty"`
	Name           string   `json:"name,omitempty"`
	Origins        []string `json:"origins,omitempty"`
	Files          []string `json:"files,omitempty"`
	OutputDir      string   `json:"outputDir,omitempty"`
	ResumeToken    string   `json:"resumeToken,omitempty"`
	TabID          int      `json:"tabId,omitempty"`
	URL            string   `json:"url,omitempty"`
	URLs           []string `json:"urls,omitempty"`
	Version        string   `json:"pageVersion,omitempty"`
	Element        string   `json:"elementId,omitempty"`
	FrameID        int      `json:"frameId,omitempty"`
	Action         string   `json:"action,omitempty"`
	Text           string   `json:"text,omitempty"`
	Values         []string `json:"values,omitempty"`
	X              int      `json:"x,omitempty"`
	Y              int      `json:"y,omitempty"`
	JobID          string   `json:"jobId,omitempty"`
	Format         string   `json:"format,omitempty"`
	Screenshot     bool     `json:"screenshot,omitempty"`
	TimeoutSeconds int      `json:"timeoutSeconds,omitempty"`
	Concurrency    int      `json:"concurrency,omitempty"`
	RequestID      string   `json:"operationId,omitempty"`
	DownloadID     int      `json:"downloadId,omitempty"`
	Mode           string   `json:"mode,omitempty"`
	Region         *Region  `json:"region,omitempty"`
	Target         *Target  `json:"target,omitempty"`
	Destination    *Target  `json:"destination,omitempty"`
	OffsetY        int      `json:"offsetY,omitempty"`
	Role           string   `json:"role,omitempty"`
	Exact          bool     `json:"exact,omitempty"`
	Scope          string   `json:"scope,omitempty"`
	DiscoveryToken string   `json:"discoveryToken,omitempty"`
	Key            string   `json:"key,omitempty"`
	Modifiers      []string `json:"modifiers,omitempty"`
	Direction      string   `json:"direction,omitempty"`
	Condition      string   `json:"condition,omitempty"`
	DialogID       string   `json:"dialogId,omitempty"`
	ChooserID      string   `json:"chooserId,omitempty"`
	ExpectationID  string   `json:"expectationId,omitempty"`
	KnownTabIDs    []int    `json:"knownTabIds,omitempty"`
}

type Region struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}
type Target struct {
	ElementID    string  `json:"elementId,omitempty"`
	FrameID      int     `json:"frameId,omitempty"`
	ScreenshotID string  `json:"screenshotId,omitempty"`
	ImageIndex   int     `json:"imageIndex,omitempty"`
	X            float64 `json:"x"`
	Y            float64 `json:"y"`
}

func (s *Session) checkURL(u string) error {
	// Website access is global; task isolation and file authorization remain
	// separate. URL validation still enforces protected schemes.
	_, e := normalizeURL(u)
	return e
}
func request(method string, in Input) wire.Message {
	return wire.Message{Version: wire.Version, Kind: "request", ID: ID(), Session: in.SessionID, Method: method, Params: wire.Raw(in), Deadline: time.Now().Add(60 * time.Second).UnixMilli()}
}
