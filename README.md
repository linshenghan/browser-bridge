# Chrome 操作助手 v0.2.1

独立 Chrome 扩展 + Go 本机服务 + Codex MCP 插件。适用于团队内部试用，界面为简体中文。每位成员连接自己电脑的 Chrome，复用该配置文件的登录状态。

扩展固定 ID：`omheddjpegohbakodeeikcjenjgenmfj`。Native Messaging host：`com.browser_bridge.native`。Codex 插件：`browser-bridge`，MCP 服务：`browser_bridge`。

WorkBuddy、Claude Code 和 Claude Desktop 的本地 MCP 也可以接入同一本机服务。包内提供“仅安装浏览器组件”和“导出MCP配置”工具，接入方式与实机验证状态见 `docs/其他智能体接入.md`。

## v0.2.1 多会话窗口隔离

新增独立任务窗口、窗口归属校验、后台输入与截图、前台操作队列及“查看任务窗口”按钮。升级后需要重新加载扩展，connection_status 应同时显示服务和扩展为 0.2.1，并包含 session-windows、background-input。扩展重载后需新建任务或使用原任务恢复凭据恢复；不按旧标签编号接管私人页面。

## 从 v0.1.x 升级

本次更新增加自定义菜单识别、四种截图、视觉坐标操作、鼠标键盘、拖拽、网页弹窗、已有页面接管和网页导出文件跟踪。默认开放所有普通网站，最低 Chrome 版本为 125。重新运行安装工具，然后到 `chrome://extensions/` 重新加载“Chrome 操作助手”。请让智能体检查连接：应显示 v0.2.0、八项能力且 upgradeRequired=false；面板只显示版本不能单独证明后台已更新。若仍提示升级，在扩展管理页将本扩展开关关闭再打开。刷新网页或面板“重新连接”不能代替更新后台程序。

## 安装和第一次使用

### Windows 10/11 x64

安装目录使用 `%USERPROFILE%\BrowserBridge`，通常为 `C:\Users\Administrator\BrowserBridge`。这能让普通 Chrome 和智能体看到同一份文件，避免打包应用对 AppData 的重定向。

1. 解压 Windows 安装包到普通文件夹，双击 `安装-Windows.cmd`。安装为当前用户执行，无需管理员权限，也无需 Node.js 或 Go。程序会注册本产品的 Native Messaging host，并使用已安装的 Codex 配置个人插件目录。
2. 在 Chrome 地址栏打开 `chrome://extensions/`，开启开发者模式，选择“加载已解压的扩展程序”。选择安装程序输出的 `extensionDirectory`，通常为 `%USERPROFILE%\BrowserBridge\extension`。
3. 固定“Chrome 操作助手”扩展，打开界面，确认显示“本机服务已连接”。网站访问默认为所有普通 HTTP/HTTPS 网站，无需逐个添加。安装或升级时如 Chrome 提示访问所有网站，确认扩展权限后即可使用。
4. 新建一个 Codex 任务，输入：**使用 Chrome 操作助手检查连接，然后读取我提供的网站。** 新安装工具需要在新任务中加载。
5. 如未连接，在解压目录双击 `自检-Windows.cmd`。诊断包仅含版本、安装和连接状态，不含网页正文、Cookie 或密码。

### macOS Apple Silicon / Intel

选择对应架构的安装包：Apple Silicon 为 arm64，Intel 为 amd64。解压后先阅读 `安装-macOS.sh`，在终端进入解压目录并运行：

```sh
/bin/bash ./安装-macOS.sh
```

安装在 `~/Library/Application Support/BrowserBridge`。随后在 Chrome 的开发者模式加载其中的 `extension` 文件夹，确认 Chrome 的扩展权限，再新建 Codex 任务。

这是未经过 Developer ID 签名和公证的内部开发构建。macOS 可能要求用户自行确认来源或批准运行；请遵循系统提示和团队管理要求。包内不提供关闭 Gatekeeper、移除隔离标记或绕过企业策略的脚本。实机验收状态见 `验收报告.md` 和 `Mac实机验收清单.md`。

