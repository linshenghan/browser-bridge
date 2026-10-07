//go:build windows

package localipc

import (
	"context"
	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
	"net"
	"os/exec"
	"syscall"
)

func Address() string                            { return `\\.\pipe\browser-bridge-` + Key() }
func Dial(ctx context.Context) (net.Conn, error) { return winio.DialPipeContext(ctx, Address()) }
func Listen() (net.Listener, error) {
	token, e := windows.OpenCurrentProcessToken()
	if e != nil {
		return nil, e
	}
	defer token.Close()
	u, e := token.GetTokenUser()
	if e != nil {
		return nil, e
	}
	return winio.ListenPipe(Address(), &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;" + u.User.Sid.String() + ")", InputBufferSize: 65536, OutputBufferSize: 65536})
}
func setDetached(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
