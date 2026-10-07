package app

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"browser-bridge/internal/localipc"
	"browser-bridge/internal/wire"
	"time"
)

func connect(ctx context.Context, autoStart bool) (net.Conn, error) {
	c, e := localipc.Dial(ctx)
	if e == nil || !autoStart {
		return c, e
	}
	exe, e := os.Executable()
	if e != nil {
		return nil, e
	}
	if e = localipc.EnsureDir(); e != nil {
		return nil, e
	}
	if e = localipc.StartDetached(exe, "broker"); e != nil {
		return nil, e
	}
	for i := 0; i < 40; i++ {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
		c, e = localipc.Dial(ctx)
		if e == nil {
			return c, nil
		}
	}
	return nil, fmt.Errorf("本机服务未能启动：%w", e)
}
func RPC(ctx context.Context, owner, method string, in Input) (wire.Message, error) {
	c, e := connect(ctx, true)
	if e != nil {
		return wire.Message{}, e
	}
	defer c.Close()
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-ctx.Done():
			c.Close()
		case <-finished:
		}
	}()
	deadline := time.Now().Add(65 * time.Second)
	if in.TimeoutSeconds > 60 {
		deadline = time.Now().Add(time.Duration(in.TimeoutSeconds+5) * time.Second)
	}
	if d, ok := ctx.Deadline(); ok {
		deadline = d
	}
	_ = c.SetDeadline(deadline)
	m := request(method, in)
	m.Client = owner
	m.Deadline = deadline.UnixMilli()
	if e = (&wire.Writer{W: c}).Write(m); e != nil {
		return m, e
	}
	resp, e := (&wire.Reader{R: c}).Read()
	if e != nil {
		return resp, &wire.Error{Code: "IPC_DISCONNECTED", Message: "本机通信中断；修改结果不明，不得自动重放。", Uncertain: isMutation(method)}
	}
	if resp.ID != m.ID {
		return resp, fail("RESPONSE_MISMATCH", "响应编号不匹配")
	}
	if resp.Error != nil {
		return resp, resp.Error
	}
	return resp, nil
}
func RunNative(origin string) error {
	if origin != "chrome-extension://"+ExtensionID+"/" {
		return fail("INVALID_EXTENSION", "拒绝非本产品扩展连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	c, e := connect(ctx, true)
	cancel()
	if e != nil {
		return e
	}
	defer c.Close()
	// Go's os.Stdin/os.Stdout use binary I/O on Windows. Never print logs to stdout here.
	nr := &wire.Reader{R: os.Stdin}
	hello, e := nr.Read()
	if e != nil {
		return e
	}
	if hello.Kind != "hello" || hello.Method != "native" || len(hello.Profile) > 80 {
		return fail("INVALID_HELLO", "扩展握手无效")
	}
	cw := &wire.Writer{W: c}
	if e = cw.Write(hello); e != nil {
		return e
	}
	done := make(chan error, 2)
	go func() {
		for {
			m, e := nr.Read()
			if e == nil {
				e = cw.Write(m)
			}
			if e != nil {
				done <- e
				return
			}
		}
	}()
	go func() {
		r := &wire.Reader{R: c}
		w := &wire.Writer{W: os.Stdout}
		for {
			m, e := r.Read()
			if e == nil {
				e = w.Write(m)
			}
			if e != nil {
				done <- e
				return
			}
		}
	}()
	e = <-done
	if e == io.EOF || strings.Contains(fmt.Sprint(e), "closed") {
		return nil
	}
	return e
}
