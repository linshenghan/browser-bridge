//go:build !windows

package localipc

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

func Address() string { return filepath.Join(DataDir(), "bridge.sock") }
func Dial(ctx context.Context) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", Address())
}
func Listen() (net.Listener, error) {
	if err := EnsureDir(); err != nil {
		return nil, err
	}
	// A file lock protects stale socket cleanup from competing starts.
	f, e := os.OpenFile(filepath.Join(DataDir(), "broker.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, e
	}
	c, e := net.DialTimeout("unix", Address(), 100*time.Millisecond)
	if e == nil {
		c.Close()
		f.Close()
		return nil, os.ErrExist
	}
	os.Remove(Address())
	l, e := net.Listen("unix", Address())
	if e != nil {
		f.Close()
		return nil, e
	}
	os.Chmod(Address(), 0600)
	return &lockedListener{Listener: l, lock: f}, nil
}

type lockedListener struct {
	net.Listener
	lock *os.File
}

func (l *lockedListener) Close() error { e := l.Listener.Close(); l.lock.Close(); return e }
func setDetached(c *exec.Cmd)          { c.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
