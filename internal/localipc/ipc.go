package localipc

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

const AppName = "browser-bridge"

func DataDir() string {
	if s := os.Getenv("TBB_DATA_DIR"); s != "" {
		p, _ := filepath.Abs(s)
		return p
	}
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "windows" {
		// A packaged MCP client can redirect LocalAppData into its private MSIX
		// cache. A user-profile directory is visible to both that client and
		// the ordinary Chrome process that launches the native host.
		return filepath.Join(home, "BrowserBridge")
	}
	return filepath.Join(home, "Library", "Application Support", "BrowserBridge")
}
func EnsureDir() error { return os.MkdirAll(DataDir(), 0700) }
func Key() string      { s := sha256.Sum256([]byte(DataDir())); return fmt.Sprintf("%x", s[:12]) }
func StartDetached(exe string, args ...string) error {
	cmd := exec.Command(exe, args...)
	setDetached(cmd)
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
