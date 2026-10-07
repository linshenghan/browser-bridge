package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"browser-bridge/internal/localipc"
)

// MCPConfig exports a portable stdio definition, without modifying other clients.
func MCPConfig() (map[string]any, error) {
	binary, e := os.Executable()
	if e != nil {
		return nil, e
	}
	if b, e := os.ReadFile(filepath.Join(localipc.DataDir(), "installation.json")); e == nil {
		var s installation
		if json.Unmarshal(b, &s) == nil && within(filepath.Join(localipc.DataDir(), "releases"), s.Current) {
			candidate := filepath.Join(s.Current, exeName())
			if _, e := os.Stat(candidate); e == nil {
				binary = candidate
			}
		}
	}
	return map[string]any{"mcpServers": map[string]any{"browser_bridge": map[string]any{"type": "stdio", "command": binary, "args": []string{"mcp"}}}}, nil
}
