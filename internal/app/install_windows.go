//go:build windows

package app

import (
	"golang.org/x/sys/windows/registry"
	"os"
	"path/filepath"
)

const regPath = `Software\Google\Chrome\NativeMessagingHosts\` + HostName

func registerHost(path string) error {
	k, _, e := registry.CreateKey(registry.CURRENT_USER, regPath, registry.SET_VALUE)
	if e != nil {
		return e
	}
	defer k.Close()
	return k.SetStringValue("", path)
}
func hostRegistered(path string) bool {
	k, e := registry.OpenKey(registry.CURRENT_USER, regPath, registry.QUERY_VALUE)
	if e != nil {
		return false
	}
	defer k.Close()
	v, _, e := k.GetStringValue("")
	return e == nil && v == path
}
func unregisterHost(path string) error {
	if !hostRegistered(path) {
		return nil
	}
	return registry.DeleteKey(registry.CURRENT_USER, regPath)
}
func chromeDetected() bool {
	for _, root := range []string{os.Getenv("PROGRAMFILES"), os.Getenv("PROGRAMFILES(X86)"), os.Getenv("LOCALAPPDATA")} {
		if _, e := os.Stat(filepath.Join(root, "Google", "Chrome", "Application", "chrome.exe")); e == nil {
			return true
		}
	}
	k, e := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe`, registry.QUERY_VALUE)
	if e == nil {
		k.Close()
		return true
	}
	return false
}
