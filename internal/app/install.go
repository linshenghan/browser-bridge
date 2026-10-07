package app

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"browser-bridge/internal/localipc"
	"browser-bridge/internal/wire"
	"time"
)

type installation struct {
	Current     string `json:"current"`
	Previous    string `json:"previous,omitempty"`
	Marketplace string `json:"marketplace"`
	PluginPath  string `json:"pluginPath"`
	ExtensionID string `json:"extensionId"`
}

func exeName() string {
	if runtime.GOOS == "windows" {
		return "browser-bridge.exe"
	}
	return "browser-bridge"
}
func writeJSON(path string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	tmp := path + ".tmp-" + ID()
	if e = os.WriteFile(tmp, append(b, '\n'), 0600); e != nil {
		return e
	}
	return os.Rename(tmp, path)
}
func copyFile(src, dst string, mode os.FileMode) error {
	in, e := os.Open(src)
	if e != nil {
		return e
	}
	defer in.Close()
	if e = os.MkdirAll(filepath.Dir(dst), 0700); e != nil {
		return e
	}
	out, e := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if e != nil {
		return e
	}
	_, e = io.Copy(out, in)
	ce := out.Close()
	if e != nil {
		return e
	}
	return ce
}
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("安装包中不允许符号链接：%s", path)
		}
		rel, e := filepath.Rel(src, path)
		if e != nil {
			return e
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		return copyFile(path, target, info.Mode().Perm())
	})
}
func nativeManifest(binary string) map[string]any {
	return map[string]any{"name": HostName, "description": "Chrome 操作助手本机连接", "path": binary, "type": "stdio", "allowed_origins": []string{"chrome-extension://" + ExtensionID + "/"}}
}
func Install(source string, skipCodex bool) (map[string]any, error) {
	source, e := filepath.Abs(source)
	if e != nil {
		return nil, e
	}
	root := localipc.DataDir()
	if e = localipc.EnsureDir(); e != nil {
		return nil, e
	}
	binary := filepath.Join(source, exeName())
	bin, e := os.ReadFile(binary)
	if e != nil {
		return nil, e
	}
	var manifest map[string]any
	data, e := os.ReadFile(filepath.Join(source, "extension", "manifest.json"))
	if e != nil {
		return nil, fmt.Errorf("安装包缺少 extension/manifest.json: %w", e)
	}
	if e = json.Unmarshal(data, &manifest); e != nil {
		return nil, e
	}
	if manifest["version"] != AppVersion {
		return nil, fail("VERSION_MISMATCH", "扩展与本机服务版本不一致")
	}
	key, _ := manifest["key"].(string)
	pub, e := base64.StdEncoding.DecodeString(key)
	if e != nil {
		return nil, fail("EXTENSION_ID_MISMATCH", "扩展公钥无效")
	}
	idHash := sha256.Sum256(pub)
	var extID strings.Builder
	for _, v := range idHash[:16] {
		extID.WriteByte('a' + v>>4)
		extID.WriteByte('a' + v&15)
	}
	if extID.String() != ExtensionID {
		return nil, fail("EXTENSION_ID_MISMATCH", "扩展 ID 与本机服务不一致，未注册")
	}
	digest := sha256.New()
	digest.Write(bin)
	for _, dir := range []string{"extension", "plugin"} {
		e = filepath.WalkDir(filepath.Join(source, dir), func(path string, d os.DirEntry, e error) error {
			if e != nil {
				return e
			}
			if d.Type()&os.ModeSymlink != 0 {
				return fail("UNSAFE_PACKAGE", "安装包不能包含符号链接")
			}
			if !d.IsDir() {
				rel, _ := filepath.Rel(source, path)
				digest.Write([]byte(filepath.ToSlash(rel)))
				data, e := os.ReadFile(path)
				if e != nil {
					return e
				}
				digest.Write(data)
			}
			return nil
		})
		if e != nil {
			return nil, e
		}
	}
	hash := fmt.Sprintf("%x", digest.Sum(nil))
	release := filepath.Join(root, "releases", AppVersion+"-"+hash[:12])
	if e = os.MkdirAll(release, 0700); e != nil {
		return nil, e
	}
	if _, e = os.Stat(filepath.Join(release, exeName())); os.IsNotExist(e) {
		if e = copyFile(binary, filepath.Join(release, exeName()), 0700); e != nil {
			return nil, e
		}
	}
	if e = copyTree(filepath.Join(source, "extension"), filepath.Join(release, "extension")); e != nil {
		return nil, e
	}
	if e = copyTree(filepath.Join(source, "plugin"), filepath.Join(release, "plugin")); e != nil {
		return nil, e
	}
	_ = os.WriteFile(filepath.Join(root, ".browser-bridge-owned"), []byte("browser-bridge\n"), 0600)
	var state installation
	previousData, _ := os.ReadFile(filepath.Join(root, "installation.json"))
	_ = json.Unmarshal(previousData, &state)
	if state.Current != release {
		state.Previous = state.Current
	}
	state.Current = release
	state.ExtensionID = ExtensionID
	return activate(state, skipCodex)
}

