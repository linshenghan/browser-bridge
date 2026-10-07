//go:build !windows

package app

import (
	"encoding/json"
	"os"
	"path/filepath"
)

func macHostPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", HostName+".json")
}
func registerHost(path string) error { return copyFile(path, macHostPath(), 0600) }
func hostRegistered(path string) bool {
	a, e := os.ReadFile(path)
	if e != nil {
		return false
	}
	b, e := os.ReadFile(macHostPath())
	if e != nil {
		return false
	}
	var x, y map[string]any
	_ = json.Unmarshal(a, &x)
	_ = json.Unmarshal(b, &y)
	return x["path"] == y["path"] && y["name"] == HostName
}
func unregisterHost(path string) error {
	if !hostRegistered(path) {
		return nil
	}
	return os.Remove(macHostPath())
}
func chromeDetected() bool {
	_, e := os.Stat("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
	if e == nil {
		return true
	}
	h, _ := os.UserHomeDir()
	_, e = os.Stat(filepath.Join(h, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))
	return e == nil
}
