package localipc

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDataDirectorySharedWithOrdinaryChrome(t *testing.T) {
	t.Setenv("TBB_DATA_DIR", "")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, "Library", "Application Support", "BrowserBridge")
	if runtime.GOOS == "windows" {
		want = filepath.Join(home, "BrowserBridge")
		t.Setenv("LOCALAPPDATA", filepath.Join(t.TempDir(), "private-msix-cache"))
	}
	if got := DataDir(); got != want {
		t.Fatalf("Chrome and MCP must share the visible data directory: got %q, want %q", got, want)
	}
}

func TestDataDirectoryOverride(t *testing.T) {
	want := t.TempDir()
	t.Setenv("TBB_DATA_DIR", want)
	if got := DataDir(); got != want {
		t.Fatalf("isolated test data directory: got %q, want %q", got, want)
	}
}
