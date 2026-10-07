# 架构与开发说明

```text
Codex 任务 A / B
   │ 每任务一个 MCP stdio 进程，官方 Go MCP SDK
   │ 当前用户命名管道（Windows）/ 0600 Unix socket（macOS）
Go broker ── SQLite：会话、操作记录、批量进度及正文
   │ 同一用户 IPC，按 profileId 路由
Go native host（Chrome 启动，stdin/stdout 二进制帧）
   │ Chrome Native Messaging
MV3 service worker ── 独立任务标签组、全网站访问、停止 UI
   │ chrome.scripting + 受限 chrome.debugger 内部命令
普通网页 / 可访问的嵌入页面
```

## 目录与进程

- `cmd/browser-bridge`：单一程序的模式分发。
- `internal/wire`：4字节小端长度 + JSON、协议版本、上限、分块。
- `internal/localipc`：Windows 当前用户 SID 的命名管道 ACL；Mac 私有目录、socket 和启动文件锁。
- `internal/app`：broker、MCP、SQLite、批量采集、安装和诊断。
- `extension/src`：TypeScript service worker、隔离世界页面脚本与中文 UI。
- `scripts`：构建和打包；`tests`：独立测试页面与真实 MCP 客户端。

`native` 模式根据 Chrome 传入的扩展 origin 启动，只接受本产品固定 ID。`mcp` 和 native 按需启动 broker。没有监听 localhost HTTP 端口，也没有网络云端控制服务。服务代码不会读取 HTTP_PROXY 等代理变量。

## 消息与失败语义

每条请求带 version、requestId、sessionId、deadline。单帧上限512KiB，分块原始片段192KiB，组装消息上限24MiB；超过上限、顺序错误、截断、嵌套分块或版本不兼容均报错。写端加锁，分块不会交错。

修改操作在 SQLite 中先登记 pending，再发往浏览器。正常结果或明确错误写入 done；断线/超时结果带 uncertain。重启后 pending 保持不明状态，绝不自动重放。批量 items 的 running 状态恢复为 queued，取消和停止状态保留。

扩展使用连接代数取消旧连接排队请求。每个网页文档有随机文档号、观察编号和元素映射，动作前核对目标签名及可见位置；截图另绑定布局摘要、缩放、滚动和原图尺寸。Chrome 完全重启后 chrome.storage.session 标识变化，旧标签页归属被清空，防止数字 ID 重用导致串页。

Chrome 标签管理接口有短暂忙碌状态，因此创建、分组、关闭标签的结构修改串行；仅对明确“尚未执行”的忙碌拒绝做短暂退避。页面加载和读取仍按3个 worker并发。页面提交、文件上传不做此重试。

## 权限与数据

Chrome 声明 nativeMessaging、storage、tabs、tabGroups、scripting、webNavigation、webRequest、debugger、downloads、alarms 权限；站点权限声明为必需的 `http://*/*` 和 `https://*/*`。所有普通网站默认可访问，扩展与任务均不维护网站白名单，也不内置域名黑名单。旧 origins 参数和记录不再限制访问，Chrome 自身的权限限制、URL 校验和站点明确拒绝仍生效。

Chrome debugger 的内部固定命令支持无障碍信息、原生输入、截图、弹窗与文件选择，使用 Chrome 125+ 子会话处理跨进程框架。公开接口不接收任意 CDP/JS。页面正文由隔离脚本读取可见结构，敏感输入不返回；截图同时通过 DOM 与后端节点遮盖敏感控件，覆盖封闭组件。受保护页面和实际策略拒绝明确报错。

当前用户是本机安全边界：本产品不试图防御同一操作系统用户下的恶意本机程序。批量原文保存在成员本地数据库中，不包含在诊断包内。文件授权按解析符号链接后的具体普通文件路径匹配；不接受目录通配符。导出 CSV 处理公式前缀。

## 测试

`go test ./...` 覆盖协议分块、截断、版本不符、部分写入、重复请求、修改超时、停止、会话隔离、文件授权、SQLite 读取恢复、查询参数与导出。`npm run typecheck` 检查 Chrome API 和 TypeScript 类型。

`node tests/e2e.mjs --advanced` 使用26个正式 MCP 工具与隔离 Chromium 实例，包含自定义菜单、Shadow DOM、图表、四种截图、多个缩放比例、拖拽、键盘、弹窗、原生文件选择、导出关联，以及原有批量100链接、停止、恢复与代理环境差异。测试仅访问本机 fixture；框架负责启动、下载测试设置、缩放与故障注入，页面动作均通过本产品 MCP。

测试注册本产品独立 host，不修改其他浏览器产品的 host。每次测试后需运行正式安装器恢复本产品的正式 host 路径。测试环境、中间报告与 Chrome 配置位于 `test-results`，不要交付这些原始配置文件。

## 跨平台构建

先 `npm ci && npm run build`，然后使用 `CGO_ENABLED=0` 分别设置 GOOS/GOARCH：windows/amd64、darwin/arm64、darwin/amd64。SQLite 使用 pure-Go 实现，成员不需要数据库驱动或 Go 运行时。

构建命令核心：`go build -trimpath -ldflags="-s -w" -o <目标路径> ./cmd/browser-bridge`。开发生成物 `identity.go` 与扩展使用同一固定公钥计算 ID。

`node scripts/package.mjs` 生成各平台安装目录、归档、源码包、依赖许可证和 SHA256 清单。Mac 构建成功只说明交叉编译成功；尚需真实 Mac 的 Native Messaging、权限、截图、上传下载和 Gatekeeper 验收。

## 安装布局

安装器按包内容摘要创建 releases 目录、保留上一版本，并将活动扩展复制到稳定的 extension 路径。个人插件源使用标记文件验证归属，首次安装才追加 marketplace 条目；更新不替换其他条目。MCP 配置中的程序路径由安装器按成员本机路径生成。

Windows 注册只写 HKCU 的本产品键。macOS host manifest 只放当前用户的 Google Chrome/NativeMessagingHosts 目录。卸载有产品归属和路径范围检查；任务正文与导出资料默认保留。