若 Codex 插件配置失败，浏览器组件会保留安装结果。安装最新版 Codex 或将 Codex CLI 加入 PATH 后重新运行安装程序；也可通过 `CODEX_CLI_PATH` 指定本机 Codex 可执行文件。不要把错误提示中的 `codexInstalled: false` 当作安装完整成功。

## 可以完成的工作

- 网页观察：可见正文、链接、HTML/ARIA 表格、标准与自定义控件、Shadow DOM 和可访问的多层嵌入页面；虚拟列表只返回已加载范围。
- 截图：当前可见区域、整页、框选区域、指定元素，返回可供智能体查看的图片与 PNG 文件。超长页面分段并标明续读位置。扩展界面可手动截图，平时不在后台持续截屏。
- 网页动作：单击、双击、右键、悬停、输入、组合键、勾选、选择、容器滚动、文本选择、拖拽、历史导航和提交。每次动作引用观察版本；无关计时更新不让所有目标失效。
- 标签页：接管用户指定的已有页面，跟踪本任务打开的新页面。任务结束保留接管页面，释放控制权。
- 文件：上传本任务授权的具体文件，支持文件选择按钮；链接下载和网页导出均可返回任务所属文件路径。归属不明确时报告错误。
- 批量采集：一次 1–100 个用户提供的链接，默认并发 3，每页 45 秒；读取失败最多再试两次。链接去重、保留查询参数，记录失败原因并继续处理其余链接。
- 导出：JSONL、适合 Excel 打开的 UTF-8 CSV，以及每页一份 Markdown。分析、总结和报告制作由 Codex 继续完成。

插件公开 26 个 MCP 工具，完整说明见 `docs/API.md`。没有任意 JavaScript 执行或原始 CDP 接口。优先读取页面结构；图表、画布、图片或无法辨认的控件按需截图，再由调用插件的智能体理解图片。

## 授权、停止和恢复

默认允许访问所有普通网站，不再维护扩展或任务的网站白名单，也不内置域名黑名单。Chrome 自身的网站访问限制仍然生效；浏览器受保护页面和明确拒绝操作的目标仍不可用。上传文件只接受本任务明确指定的绝对路径，不接受整个磁盘或目录授权。不要将密码、验证码或登录凭据交给插件；请自行完成登录。

每个 Codex 任务默认创建一个不抢前台的独立 Chrome 窗口，窗口首页和标签组显示任务名称。session_start、tab_open、tabs_list 返回 windowId。普通截图与点击、输入、滚动按目标标签页在后台执行；仅 tab_focus、插件面板“查看任务窗口”和手动框选截图会请求前台，前台操作统一排队。接管的已有页面移入本任务窗口，其他活动任务窗口内的页面不可接管。手动移出任务窗口的页面返回 WINDOW_ISOLATION，须移回或重新明确接管。任务结束只关闭任务创建的页面及任务首页，保留接管或释放的页面。独立窗口共享当前 Chrome 配置文件的登录状态，不提供账号隔离。修改同一标签页的动作串行执行。点击扩展的“停止任务”会阻止后续排队动作，但不能撤回已发送给网站的操作。普通已授权保存、提交按任务执行；付款、权限变更等遵循 Codex 适用的确认规则。

提交、上传、下载等操作使用唯一 operationId 防止重复。遇到超时或断线，先观察实际页面，不换编号自动重放。后台数据库只恢复未完成的**读取任务**。停止的任务不能恢复执行；失败读取可显式重试。MCP 进程重启后，原任务可用其 resumeToken 恢复会话；该凭据不要交给其他任务。

Chrome 完全退出或扩展重新加载后，旧标签页编号会作废。本产品不会凭旧编号接管恢复出的私人页面。未完成的批量读取会创建新的任务标签页；浏览器自行恢复的旧页面可由成员手动关闭。

## 本地文件和隐私

Windows 数据目录为 `%USERPROFILE%\BrowserBridge`，Mac 为 `~/Library/Application Support/BrowserBridge`。其中保存 SQLite 任务进度、操作去重记录和版本目录。批量正文可能含业务资料，保留在本机任务数据库中；不自动上传到云端。诊断包不包含这些正文。