// Publishing a new worker renames it in the manifest. Plain copies leave the
// older hashed workers behind, so remove everything besides the current entry.
func pruneStaleWorkers(dir string) error {
	keep := ""
	if data, e := os.ReadFile(filepath.Join(dir, "manifest.json")); e == nil {
		var m map[string]any
		if json.Unmarshal(data, &m) == nil {
			if bg, ok := m["background"].(map[string]any); ok {
				keep, _ = bg["service_worker"].(string)
			}
		}
	}
	if keep == "" {
		return nil
	}
	entries, e := os.ReadDir(dir)
	if e != nil {
		return e
	}
	for _, f := range entries {
		n := f.Name()
		if n == keep || !strings.HasPrefix(n, "background-") {
			continue
		}
		if strings.HasSuffix(n, ".js") || strings.HasSuffix(n, ".js.map") {
			if e = os.Remove(filepath.Join(dir, n)); e != nil {
				return e
			}
		}
	}
	return nil
}
func activate(state installation, skipCodex bool) (map[string]any, error) {
	root := localipc.DataDir()
	if e := copyTree(filepath.Join(state.Current, "extension"), filepath.Join(root, "extension")); e != nil {
		return nil, e
	}
	if e := pruneStaleWorkers(filepath.Join(root, "extension")); e != nil {
		return nil, e
	}
	binary := filepath.Join(state.Current, exeName())
	hostPath := filepath.Join(root, HostName+".json")
	if e := writeJSON(hostPath, nativeManifest(binary)); e != nil {
		return nil, e
	}
	if e := registerHost(hostPath); e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	if c, e := localipc.Dial(ctx); e == nil {
		_ = (&wire.Writer{W: c}).Write(wire.Message{Version: wire.Version, Kind: "request", ID: ID(), Client: "installer", Method: "service.shutdown", Deadline: time.Now().Add(time.Second).UnixMilli()})
		c.Close()
	}
	cancel()
	result := map[string]any{"installed": true, "version": AppVersion, "extensionId": ExtensionID, "extensionDirectory": filepath.Join(root, "extension"), "binary": binary, "codexInstalled": false, "nextStep": "在 Chrome 开发者模式加载 extensionDirectory，然后在新 Codex 任务中调用 connection_status。"}
	if !skipCodex {
		market, plugin, e := installPlugin(filepath.Join(state.Current, "plugin"), binary)
		state.Marketplace = market
		state.PluginPath = plugin
		if e != nil {
			result["codexError"] = e.Error()
			result["nextStep"] = "浏览器组件已安装。请安装或更新 Codex CLI 后重新运行安装工具以完成 Codex 插件配置。"
		} else {
			result["codexInstalled"] = true
			result["marketplace"] = market
			result["pluginPath"] = plugin
		}
	}
	if e := writeJSON(filepath.Join(root, "installation.json"), state); e != nil {
		return nil, e
	}
	return result, nil
}
func personalPaths() (string, string) {
	home, _ := os.UserHomeDir()
	base := filepath.Join(home, ".agents", "plugins")
	return filepath.Join(base, "marketplace.json"), filepath.Join(home, "plugins", "browser-bridge")
}
func readMarketplace(path string) (map[string]any, error) {
	b, e := os.ReadFile(path)
	if os.IsNotExist(e) {
		return map[string]any{"name": "personal", "interface": map[string]string{"displayName": "Personal"}, "plugins": []any{}}, nil
	}
	if e != nil {
		return nil, e
	}
	var data map[string]any
	if e = json.Unmarshal(b, &data); e != nil {
		return nil, e
	}
	name, _ := data["name"].(string)
	if !regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(name) {
		return nil, fail("INVALID_MARKETPLACE", "个人插件目录名称无效；保留原文件并停止配置")
	}
	if _, ok := data["plugins"].([]any); !ok {
		return nil, fail("INVALID_MARKETPLACE", "个人插件目录结构无效")
	}
	return data, nil
}
func codexExecutable() string {
	if p := os.Getenv("CODEX_CLI_PATH"); p != "" {
		if _, e := os.Stat(p); e == nil {
			return p
		}
	}
	if runtime.GOOS != "windows" {
		if p, e := exec.LookPath("codex"); e == nil {
			return p
		}
		home, _ := os.UserHomeDir()
		for _, p := range []string{"/Applications/Codex.app/Contents/Resources/codex", filepath.Join(home, "Applications/Codex.app/Contents/Resources/codex")} {
			if _, e := os.Stat(p); e == nil {
				return p
			}
		}
		return "codex"
	}
	if p, e := exec.LookPath("codex.exe"); e == nil {
		return p
	}
	paths, _ := filepath.Glob(filepath.Join(os.Getenv("LOCALAPPDATA"), "OpenAI", "Codex", "bin", "*", "codex.exe"))
	var best string
	var newest time.Time
	for _, p := range paths {
		if i, e := os.Stat(p); e == nil && i.ModTime().After(newest) {
			newest = i.ModTime()
			best = p
		}
	}
	if best != "" {
		return best
	}
	paths, _ = filepath.Glob(filepath.Join(os.Getenv("APPDATA"), "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-*", "vendor", "*", "codex", "codex.exe"))
	if len(paths) > 0 {
		return paths[0]
	}
	return "codex"
}
func installPlugin(src, binary string) (string, string, error) {
	catalog, plugin := personalPaths()
	market, e := readMarketplace(catalog)
	if e != nil {
		return "", plugin, e
	}
	name := market["name"].(string)
	entries := market["plugins"].([]any)
	found := false
	for _, entry := range entries {
		p, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if p["name"] == "browser-bridge" {
			source, _ := p["source"].(map[string]any)
			if source["path"] != "./plugins/browser-bridge" {
				return name, plugin, fail("PLUGIN_CONFLICT", "已有同名插件来自其他位置，未覆盖")
			}
			found = true
		}
	}
	marker := filepath.Join(plugin, ".browser-bridge-owned")
	if _, e = os.Stat(plugin); e == nil {
		if _, e = os.Stat(marker); e != nil {
			return name, plugin, fail("PLUGIN_CONFLICT", "目标插件目录已存在且不属于本安装程序，未覆盖")
		}
	}
	if e = copyTree(src, plugin); e != nil {
		return name, plugin, e
	}
	_ = os.WriteFile(marker, []byte("browser-bridge\n"), 0600)
	if e = writeJSON(filepath.Join(plugin, ".mcp.json"), map[string]any{"mcpServers": map[string]any{"browser_bridge": map[string]any{"command": binary, "args": []string{"mcp"}, "startup_timeout_sec": 30, "tool_timeout_sec": 120}}}); e != nil {
		return name, plugin, e
	}
	var manifest map[string]any
	b, e := os.ReadFile(filepath.Join(plugin, ".codex-plugin", "plugin.json"))
	if e != nil {
		return name, plugin, e
	}
	if e = json.Unmarshal(b, &manifest); e != nil {
		return name, plugin, e
	}
	digest := sha256.Sum256([]byte(binary))
	baseVersion, _ := manifest["version"].(string)
	manifest["version"] = strings.Split(baseVersion, "+")[0] + "+codex." + fmt.Sprintf("%x", digest[:6])
	if e = writeJSON(filepath.Join(plugin, ".codex-plugin", "plugin.json"), manifest); e != nil {
		return name, plugin, e
	}
	if !found {
		entries = append(entries, map[string]any{"name": "browser-bridge", "source": map[string]string{"source": "local", "path": "./plugins/browser-bridge"}, "policy": map[string]string{"installation": "AVAILABLE", "authentication": "ON_INSTALL"}, "category": "Productivity"})
		market["plugins"] = entries
		if e = writeJSON(catalog, market); e != nil {
			return name, plugin, e
		}
	}
	cmd := exec.Command(codexExecutable(), "plugin", "add", "browser-bridge@"+name, "--json")
	out, e := cmd.CombinedOutput()
	if e != nil {
		return name, plugin, fmt.Errorf("Codex 插件配置失败：%v；%s", e, out)
	}
	return name, plugin, nil
}
func Rollback() (map[string]any, error) {
	b, e := os.ReadFile(filepath.Join(localipc.DataDir(), "installation.json"))
	if e != nil {
		return nil, e
	}
	var s installation
	if e = json.Unmarshal(b, &s); e != nil {
		return nil, e
	}
	if s.Previous == "" {
		return nil, fail("NO_PREVIOUS_VERSION", "没有可回滚的上一版本")
	}
	s.Current, s.Previous = s.Previous, s.Current
	return activate(s, s.Marketplace == "")
}
func within(root, path string) bool {
	rel, e := filepath.Rel(root, path)
	return e == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
func Uninstall() (map[string]any, error) {
	root := localipc.DataDir()
	if _, e := os.Stat(filepath.Join(root, ".browser-bridge-owned")); e != nil {
		return nil, fail("NOT_OWNED", "未找到本产品安装标识，不删除任何文件")
	}
	b, e := os.ReadFile(filepath.Join(root, "installation.json"))
	if e != nil {
		return nil, e
	}
	var s installation
	_ = json.Unmarshal(b, &s)
	if s.Marketplace != "" {
		cmd := exec.Command(codexExecutable(), "plugin", "remove", "browser-bridge@"+s.Marketplace)
		if out, e := cmd.CombinedOutput(); e != nil {
			return nil, fmt.Errorf("请先在 Codex 中卸载本插件：%s；%v", out, e)
		}
	}
	if e = unregisterHost(filepath.Join(root, HostName+".json")); e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	_, _ = RPC(ctx, "uninstaller", "service.shutdown", Input{})
	cancel()
	time.Sleep(200 * time.Millisecond)
	catalog, plugin := personalPaths()
	if s.PluginPath == plugin {
		if _, e = os.Stat(filepath.Join(plugin, ".browser-bridge-owned")); e == nil {
			market, e := readMarketplace(catalog)
			if e != nil {
				return nil, e
			}
			remaining := []any{}
			for _, p := range market["plugins"].([]any) {
				entry, ok := p.(map[string]any)
				if !ok || entry["name"] != "browser-bridge" {
					remaining = append(remaining, p)
				}
			}
			market["plugins"] = remaining
			if e = writeJSON(catalog, market); e != nil {
				return nil, e
			}
			if within(filepath.Dir(filepath.Dir(plugin)), plugin) {
				if e = os.RemoveAll(plugin); e != nil {
					return nil, e
				}
			}
		}
	}
	pending := []string{}
	for _, name := range []string{"extension", "releases", HostName + ".json", "installation.json", ".browser-bridge-owned"} {
		p := filepath.Join(root, name)
		if !within(root, p) {
			return nil, fail("UNSAFE_PATH", "拒绝越界删除")
		}
		if e = os.RemoveAll(p); e != nil {
			pending = append(pending, p)
		}
	}
	return map[string]any{"uninstalled": true, "preservedDataDirectory": root, "pendingRemoval": pending, "nextStep": "在 Chrome 扩展管理中移除Chrome 操作助手。任务数据库和导出资料保留，确认不再需要时可自行删除。"}, nil
}
func Doctor(outPath string) (map[string]any, error) {
	root := localipc.DataDir()
	checks := map[string]any{"product": "browser-bridge", "version": AppVersion, "protocol": wire.Version, "os": runtime.GOOS, "architecture": runtime.GOARCH, "extensionId": ExtensionID, "checkedAt": time.Now().UTC().Format(time.RFC3339), "containsPageContent": false, "containsCredentials": false}
	checks["dataDirectory"] = root
	checks["extensionDirectory"] = filepath.Join(root, "extension")
	suggestions := []string{}
	_, e := os.Stat(filepath.Join(root, HostName+".json"))
	checks["nativeManifestPresent"] = e == nil
	checks["nativeHostRegistered"] = hostRegistered(filepath.Join(root, HostName+".json"))
	if !checks["nativeHostRegistered"].(bool) {
		suggestions = append(suggestions, "运行本产品安装工具注册当前用户的 Native Messaging host。")
	}
	_, plugin := personalPaths()
	_, e = os.Stat(filepath.Join(plugin, ".mcp.json"))
	checks["codexPluginConfigurationPresent"] = e == nil
	checks["chromeDetected"] = chromeDetected()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	c, e := connect(ctx, false)
	cancel()
	checks["localServiceReachable"] = e == nil
	if e == nil {
		c.Close()
		ctx, done := context.WithTimeout(context.Background(), 5*time.Second)
		resp, e := RPC(ctx, "doctor", "connection.status", Input{})
		done()
		if e == nil {
			var v map[string]any
			_ = decode(resp.Result, &v)
			profiles, _ := v["profiles"].([]any)
			checks["connectedProfiles"] = len(profiles)
			checks["protocolCompatible"] = v["protocol"] == float64(wire.Version)
			checks["serviceVersion"] = v["version"]
			extensionVersions := []string{}
			componentsMatch := len(profiles) > 0 && v["version"] == AppVersion
			for _, item := range profiles {
				profile, _ := item.(map[string]any)
				details, _ := profile["details"].(map[string]any)
				version, _ := details["extensionVersion"].(string)
				extensionVersions = append(extensionVersions, version)
				ready, _ := extensionReadiness(wire.Raw(details))
				if !ready {
					componentsMatch = false
				}
			}
			checks["extensionVersions"] = extensionVersions
			checks["componentsMatch"] = componentsMatch
			if len(profiles) > 0 && !componentsMatch {
				suggestions = append(suggestions, "扩展版本或实际能力不匹配：请到 chrome://extensions/ 关闭再开启 Chrome 操作助手，然后在智能体中检查连接；只刷新网页或点击面板重新连接不会更新后台程序。")
			}
			if len(profiles) == 0 {
				suggestions = append(suggestions, "在 Chrome 中加载扩展目录，打开扩展界面并点击重新连接。")
			}
		}
	} else {
		suggestions = append(suggestions, "打开已加载扩展的 Chrome；本机服务会按需启动。")
	}
	if runtime.GOOS == "darwin" {
		checks["realDeviceAcceptance"] = "待实机验收"
	}
	checks["suggestions"] = suggestions
	if outPath != "" {
		if !filepath.IsAbs(outPath) {
			return nil, fail("INVALID_PATH", "诊断包路径必须是绝对路径")
		}
		f, e := os.Create(outPath)
		if e != nil {
			return nil, e
		}
		z := zip.NewWriter(f)
		entry, e := z.Create("diagnostics.json")
		if e == nil {
			_, e = entry.Write(wire.Raw(checks))
		}
		ze := z.Close()
		fe := f.Close()
		if e != nil {
			return nil, e
		}
		if ze != nil {
			return nil, ze
		}
		if fe != nil {
			return nil, fe
		}
		checks["diagnosticPackage"] = outPath
	}
	return checks, nil
}
