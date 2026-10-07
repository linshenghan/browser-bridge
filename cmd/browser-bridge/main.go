package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"browser-bridge/internal/app"
	"time"
)

func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func output(v any, e error) error {
	if e != nil {
		return e
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
func run() error {
	args := os.Args[1:]
	for _, a := range args {
		if strings.HasPrefix(a, "chrome-extension://") {
			return app.RunNative(a)
		}
	}
	if len(args) == 0 {
		fmt.Println("Chrome 操作助手 v" + app.AppVersion + "\n命令：install / doctor / rollback / uninstall / mcp / broker / version\n首次安装：browser-bridge install --source <安装包目录>")
		return nil
	}
	switch args[0] {
	case "mcp-config":
		return output(app.MCPConfig())
	case "version":
		return output(map[string]any{"version": app.AppVersion, "extensionId": app.ExtensionID}, nil)
	case "broker":
		return app.RunBroker()
	case "mcp":
		return app.RunMCP()
	case "install":
		flags := flag.NewFlagSet("install", flag.ContinueOnError)
		exe, _ := os.Executable()
		src := flags.String("source", filepath.Dir(exe), "安装包目录")
		skip := flags.Bool("skip-codex", false, "仅安装浏览器组件，用于隔离测试")
		if e := flags.Parse(args[1:]); e != nil {
			return e
		}
		return output(app.Install(*src, *skip))
	case "doctor":
		flags := flag.NewFlagSet("doctor", flag.ContinueOnError)
		out := flags.String("output", "", "诊断 ZIP 的绝对路径")
		if e := flags.Parse(args[1:]); e != nil {
			return e
		}
		return output(app.Doctor(*out))
	case "rollback":
		return output(app.Rollback())
	case "uninstall":
		return output(app.Uninstall())
	case "stop-service":
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		r, e := app.RPC(ctx, "command", "service.shutdown", app.Input{})
		return output(r, e)
	default:
		return fmt.Errorf("未知命令 %s", args[0])
	}
}