如果任务未指定输出目录，导出和截图保存在产品数据目录下的 `results`。浏览器下载保存在 Chrome 当前下载目录的 `BrowserBridge/<会话编号>/`；由 `download_status` 返回实际路径。网页导出先登记 `download_expect`，再点击一次，按页面事件与下载记录关联。一次配置文件只保留一个待关联的导出动作；其他任务仍可正常读取页面。

个人 Codex 插件目录为 `~/plugins/browser-bridge`，入口追加到 `~/.agents/plugins/marketplace.json`。安装器保留其他插件条目，遇到同名但不属于本产品的目录会停止覆盖。

## 更新、回滚和卸载

手动解压新版并重新运行安装程序；任务记录、配置文件标识与固定扩展 ID 保留。安装完成后在 Chrome 扩展管理页点击本扩展“重新加载”，并新建 Codex 任务。每个安装包按内容摘要保留独立版本，上一版本可回滚。

需要回滚时，在解压目录运行 `browser-bridge.exe rollback`（Mac 使用 `./browser-bridge rollback`），随后重新加载 Chrome 扩展。第一次安装没有上一版本。

卸载请从**解压包目录**运行 `卸载-Windows.cmd` 或 `/bin/bash ./卸载-macOS.sh`，再在 Chrome 扩展管理中移除本扩展。卸载仅处理本产品注册项、插件条目与安装文件；数据库和导出资料保留。若进程占用使文件未能删除，结果会列出 `pendingRemoval`，关闭本产品 Chrome 扩展和相关任务后再处理这些明确列出的文件。

## v0.2 的使用边界

- 新任务实测中，小红书首页“发布”文字单击可能不跳转，数据看板文字单击可能不展开。应先核实结果，再用页面已经返回的可见链接导航，或新截图中的展开箭头。这些都使用本插件公开工具；不自动重放结果不明的提交、上传或导出，也不切换通道绕过拒绝。
- 这是内部解压加载流程，不是商店发布版；不含团队账号、云控制台、自动更新、签名或公证。
- 不支持浏览器设置页、扩展商店等受保护页面。画布通过截图理解；可见但没有可用语义信息的复杂组件使用截图坐标。没有通用的网页无限滚动或整站爬取。
- 浏览器可能显示“正在调试此浏览器”的正常控制提示。关闭该提示或取消控制会停止任务；插件不会偷偷重新接管。跨进程框架之间的拖拽明确返回限制。
- 截图会遮盖常见密码/验证码输入框；包含无法访问或明确拒绝的嵌入区域时拒绝截图。网页其他位置显示的业务资料仍可能出现在截图中。
- 不绕过宿主或站点明确拒绝。插件本身不再内置任何域名黑名单，站点是否可用只取决于 Chrome 权限与站点反馈。
- 本机连接不经过 HTTP 代理。Chrome 打开外部网站仍受成员网络、代理和站点本身影响。

## 源码开发

需要 Go 1.25.5+ 和 Node.js 22+；这些仅开发者需要。安装包使用独立二进制，普通成员不需要安装开发环境。

打包脚本使用 Python 3；高级截图像素回归还需要 Pillow。安装/卸载回归与浏览器回归共享本产品的 Native Messaging 注册项，必须顺序执行。

```text
npm ci
npm run typecheck
npm run build
go test ./...
go build -trimpath -ldflags="-s -w" -o bin/browser-bridge.exe ./cmd/browser-bridge
node tests/e2e.mjs --concurrency --advanced
```

E2E 使用本机自有 HTTP 验收页面、独立 Chromium 配置文件和正式 MCP stdio 协议。测试会临时注册本产品 Native Messaging host；测试后重新运行正式安装器恢复正式注册路径。可通过 `TBB_TEST_CHROME` 指定用于扩展开发的 Chromium / Chrome for Testing 可执行文件。普通 Chrome 正式版可能不接受命令行加载扩展，应采用前述手动加载步骤。

完整结构、协议、测试与构建方法见 `docs/ARCHITECTURE.md`。务必保留 `extension/public-key.txt`；更换它会更换扩展 ID。源码不包含签名私钥。第三方组件许可证见安装包 `third-party-licenses/`。

参考：[Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)、[Chrome 扩展分发](https://developer.chrome.com/docs/extensions/how-to/distribute)、[官方 MCP Go SDK](https://github.com/modelcontextprotocol/go-sdk)。
