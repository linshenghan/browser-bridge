import {
  BridgeError,
  Decoder,
  Message,
  VERSION,
  encode,
  errorOf,
  normalizedOrigin,
  pattern,
} from "./protocol";
import { Driver, capabilities } from "./driver";
type Session = {
  sessionId: string;
  name: string;
  origins: string[];
  tabs: number[];
  groupId?: number;
  windowId?: number;
  homeTabId?: number;
  stopped: boolean;
  progress?: any;
  claimed?: number[];
};
type Observation = {
  pageVersion: string;
  frames: Record<number, { version: string; url: string }>;
  ax?: Record<string, any>;
};
let port: chrome.runtime.Port | undefined;
let connected = false,
  lastError = "正在连接本机服务…",
  profileId = "",
  profileName = "我的 Chrome";
let sessions: Record<string, Session> = {},
  downloads: Record<number, string> = {};
const observations = new Map<number, Observation>(),
  queues = new Map<string, Promise<unknown>>(),
  cancelledJobs = new Set<string>();
const driver = new Driver((tabId) => {
  const s = Object.values(sessions).find(s => s.tabs.includes(tabId));
  if (s) { s.stopped = true; void save(); try { send({ version: VERSION, kind: "event", method: "session.stop", sessionId: s.sessionId }); } catch {} }
  observations.delete(tabId); shots.delete(tabId);
});
const shots = new Map<number, any>(), discoveries = new Map<string, any>(), popupWindows = new Map<number, number>();
const expectations = new Map<string, any>(), downloadEvents: any[] = [], downloadCandidates: any[] = [];
const directDownloads = new Map<string, { sessionId: string; filename: string }>();
const directFilenames = new Map<number, string>();
let lastScreenshot: any;
let retry: ReturnType<typeof setTimeout> | undefined;
let connectionGeneration = 0;
const requestGeneration = new WeakMap<Message, number>();
const windowJobs = new Map<string, Promise<number>>();
let foregroundQueue: Promise<unknown> = Promise.resolve();
function foreground<T>(action: () => Promise<T>): Promise<T> {
  const result = foregroundQueue.catch(() => {}).then(action);
  foregroundQueue = result;
  return result;
}
let tabEdits: Promise<unknown> = Promise.resolve();
function editTabs<T>(action: () => Promise<T>, m?: Message): Promise<T> {
  const result = tabEdits
    .catch(() => {})
    .then(async () => {
      for (let attempt = 0; ; attempt++) {
        if (m) alive(m, ["session.end", "tab.close"].includes(m.method || ""));
        if (m?.deadline && Date.now() >= m.deadline)
          throw new BridgeError("TIMEOUT", "标签页操作已过期");
        try {
          return await action();
        } catch (e) {
          if (
            attempt >= 5 ||
            !errorOf(e).message.includes("Tabs cannot be edited right now")
          )
            throw e;
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        }
      }
    });
  tabEdits = result;
  return result;
}
const navigationStatus = new Map<number, { status?: number; error?: string }>();
const commits = new Map<number, number>();
const committed = (d: { tabId: number; frameId: number }) => {
  if (d.frameId === 0) commits.set(d.tabId, (commits.get(d.tabId) || 0) + 1);
};
chrome.webNavigation.onCommitted.addListener(committed);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(committed);
const hasOwnedTab = (id: number) =>
  Object.values(sessions).some((s) => s.tabs.includes(id));
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.type === "main_frame" && hasOwnedTab(d.tabId))
      navigationStatus.set(d.tabId, { status: d.statusCode });
    return undefined;
  },
  { urls: ["http://*/*", "https://*/*"] },
);
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) navigationStatus.delete(d.tabId);
});
chrome.webNavigation.onErrorOccurred.addListener((d) => {
  if (d.error === "net::ERR_ABORTED" && downloadEvents.some(e => e.tabId === d.tabId && e.url === d.url && Date.now() - e.time < 5000)) return;
  if (d.frameId === 0 && hasOwnedTab(d.tabId))
    navigationStatus.set(d.tabId, { error: d.error });
});
function checkNavigation(tabId: number) {
  const status = navigationStatus.get(tabId);
  if (status?.error)
    throw new BridgeError("NAVIGATION_FAILED", "页面加载失败：" + status.error);
  if (status?.status && status.status >= 400)
    throw new BridgeError(
      status.status === 401 || status.status === 403
        ? "HOST_DENIED"
        : "HTTP_ERROR",
      `页面返回 HTTP ${status.status}`,
    );
}
const ready = (async () => {
  const s = (await chrome.storage.local.get([
    "profileId",
    "profileName",
    "sessions",
    "downloads",
  ])) as Record<string, any>;
  profileId = s.profileId || crypto.randomUUID();
  profileName = s.profileName || profileName;
  sessions = s.sessions || {};
  downloads = s.downloads || {};
  const lifetime = await chrome.storage.session.get("browserSession");
  if (!lifetime.browserSession) {
    // Tab IDs are not identities across browser restarts. Never reclaim restored private tabs.
    for (const task of Object.values(sessions)) {
      task.tabs = [];
      delete task.groupId;
      delete task.windowId;
      delete task.homeTabId;
      task.claimed = [];
    }
    await chrome.storage.session.set({ browserSession: crypto.randomUUID() });
    await chrome.storage.local.set({ sessions, downloads });
  }
  await chrome.storage.local.set({ profileId });
})();
let saveChain = Promise.resolve();
function save() {
  const value = JSON.parse(JSON.stringify({ sessions, downloads }));
  saveChain = saveChain.then(() => chrome.storage.local.set(value));
  return saveChain;
}
function send(m: Message) {
  if (!port) throw new BridgeError("BROWSER_DISCONNECTED", "本机连接已断开");
  for (const part of encode(m)) port.postMessage(part);
}
function connect() {
  if (port) return;
  connectionGeneration++;
  observations.clear();
  const decoder = new Decoder();
  try {
    const p = chrome.runtime.connectNative("com.browser_bridge.native");
    port = p;
    connected = false;
    send({
      version: VERSION,
      kind: "hello",
      method: "native",
      profileId,
      params: {
        name: profileName,
        extensionVersion: chrome.runtime.getManifest().version,
        backgroundBuild: self.location.pathname.split("/").at(-1),
        protocol: VERSION,
        capabilities,
        userAgent: navigator.userAgent,
        stoppedSessionIds: Object.values(sessions)
          .filter((s) => s.stopped)
          .map((s) => s.sessionId),
      },
    });
    p.onMessage.addListener((raw) => {
      try {
        const m = decoder.push(raw);
        if (m) void receive(m);
      } catch (e) {
        lastError = errorOf(e).message;
        p.disconnect();
      }
    });
    p.onDisconnect.addListener(() => {
      if (port !== p) return;
      lastError = chrome.runtime.lastError?.message || "连接断开，正在重连";
      if (port === p) port = undefined;
      connected = false;
      connectionGeneration++;
      observations.clear();
      if (retry) clearTimeout(retry);
      retry = setTimeout(connect, 2000);
    });
  } catch (e) {
    lastError = errorOf(e).message;
    port = undefined;
    retry = setTimeout(connect, 3000);
  }
}
void ready.then(connect);
chrome.alarms.create("bridge-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (!port) void ready.then(connect);
});
chrome.runtime.onStartup.addListener(() => void ready.then(connect));
chrome.runtime.onInstalled.addListener(() => void ready.then(connect));
function alive(m: Message, cleanup = false) {
  if (
    !cleanup &&
    requestGeneration.get(m) !== undefined &&
    requestGeneration.get(m) !== connectionGeneration
  )
    throw new BridgeError("CONNECTION_LOST", "原连接已中断，旧请求停止执行。");
  if (m.deadline && Date.now() >= m.deadline)
    throw new BridgeError("TIMEOUT", "操作已超过截止时间");
  const s = sessions[m.sessionId || ""];
  if (!s) throw new BridgeError("SESSION_NOT_FOUND", "任务不存在");
  if (!cleanup) {
    if (s.stopped) throw new BridgeError("SESSION_STOPPED", "任务已停止");
    if (m.params?.jobId && cancelledJobs.has(m.params.jobId))
      throw new BridgeError("JOB_CANCELLED", "批量任务已取消");
  }
  return s;
}
async function permitted(_s: Session, url: string) {
  const o = normalizedOrigin(url);
  if (!(await chrome.permissions.contains({ origins: [pattern(o)] })))
    throw new BridgeError(
      "BROWSER_PERMISSION_REQUIRED",
      `Chrome 尚未允许访问 ${o}，请在扩展管理中确认本扩展的所有网站访问权限。`,
    );
}
async function owned(m: Message, cleanup = false) {
  const s = alive(m, cleanup);
  const id = Number(m.params?.tabId);
  if (!s.tabs.includes(id))
    throw new BridgeError("SESSION_ISOLATION", "该标签页不属于当前任务");
  const tab = await chrome.tabs.get(id);
  if (!cleanup && tab.windowId !== s.windowId)
    throw new BridgeError("WINDOW_ISOLATION", "页面已移出本任务窗口，请移回或重新明确接管该页面");
  if (!cleanup) await permitted(s, tab.url || "");
  alive(m, cleanup);
  return tab;
}
function windowOwner(windowId: number, except?: string) {
  return Object.values(sessions).find(s => !s.stopped && s.sessionId !== except && s.windowId === windowId);
}
async function taskWindow(m: Message): Promise<number> {
  const s = alive(m);
  const pending = windowJobs.get(s.sessionId);
  if (pending) return pending;
  const job = (async () => {
    if (s.windowId !== undefined) {
      const w = await chrome.windows.get(s.windowId).catch(() => undefined);
      if (w && !windowOwner(w.id!, s.sessionId)) return w.id!;
      delete s.windowId; delete s.groupId; delete s.homeTabId;
    }
    const url = chrome.runtime.getURL("window.html") + "?" + new URLSearchParams({ name: s.name, session: s.sessionId });
    const w = await editTabs(() => chrome.windows.create({ url, type: "normal", focused: false, width: 1280, height: 900 }), m);
    if (w?.id === undefined) throw new BridgeError("WINDOW_UNAVAILABLE", "无法创建任务窗口");
    s.windowId = w.id;
    s.homeTabId = w.tabs?.[0]?.id;
    await save();
    return w.id;
  })();
  windowJobs.set(s.sessionId, job);
  try { return await job; } finally { windowJobs.delete(s.sessionId); }
}
async function groupTaskTab(s: Session, tabId: number, m?: Message) {
  if (s.stopped) throw new BridgeError("SESSION_STOPPED", "任务已停止");
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== s.windowId) throw new BridgeError("WINDOW_ISOLATION", "页面不在本任务窗口");
  if (s.groupId !== undefined) {
    const group = await chrome.tabGroups.get(s.groupId).catch(() => undefined);
    if (!group || group.windowId !== s.windowId) delete s.groupId;
  }
  s.groupId = await editTabs(() => chrome.tabs.group({ tabIds: [tabId], ...(s.groupId !== undefined ? { groupId: s.groupId } : { createProperties: { windowId: s.windowId } }) }), m);
  await editTabs(() => chrome.tabGroups.update(s.groupId!, { title: s.name.slice(0, 40), color: "cyan" }), m);
  await save();
}
async function rpcPage(
  tabId: number,
  frameId: number,
  method: string,
  params: Record<string, any> = {},
) {
  let res: any;
  try {
    res = await chrome.tabs.sendMessage(
      tabId,
      { scope: "browser-bridge", method, params },
      { frameId },
    );
  } catch {
    throw new BridgeError("STALE_PAGE", "页面已跳转或不可访问，请重新观察");
  }
  if (res?.error) throw new BridgeError(res.error.code, res.error.message);
  if (!res) throw new BridgeError("FRAME_UNAVAILABLE", "页面未返回结果");
  return res.result;
}
async function frames(s: Session, tabId: number) {
  const all = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  const accessible: chrome.webNavigation.GetAllFrameResultDetails[] = [];
  const limits: { frameId: number; url: string; reason: string }[] = [];
  for (const frame of all) {
    try {
      let source = frame;
      const visited = new Set<number>();
      while (/^(about:blank|about:srcdoc|data:|blob:)/.test(source.url)) {
        if (source.url.startsWith("blob:") && new URL(source.url).origin !== "null") { await permitted(s, new URL(source.url).origin); break; }
        if (visited.has(source.frameId)) throw new BridgeError("FRAME_UNAVAILABLE", "无法确认嵌入页面来源");
        visited.add(source.frameId);
        const parent = all.find(f => f.frameId === source.parentFrameId);
        if (!parent) throw new BridgeError("FRAME_UNAVAILABLE", "无法确认嵌入页面来源");
        source = parent;
      }
      await permitted(s, source.url);
      accessible.push(frame);
    } catch (e) {
      limits.push({
        frameId: frame.frameId,
        url: frame.url,
        reason: errorOf(e).message,
      });
    }
  }
  return { accessible, limits };
}
async function install(tabId: number, frameId: number) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ["content.js"],
    });
  } catch (e) {
    throw new BridgeError(
      "HOST_DENIED",
      "Chrome 或站点不允许访问此页面：" + errorOf(e).message,
    );
  }
}
async function observe(m: Message) {
  const tab = await owned(m);
  checkNavigation(tab.id!);
  const s = alive(m);
  const info = await frames(s, tab.id!);
  await driver.attach(tab.id!);
  if (driver.dialogs.has(tab.id!)) return { tabId: tab.id, url: tab.url, title: tab.title, dialog: publicDialog(tab.id!), observationRequired: true };
  const parts: any[] = [];
  for (const f of info.accessible) {
    alive(m);
    try {
      await install(tab.id!, f.frameId);
      const page = await rpcPage(tab.id!, f.frameId, "observe");
      if (/^https?:/.test(page.url)) await permitted(s, page.url);
      parts.push({ ...page, frameId: f.frameId });
    } catch (e) {
      if (f.frameId === 0) throw e;
      info.limits.push({
        frameId: f.frameId,
        url: f.url,
        reason: errorOf(e).message,
      });
    }
  }
  const top = parts.find((p) => p.frameId === 0);
  if (!top) throw new BridgeError("FRAME_UNAVAILABLE", "无法观察主页面");
  const snapshot: Observation = {
    pageVersion: crypto.randomUUID(),
    frames: {},
    ax: {},
  };
  for (const p of parts)
    snapshot.frames[p.frameId] = { version: p.version, url: p.url };
  observations.set(tab.id!, snapshot);
  const accessibleNames = new Set(parts.flatMap(p => p.elements.map((e: any) => `${e.role}:${e.name}`)));
  const axElements: any[] = [];
  // AX supplements DOM targets. DOM results keep their existing element/frame IDs.
  for (const a of await driver.ax(tab.id!)) {
    if (accessibleNames.has(`${a.role}:${a.name}`) || a.disabled) continue;
    try {
      const detail = await driver.backend(a);
      const id = `ax${axElements.length + 1}`;
      snapshot.ax![id] = { ...a, signature: detail.signature };
      axElements.push({ elementId: id, role: a.role, name: a.name, label: a.name, bounds: { x: detail.x, y: detail.y, width: detail.width, height: detail.height }, frameId: 0, source: "accessibility" });
    } catch (e) { if (["HOST_DENIED", "POLICY_DENIED"].includes(errorOf(e).code)) throw e; }
  }
  return {
    ...top,
    body: parts
      .map((p) =>
        p.frameId === 0 ? p.body : `\n\n嵌入页面 ${p.url}\n${p.body}`,
      )
      .join(""),
    links: parts.flatMap((p) =>
      p.links.map((l: any) => ({ ...l, frameId: p.frameId })),
    ),
    tables: parts.flatMap((p) => p.tables),
    elements: [...parts.flatMap(p => p.elements.map((e: any) => ({ ...e, frameId: p.frameId }))), ...axElements],
    tableInfo: parts.flatMap(p => (p.tableInfo || []).map((t: any) => ({ ...t, frameId: p.frameId }))),
    version: undefined,
    pageVersion: snapshot.pageVersion,
    tabId: tab.id,
    frames: parts.filter((p) => p.frameId !== 0),
    inaccessibleFrames: info.limits,
  };
}
async function validate(m: Message) {
  const tab = await owned(m);
  const p = m.params!;
  const o = observations.get(tab.id!);
  const frameId = Number(p.frameId) || 0;
  if (!o || o.pageVersion !== p.pageVersion || !o.frames[frameId])
    throw new BridgeError("STALE_PAGE", "观察结果过期，请重新读取当前页面");
  if (/^https?:/.test(o.frames[frameId].url)) await permitted(alive(m), o.frames[frameId].url);
  await rpcPage(tab.id!, frameId, "validate", {
    version: o.frames[frameId].version,
  });
  alive(m);
  return { tab, frameId, version: o.frames[frameId].version };
}
async function waitLoaded(m: Message, tabId: number, afterCommit: number) {
  while (true) {
    alive(m);
    const tab = await chrome.tabs.get(tabId);
    checkNavigation(tabId);
    if (
      tab.status === "complete" &&
      !tab.pendingUrl &&
      (commits.get(tabId) || 0) > afterCommit &&
      /^https?:/.test(tab.url || "")
    ) {
      checkNavigation(tabId);
      await permitted(alive(m), tab.url || "");
      await new Promise((r) => setTimeout(r, 120));
      alive(m);
      return tab;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
}
function publicDialog(tabId: number) {
  const d = driver.dialogs.get(tabId); if (!d) return null;
  return { dialogId: d.dialogId, type: d.type, message: d.message, defaultPrompt: d.defaultPrompt, url: d.url };
}
function deadline(m: Message, seconds = 30) { return Math.min(m.deadline || Infinity, Date.now() + Math.min(90, seconds) * 1000); }
async function screenshot(m: Message) {
  const tab = await owned(m), id = tab.id!, p = m.params || {}, mode = p.mode || "viewport";
  const info = await frames(alive(m), id);
  if (info.limits.length) throw new BridgeError("FRAME_NOT_AUTHORIZED", "存在 Chrome 不允许访问的嵌入区域，不能截图");
  if (!observations.has(id)) await observe(m);
  await driver.attach(id);
  if (driver.dialogs.has(id)) throw new BridgeError("DIALOG_OPEN", "请先处理网页弹窗");
  let restoreScroll: (() => Promise<void>) | undefined, scrolledForCapture = false;
  const masked: number[] = [], images: any[] = []; let bytes = 0, nextOffsetY: number | undefined;
  let unmaskNative: (() => Promise<void>) | undefined, container: any;
  const clearMasks = async () => {
    try { if (unmaskNative) await unmaskNative(); }
    finally { unmaskNative = undefined; for (const f of masked.splice(0)) await rpcPage(id, f, "unmask").catch(() => {}); }
  };
  const addMasks = async () => {
    for (const f of info.accessible) { await install(id, f.frameId); await rpcPage(id, f.frameId, "mask"); masked.push(f.frameId); }
    unmaskNative = await driver.maskSensitive(id);
  };
  try {
  let geom = await rpcPage(id, 0, "geometry");
  const ep = { tabId: id }, zoom = await chrome.tabs.getZoom(id);
  let clip = { x: geom.scrollX, y: geom.scrollY, width: geom.width, height: geom.height };
  if (mode === "fullpage") {
    container = await rpcPage(id, 0, "fullpageBegin");
    if (container) {
      restoreScroll = () => rpcPage(id, 0, "fullpageEnd", { captureId: container.captureId }); scrolledForCapture = true;
      clip = { x: 0, y: Number(p.offsetY) || 0, width: container.width, height: container.contentHeight - (Number(p.offsetY) || 0) };
    } else clip = { x: 0, y: Number(p.offsetY) || 0, width: geom.documentWidth, height: geom.documentHeight - (Number(p.offsetY) || 0) };
  }
  else if (mode === "region") {
    if (!p.region || ["x", "y", "width", "height"].some(k => !Number.isFinite(p.region[k]))) throw new BridgeError("INVALID_REGION", "需要有效的可见区域坐标");
    if (p.region.x < 0 || p.region.y < 0 || p.region.x + p.region.width > geom.width || p.region.y + p.region.height > geom.height) throw new BridgeError("INVALID_REGION", "框选区域超出当前窗口");
    clip = { ...p.region, x: p.region.x + geom.scrollX, y: p.region.y + geom.scrollY };
  } else if (mode === "element") {
    const target = await resolveTarget(m, false);
    const prepared = await driver.prepareElementCapture(target);
    restoreScroll = prepared.restore; scrolledForCapture = prepared.scrolled;
    geom = await rpcPage(id, 0, "geometry");
    const quads = await driver.cmd(target.endpoint, "DOM.getContentQuads", { backendNodeId: target.backendNodeId });
    const q = quads.quads?.[0]; if (!q) throw new BridgeError("TARGET_HIDDEN", "元素不可见");
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    const corner = await driver.toTop(target.endpoint, Math.min(...xs), Math.min(...ys));
    clip = { x: corner.x + geom.scrollX, y: corner.y + geom.scrollY, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  } else if (mode !== "viewport") throw new BridgeError("INVALID_MODE", "未知截图模式");
  if (clip.width <= 0 || clip.height <= 0 || clip.x < 0 || clip.y < 0) throw new BridgeError("INVALID_REGION", "截图区域无效");
    if (!container) await addMasks();
    const tileHeight = Math.min(container?.viewHeight || 2048, 2048, Math.max(128, Math.floor(8000000 / clip.width / (geom.dpr * geom.dpr))));
    for (let y = clip.y; y < clip.y + clip.height; y += tileHeight) {
      alive(m);
      if (images.length >= 20) { nextOffsetY = y; break; }
      let tile = { x: clip.x, y, width: clip.width, height: Math.min(tileHeight, clip.y + clip.height - y), scale: 1 };
      if (container) {
        await clearMasks();
        const rect = await rpcPage(id, 0, "fullpageScroll", { captureId: container.captureId, offsetY: y });
        tile = { ...rect, height: Math.min(tile.height, rect.height) }; await addMasks();
      }
      const captureClip = { x: tile.x * zoom, y: tile.y * zoom, width: tile.width * zoom, height: tile.height * zoom, scale: 1 };
      const result = await driver.cmd(ep, "Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: !container, clip: captureClip });
      if (bytes + result.data.length > 22 * 1024 * 1024) { if (!images.length) throw new BridgeError("MESSAGE_TOO_LARGE", "截图过大，请缩小区域"); nextOffsetY = y; break; }
      const header = Uint8Array.from(atob(result.data.slice(0, 64)), c => c.charCodeAt(0)), view = new DataView(header.buffer);
      bytes += result.data.length; images.push({ data: result.data, clip: tile, ...(container ? { contentOffsetY: y } : {}), width: view.getUint32(16), height: view.getUint32(20), mimeType: "image/png" });
    }
    const screenshotId = crypto.randomUUID(), pageVersion = observations.get(id)?.pageVersion;
    shots.set(id, { screenshotId, pageVersion, geom, mode, zoom, clip, coordinateActionReady: !scrolledForCapture, imageClips: images.map(i => ({ ...i.clip, pixelWidth: i.width, pixelHeight: i.height })), url: tab.url });
    return { screenshotId, pageVersion, tabId: id, url: tab.url, title: tab.title, capturedAt: new Date().toISOString(), mode, viewport: geom,
      coordinateSpace: "截图像素；通过 imageIndex 与截图尺寸换算到页面 CSS 坐标", images, truncated: !!nextOffsetY, nextOffsetY,
      scrollRestored: scrolledForCapture, coordinateActionReady: !scrolledForCapture,
      captureScope: container ? "main-scroll-container" : "document", ...(container ? { loadedContentHeight: container.contentHeight, additionalScrollRegions: container.additionalScrollRegions } : {}) };
  } finally {
    try { await clearMasks(); }
    finally { if (restoreScroll) await restoreScroll(); }
  }
}
async function resolveTarget(m: Message, scroll = true, dest?: any): Promise<any> {
  const p = { ...m.params, ...(dest || {}) }, sub = { ...m, params: p };
  const { tab, frameId, version } = await validate(sub);
  const ax = observations.get(tab.id!)?.ax?.[p.elementId];
  if (ax) {
    const info = await driver.backend(ax, scroll);
    if (ax.signature !== info.signature) throw new BridgeError("STALE_PAGE", "目标内容或状态已变化");
    return { ...ax, info, point: await driver.topPoint(ax, info) };
  }
  const info = await rpcPage(tab.id!, frameId, scroll ? "target" : "inspect", { version, elementId: p.elementId });
  if (info.url) await permitted(alive(m), info.url); if (info.formURL) await permitted(alive(m), info.formURL);
  const marker = crypto.randomUUID();
  await rpcPage(tab.id!, frameId, "mark", { version, elementId: p.elementId, marker });
  try {
    const target = await driver.treeNode(tab.id!, marker);
    // DOM backend confirms hit-testing in the element's own document.
    const detail = await driver.backend(target, scroll);
    return { ...target, info: detail, point: await driver.topPoint(target, detail) };
  } finally { await rpcPage(tab.id!, frameId, "clearMarks").catch(() => {}); }
}
async function coordinates(m: Message, target: any) {
  const p = m.params!, tab = await owned(m), shot = shots.get(tab.id!);
  if (!shot || shot.screenshotId !== target.screenshotId || shot.pageVersion !== p.pageVersion || observations.get(tab.id!)?.pageVersion !== p.pageVersion)
    throw new BridgeError("STALE_SCREENSHOT", "截图已过期，请重新观察并截图");
  if (shot.coordinateActionReady === false) throw new BridgeError("STALE_SCREENSHOT", "截图后已恢复滚动位置；请滚动到目标并重新截图，或直接使用元素操作");
  const geom = await rpcPage(tab.id!, 0, "geometry");
  if (JSON.stringify(geom) !== JSON.stringify(shot.geom)) throw new BridgeError("STALE_SCREENSHOT", "页面已滚动、缩放或改变尺寸，请重新截图");
  const clip = shot.imageClips[target.imageIndex || 0];
  if (!clip || !Number.isFinite(target.x) || !Number.isFinite(target.y)) throw new BridgeError("INVALID_TARGET", "无效截图坐标");
  const x = clip.x + target.x * clip.width / clip.pixelWidth - geom.scrollX, y = clip.y + target.y * clip.height / clip.pixelHeight - geom.scrollY;
  if (x < 0 || y < 0 || x >= geom.width || y >= geom.height) throw new BridgeError("TARGET_OUTSIDE_VIEWPORT", "目标在窗口外，请先滚动再截图");
  let detail = await rpcPage(tab.id!, 0, "point", { x, y });
  if (["iframe", "frame"].includes(detail.tag)) detail = await driver.hit(tab.id!, x, y);
  if (detail.url) await permitted(alive(m), detail.url); if (detail.formURL) await permitted(alive(m), detail.formURL);
  return { endpoint: { tabId: tab.id! }, x, y, info: detail };
}
async function pageAction(m: Message) {
  const p = m.params!, { tab, frameId, version } = await validate(m), id = tab.id!;
  if (driver.dialogs.has(id)) throw new BridgeError("DIALOG_OPEN", "请先处理网页弹窗");
  alive(m);
  if (["select", "submit", "selectText"].includes(p.action)) {
    const info = await rpcPage(id, frameId, "inspect", { version, elementId: p.elementId });
    if (info.formURL) await permitted(alive(m), info.formURL);
    alive(m);
    try { return { ...await rpcPage(id, frameId, p.action, { ...p, version }), observationRequired: true }; }
    finally { observations.delete(id); shots.delete(id); }
  }
  const modifiers = (p.modifiers || []).reduce((v: number, k: string) => v | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[k] || 0), 0);
  let target: any, info: any;
  if (p.target) { target = await coordinates(m, p.target); info = target.info; }
  else if (p.elementId) { const resolved = await resolveTarget(m); target = resolved.point; info = resolved.info; }
  else {
    if (!["scroll", "key", "type"].includes(p.action)) throw new BridgeError("TARGET_REQUIRED", "操作需要元素或截图目标");
    info = await rpcPage(id, frameId, p.action === "scroll" ? "geometry" : "focused");
    if (info.sensitive) throw new BridgeError("SENSITIVE_CONTROL", "密码和验证码由用户输入");
    const geom = await rpcPage(id, 0, "geometry");
    target = { endpoint: { tabId: id }, x: Math.min(400, geom.width / 2), y: Math.min(300, geom.height / 2) };
  }
  alive(m); popupWindows.set(id, Date.now() + 5000);
  await driver.armChooser(id);
  const ep = target.endpoint;
  const click = async (button = "left", count = 1) => {
    await driver.mouse(ep, "mouseMoved", target.x, target.y, { modifiers }); alive(m);
    for (let i = 1; i <= count; i++) {
      await driver.mouse(ep, "mousePressed", target.x, target.y, { button, buttons: button === "right" ? 2 : 1, clickCount: i, modifiers }); alive(m);
      await driver.mouse(ep, "mouseReleased", target.x, target.y, { button, buttons: 0, clickCount: i, modifiers });
    }
  };
  let extra: any = {};
  try {
    switch (p.action) {
      case "click": case "doubleClick": case "rightClick": await click(p.action === "rightClick" ? "right" : "left", p.action === "doubleClick" ? 2 : 1); break;
      case "hover": await driver.mouse(ep, "mouseMoved", target.x, target.y); break;
      case "check": case "uncheck": if (!/checkbox|radio/.test(info.type || info.role || "")) throw new BridgeError("INVALID_CONTROL", "目标不是勾选控件"); if (!!info.checked !== (p.action === "check")) await click(); break;
      case "fill": case "type": {
        if (!info.editable || ["file", "hidden", "checkbox", "radio", "submit", "button"].includes(info.type)) throw new BridgeError("INVALID_CONTROL", "目标不支持输入文字");
        if (p.elementId || p.target) await click();
        if (p.action === "fill") { await driver.key(ep, "a", navigator.platform.includes("Mac") ? 4 : 2); alive(m); }
        if (p.action === "fill" && !p.text) await driver.key(ep, "Backspace");
        else await driver.cmd(ep, "Input.insertText", { text: String(p.text || "") });
        break;
      }
      case "key": if (p.elementId || p.target) await click(); await driver.key(ep, p.key, modifiers); break;
      case "scroll": await driver.mouse(ep, "mouseWheel", target.x, target.y, { deltaX: Number(p.x) || 0, deltaY: Number(p.y) || 0 }); await new Promise(r => setTimeout(r, 120)); break;
      case "drag": {
        if (!p.destination) throw new BridgeError("TARGET_REQUIRED", "拖动需要终点");
        const to = p.destination.screenshotId ? await coordinates(m, p.destination) : (await resolveTarget(m, false, p.destination)).point;
        if (JSON.stringify(ep) !== JSON.stringify(to.endpoint)) throw new BridgeError("FRAME_DRAG_UNSUPPORTED", "不能跨进程框架拖动");
        driver.drags.delete(id); await driver.cmd(ep, "Input.setInterceptDrags", { enabled: true });
        await driver.mouse(ep, "mouseMoved", target.x, target.y); await driver.mouse(ep, "mousePressed", target.x, target.y, { button: "left", buttons: 1, clickCount: 1 });
        try {
          for (let step = 1; step <= 12; step++) { alive(m); await driver.mouse(ep, "mouseMoved", target.x + (to.x - target.x) * step / 12, target.y + (to.y - target.y) * step / 12, { button: "left", buttons: 1 }); }
          const data = driver.drags.get(id);
          if (data) for (const type of ["dragEnter", "dragOver", "drop"]) { alive(m); await driver.cmd(ep, "Input.dispatchDragEvent", { type, x: to.x, y: to.y, data }); }
        } finally { await driver.mouse(ep, "mouseReleased", to.x, to.y, { button: "left", buttons: 0, clickCount: 1 }); await driver.cmd(ep, "Input.setInterceptDrags", { enabled: false }); driver.drags.delete(id); }
        break;
      }
      case "select": case "submit": case "selectText": extra = await rpcPage(id, frameId, p.action, { ...p, version }); break;
      default: throw new BridgeError("INVALID_ACTION", "不支持该动作");
    }
    return { ...extra, performed: p.action, observationRequired: true, dialog: publicDialog(id), chooserId: driver.latestChooser(id)?.chooserId };
  } finally { observations.delete(id); shots.delete(id); }
}
async function upload(m: Message) {
  const p = m.params!, tab = await owned(m); let target: any;
  if (p.chooserId) {
    target = driver.choosers.get(p.chooserId);
    if (!target || target.tabId !== tab.id || Date.now() - target.created > 60000) throw new BridgeError("STALE_CHOOSER", "文件选择请求已失效");
    // Choosers are only intercepted on task-owned tabs; endpoint and backend ID come from Chrome.
  } else {
    target = await resolveTarget(m, false);
    if (target.info.type !== "file") throw new BridgeError("INVALID_CONTROL", "目标不是文件控件");
  }
  alive(m);
  try { await driver.cmd(target.endpoint, "DOM.setFileInputFiles", { backendNodeId: target.backendNodeId, files: p.files }); return { selectedFiles: p.files.length, observationRequired: true }; }
  finally { if (p.chooserId) driver.choosers.delete(p.chooserId); observations.delete(tab.id!); shots.delete(tab.id!); }
}
driver.onDownload = (tabId, event) => {
  if (navigationStatus.get(tabId)?.error === "net::ERR_ABORTED") navigationStatus.delete(tabId);
  downloadEvents.push({ tabId, ...event, time: Date.now() });
  while (downloadEvents.length > 100) downloadEvents.shift();
};
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId === chrome.runtime.id) {
    void (async () => {
      const end = Date.now() + 1500;
      while (!directFilenames.has(item.id) && Date.now() < end) await new Promise(r => setTimeout(r, 10));
      const filename = directFilenames.get(item.id);
      suggest(filename ? { filename, conflictAction: "uniquify" } : undefined);
      directFilenames.delete(item.id);
    })(); return true;
  }
  downloadCandidates.push({ ...item, time: Date.now() }); while (downloadCandidates.length > 100) downloadCandidates.shift();
  void (async () => {
    await new Promise(r => setTimeout(r, 600));
    const matches = downloadEvents.filter(e => e.url === item.url && Math.abs(e.time - Date.parse(item.startTime)) < 5000);
    const pending = [...expectations.values()].filter(e => e.state === "waiting" && e.expires > Date.now() && matches.some(d => d.tabId === e.tabId));
    if (!pending.length) { suggest(); return; }
    const collision = downloadCandidates.filter(d => d.url === item.url && Math.abs(d.time - Date.parse(item.startTime)) < 5000).length > 1;
    if (matches.length !== 1 || pending.length !== 1 || collision) {
      for (const e of pending) { e.state = "ambiguous"; e.error = "无法唯一确认下载归属"; } suggest(); return;
    }
    const e = pending[0], s = sessions[e.sessionId];
    if (!s || s.stopped) { suggest(); return; }
    e.state = "matched"; e.downloadId = item.id; downloads[item.id] = s.sessionId; await save();
    const name = item.filename.replaceAll("\\", "/").split("/").pop()?.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 120) || "export";
    suggest({ filename: `BrowserBridge/${s.sessionId}/${name}`, conflictAction: "uniquify" });
  })().catch(() => suggest());
  return true;
});
async function execute(m: Message): Promise<any> {
  const p = m.params || {};
  if (m.method === "session.start") {
    const id = m.sessionId!;
    const old = sessions[id];
    if (old?.stopped) throw new BridgeError("SESSION_STOPPED", "任务已停止");
    const s: Session = old || {
      sessionId: id,
      name: p.name,
      origins: [],
      tabs: [],
      stopped: false,
    };
    // Legacy origin lists are retained only for protocol compatibility.
    // All ordinary websites are available once Chrome grants host permissions.
    s.origins = [];
    sessions[id] = s;
    await save();
    const windowId = await taskWindow(m);
    return { started: true, windowId, windowMode: "dedicated", focusPolicy: "background" };
  }
  const s = alive(
    m,
    m.method === "tab.close" ||
      m.method === "session.end" ||
      m.method === "download.status",
  );
  switch (m.method) {
    case "session.end":
      s.stopped = true;
      for (const id of [...s.tabs]) {
        await driver.detach(id);
        if (!s.claimed?.includes(id)) await editTabs(() => chrome.tabs.remove(id), m).catch(() => {});
      }
      s.tabs = [];
      if (s.homeTabId !== undefined) await editTabs(() => chrome.tabs.remove(s.homeTabId!)).catch(() => {});
      delete s.homeTabId; delete s.windowId; delete s.groupId;
      s.claimed = [];
      await save();
      return { stopped: true };
    case "tabs.list": {
      if (p.scope === "available") {
        const result = [];
        for (const t of await chrome.tabs.query({})) {
          if (!/^https?:/.test(t.url || "") || t.incognito || windowOwner(t.windowId, s.sessionId) || Object.values(sessions).some(other => !other.stopped && other.sessionId !== s.sessionId && other.tabs.includes(t.id!))) continue;
          try { await permitted(s, t.url!); } catch { continue; }
          const discoveryToken = crypto.randomUUID();
          discoveries.set(discoveryToken, { sessionId: s.sessionId, tabId: t.id, url: t.url, expires: Date.now() + 60000 });
          result.push({ tabId: t.id, windowId: t.windowId, title: t.title, url: t.url, active: t.active, owned: s.tabs.includes(t.id!), discoveryToken });
        }
        for (const [key, v] of discoveries) if (v.expires < Date.now()) discoveries.delete(key);
        return { tabs: result, scope: "available", claimRequired: true };
      }
      const tabs = [];
      for (const id of [...s.tabs]) {
        try {
          const t = await chrome.tabs.get(id);
          tabs.push({
            tabId: id,
            windowId: t.windowId,
            sessionId: s.sessionId,
            inTaskWindow: t.windowId === s.windowId,
            url: t.url,
            title: t.title,
            active: t.active,
            status: t.status,
          });
        } catch {
          s.tabs = s.tabs.filter((x) => x !== id);
        }
      }
      await save();
      return { tabs, windowId: s.windowId, sessionId: s.sessionId, windowMode: "dedicated", focusPolicy: "background" };
    }
    case "tab.claim": {
      const discovery = discoveries.get(p.discoveryToken);
      if (!discovery || discovery.sessionId !== s.sessionId || discovery.tabId !== p.tabId || discovery.expires < Date.now()) throw new BridgeError("STALE_DISCOVERY", "请重新列出可接管页面");
      const t = await chrome.tabs.get(p.tabId); await permitted(s, t.url || "");
      if (windowOwner(t.windowId, s.sessionId)) throw new BridgeError("SESSION_ISOLATION", "页面所在窗口属于另一个任务");
      if (t.url !== discovery.url) throw new BridgeError("STALE_DISCOVERY", "页面已跳转，请重新确认目标");
      for (const other of Object.values(sessions)) {
        if (other.sessionId === s.sessionId || !other.tabs.includes(p.tabId)) continue;
        if (!other.stopped) throw new BridgeError("SESSION_ISOLATION", "页面正在被另一个任务使用");
        other.tabs = other.tabs.filter(id => id !== p.tabId);
      }
      const windowId = await taskWindow(m);
      if (t.windowId !== windowId) await editTabs(() => chrome.tabs.move(p.tabId, { windowId, index: -1 }), m);
      alive(m);
      if (!s.tabs.includes(p.tabId)) { s.tabs.push(p.tabId); (s.claimed ||= []).push(p.tabId); }
      await groupTaskTab(s, p.tabId, m);
      discoveries.delete(p.discoveryToken); await save(); return { tabId: p.tabId, windowId, sessionId: s.sessionId, claimed: true, closeOnSessionEnd: false };
    }
    case "tab.release": {
      const t = await owned(m, true); await driver.detach(t.id!);
      s.tabs = s.tabs.filter(id => id !== t.id); s.claimed = s.claimed?.filter(id => id !== t.id);
      observations.delete(t.id!); shots.delete(t.id!); await save(); return { released: true, tabId: t.id };
    }
    case "tab.open": {
      await permitted(s, p.url);
      alive(m);
      const windowId = await taskWindow(m);
      const t = await editTabs(
        () => chrome.tabs.create({ windowId, url: "about:blank", active: false }),
        m,
      );
      s.tabs.push(t.id!);
      await save();
      try {
        await groupTaskTab(s, t.id!, m);
        alive(m);
        const commit = commits.get(t.id!) || 0;
        await editTabs(() => chrome.tabs.update(t.id!, { url: p.url }), m);
        const loaded = await waitLoaded(m, t.id!, commit);
        return { tabId: t.id, windowId, sessionId: s.sessionId, url: loaded.url, title: loaded.title };
      } catch (e) {
        await editTabs(() => chrome.tabs.remove(t.id!)).catch(() => {});
        s.tabs = s.tabs.filter((x) => x !== t.id);
        await save();
        throw e;
      }
    }
    case "tab.focus": {
      return foreground(async () => {
        const t = await owned(m);
        await chrome.windows.update(t.windowId, { focused: true });
        alive(m);
        await editTabs(() => chrome.tabs.update(t.id!, { active: true }), m);
        return { focused: true, windowId: t.windowId };
      });
    }
    case "tab.close": {
      const t = await owned(m, true);
      await editTabs(() => chrome.tabs.remove(t.id!), m);
      s.tabs = s.tabs.filter((x) => x !== t.id);
      observations.delete(t.id!);
      await save();
      return { closed: true };
    }
    case "page.observe":
      return observe(m);
    case "page.find": {
      const page = await observe(m);
      const needle = String(p.name || "");
      return { tabId: p.tabId, pageVersion: page.pageVersion, dialog: page.dialog, matches: (page.elements || []).filter((e: any) => (!p.role || e.role === p.role) && (!needle || (p.exact ? e.name === needle : e.name.includes(needle)))) };
    }
    case "page.wait": {
      const until = deadline(m, p.timeoutSeconds || 30);
      do {
        alive(m); const tab = await owned(m);
        if (p.condition === "dialog" && driver.dialogs.has(tab.id!)) return { dialog: publicDialog(tab.id!) };
        if (p.condition === "fileChooser" && driver.latestChooser(tab.id!)) return { chooserId: driver.latestChooser(tab.id!).chooserId };
        if (p.condition === "newTab") { const opened = s.tabs.filter(id => id !== tab.id && !p.knownTabIds?.includes(id)); if (opened.length) return { tabIds: opened }; }
        if (p.condition === "download") { const e = expectations.get(p.expectationId); if (!e || e.sessionId !== s.sessionId) throw new BridgeError("SESSION_ISOLATION", "下载等待不属于此任务"); if (e.state !== "waiting") return { ...e }; }
        if (p.condition === "navigation" && tab.status === "complete" && (!p.url || tab.url === p.url)) return { tabId: tab.id, url: tab.url, observationRequired: true };
        if (!p.condition || p.condition === "element") {
          const page = await observe(m), matches = (page.elements || []).filter((e: any) => (!p.name || e.name.includes(p.name)) && (!p.role || e.role === p.role));
          if (matches.length) return { pageVersion: page.pageVersion, matches };
          if (page.dialog) return { dialog: page.dialog };
        }
        await new Promise(r => setTimeout(r, 200));
      } while (Date.now() < until);
      throw new BridgeError("WAIT_TIMEOUT", "等待条件未满足；没有重新执行动作");
    }
    case "page.dialog": {
      const tab = await owned(m), d = driver.dialogs.get(tab.id!);
      if (!p.action || p.action === "read") return { dialog: publicDialog(tab.id!) };
      if (!d || p.dialogId !== d.dialogId) throw new BridgeError("STALE_DIALOG", "弹窗已变化，请重新读取");
      if (!["accept", "dismiss"].includes(p.action)) throw new BridgeError("INVALID_ACTION", "未知弹窗动作");
      await driver.cmd(d.endpoint, "Page.handleJavaScriptDialog", { accept: p.action === "accept", promptText: p.text || "" });
      observations.delete(tab.id!); shots.delete(tab.id!); return { handled: true, observationRequired: true };
    }
    case "page.screenshot":
      return screenshot(m);
    case "page.navigate": {
      const { tab } = await validate(m);
      if (!p.direction || p.direction === "url") await permitted(s, p.url);
      alive(m);
      observations.delete(tab.id!);
      const commit = commits.get(tab.id!) || 0;
      if (p.direction === "back" || p.direction === "forward") {
        await driver.attach(tab.id!); const history = await driver.cmd({ tabId: tab.id! }, "Page.getNavigationHistory");
        const entry = history.entries[history.currentIndex + (p.direction === "back" ? -1 : 1)];
        if (!entry) throw new BridgeError("NO_HISTORY", "没有可用历史页面");
        await permitted(s, entry.url); await driver.cmd({ tabId: tab.id! }, "Page.navigateToHistoryEntry", { entryId: entry.id });
      } else if (p.direction === "reload") await chrome.tabs.reload(tab.id!);
      else await editTabs(() => chrome.tabs.update(tab.id!, { url: p.url }), m);
      const t = await waitLoaded(m, tab.id!, commit);
      return { tabId: t.id, url: t.url, observationRequired: true };
    }
    case "page.act": return pageAction(m);
    case "file.upload":
      return upload(m);
    case "download.expect": {
      const tab = await owned(m);
      if ([...expectations.values()].some(e => e.state === "waiting" && e.expires > Date.now())) throw new BridgeError("DOWNLOAD_BUSY", "已有导出动作等待关联，请先等待其完成");
      await driver.attach(tab.id!);
      const expectationId = crypto.randomUUID();
      const expectation = { expectationId, sessionId: s.sessionId, tabId: tab.id, state: "waiting", expires: deadline(m, p.timeoutSeconds || 45) };
      expectations.set(expectationId, expectation); return expectation;
    }
    case "download.start": {
      await permitted(s, p.url);
      alive(m);
      let name = new URL(p.url).pathname.split("/").pop() || "download";
      try {
        name = decodeURIComponent(name);
      } catch {}
      name = name.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 120);
      if (!name || /^\.+$/.test(name)) name = "download";
      const filename = `BrowserBridge/${s.sessionId}/${name}`;
      directDownloads.set(p.url, { sessionId: s.sessionId, filename });
      let id: number;
      try { id = await chrome.downloads.download({
        url: p.url,
        filename,
        conflictAction: "uniquify",
        saveAs: false,
      }); } finally { directDownloads.delete(p.url); }
      downloads[id] = s.sessionId;
      directFilenames.set(id, filename);
      await save();
      return { downloadId: id, state: "in_progress" };
    }
    case "download.status": {
      if (p.expectationId) {
        const e = expectations.get(p.expectationId);
        if (!e || e.sessionId !== s.sessionId) throw new BridgeError("SESSION_ISOLATION", "下载等待不属于当前任务");
        if (e.state === "ambiguous") throw new BridgeError("DOWNLOAD_AMBIGUOUS", e.error);
        if (!e.downloadId) return { expectationId: e.expectationId, state: Date.now() > e.expires ? "timeout" : e.state };
        p.downloadId = e.downloadId;
      }
      if (downloads[p.downloadId] !== s.sessionId)
        throw new BridgeError("SESSION_ISOLATION", "下载不属于当前任务");
      const [d] = await chrome.downloads.search({ id: p.downloadId });
      if (!d) throw new BridgeError("DOWNLOAD_NOT_FOUND", "下载记录不存在");
      if (
        (d.byExtensionId && d.byExtensionId !== chrome.runtime.id) ||
        (d.state === "complete" &&
          !d.filename
            .replaceAll("\\", "/")
            .includes(`/BrowserBridge/${s.sessionId}/`))
      )
        throw new BridgeError("SESSION_ISOLATION", "下载目标目录与当前任务不匹配：" + d.filename);
      return {
        downloadId: d.id,
        state: d.state,
        path: d.filename,
        exists: d.exists,
        error: d.error,
        danger: d.danger,
        bytesReceived: d.bytesReceived,
        totalBytes: d.totalBytes,
      };
    }
    default:
      throw new BridgeError("UNKNOWN_METHOD", "不支持该操作");
  }
}
async function receive(m: Message) {
  await ready;
  if (m.kind === "event") {
    switch (m.method) {
      case "ui.screenshot.result": {
        const pending = uiCaptures.get(m.requestId || "");
        if (pending) { uiCaptures.delete(m.requestId!); clearTimeout(pending.timer); if (m.error) pending.reject(new BridgeError(m.error.code, m.error.message)); else { lastScreenshot = m.result; pending.resolve(m.result); } }
        break;
      }
      case "connected":
        connected = true;
        lastError = "";
        observations.clear();
        break;
      case "session.stopped":
        if (sessions[m.sessionId!]) sessions[m.sessionId!].stopped = true;
        await save();
        break;
      case "batch.cancelled":
        cancelledJobs.add(m.params!.jobId);
        break;
      case "batch.started":
        cancelledJobs.delete(m.params!.jobId);
        break;
      case "batch.progress":
        if (sessions[m.sessionId!]) sessions[m.sessionId!].progress = m.params;
        await save();
        break;
    }
    return;
  }
  if (m.kind !== "request") return;
  requestGeneration.set(m, connectionGeneration);
  const task = async () => {
    try {
      if (m.deadline && Date.now() >= m.deadline)
        throw new BridgeError("TIMEOUT", "请求已过期");
      const result = await execute(m);
      send({
        version: VERSION,
        kind: "response",
        requestId: m.requestId,
        result,
      });
    } catch (e) {
      const error = errorOf(e);
      if (
        ["page.act", "file.upload", "page.navigate", "download.start"].includes(
          m.method || "",
        ) &&
        ["STALE_PAGE", "BROWSER_ERROR", "TIMEOUT"].includes(error.code)
      )
        error.uncertain = true;
      try {
        send({
          version: VERSION,
          kind: "response",
          requestId: m.requestId,
          error,
        });
      } catch {}
    }
  };
  const key = m.params?.tabId
    ? `tab:${m.params.tabId}`
    : `session:${m.sessionId || m.requestId}`;
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  queues.set(key, next);
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
}
chrome.tabs.onRemoved.addListener((id) => {
  commits.delete(id);
  navigationStatus.delete(id);
  observations.delete(id);
  void driver.detach(id);
  for (const s of Object.values(sessions))
    s.tabs = s.tabs.filter((t) => t !== id);
  void save();
});
chrome.webNavigation.onCreatedNavigationTarget.addListener(t => {
  if ((popupWindows.get(t.sourceTabId) || 0) < Date.now()) return;
  const s = Object.values(sessions).find(s => !s.stopped && s.tabs.includes(t.sourceTabId));
  if (!s || s.tabs.includes(t.tabId)) return;
  s.tabs.push(t.tabId); void save();
  void (async () => {
    const tab = await chrome.tabs.get(t.tabId);
    if (s.stopped || s.windowId === undefined || windowOwner(tab.windowId, s.sessionId)) return;
    if (tab.windowId !== s.windowId) await editTabs(() => chrome.tabs.move(t.tabId, { windowId: s.windowId!, index: -1 }));
    await groupTaskTab(s, t.tabId);
  })().catch(() => {});
});
chrome.tabs.onAttached.addListener(id => { observations.delete(id); shots.delete(id); });
chrome.windows.onRemoved.addListener(windowId => {
  for (const s of Object.values(sessions)) if (s.windowId === windowId) {
    delete s.windowId; delete s.homeTabId; delete s.groupId;
  }
  void save();
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.status === "loading" || change.url) {
    observations.delete(id);
  }
});
chrome.permissions.onRemoved.addListener(() => observations.clear());
const uiCaptures = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>();
chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.scope !== "team-browser-ui" || _sender.id !== chrome.runtime.id || !_sender.url?.startsWith(chrome.runtime.getURL("ui.html"))) return;
  void (async () => {
    await ready;
    switch (m.method) {
      case "status":
        return {
          connected,
          lastError,
          profileId,
          profileName,
          version: chrome.runtime.getManifest().version,
          protocol: VERSION,
          capabilities,
          lastScreenshot: lastScreenshot ? { path: lastScreenshot.path, data: lastScreenshot.images?.[0]?.data, images: lastScreenshot.images?.length } : null,
          sessions: Object.values(sessions).map((s) => ({
            sessionId: s.sessionId,
            name: s.name,
            stopped: s.stopped,
            tabs: s.tabs.length,
            tabIds: s.tabs,
            windowId: s.windowId,
            progress: s.progress,
          })),
          allSitesAllowed: await chrome.permissions.contains({
            origins: ["http://*/*", "https://*/*"],
          }),
        };
      case "screenshot": {
        const s = sessions[m.sessionId]; if (!s || s.stopped) throw new BridgeError("SESSION_NOT_FOUND", "请先在智能体中开始网页任务");
        const tabId = Number(m.tabId); if (!s.tabs.includes(tabId)) throw new BridgeError("SESSION_ISOLATION", "请选择当前任务页面");
        let region: any;
        if (m.mode === "region") region = await foreground(async () => {
          const tab = await owned({ ...m, params: { tabId } });
          await chrome.windows.update(tab.windowId, { focused: true });
          await editTabs(() => chrome.tabs.update(tabId, { active: true }));
          await install(tabId, 0);
          return rpcPage(tabId, 0, "pickRegion");
        });
        const requestId = crypto.randomUUID();
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { uiCaptures.delete(requestId); reject(new BridgeError("TIMEOUT", "截图超时")); }, 65000);
          uiCaptures.set(requestId, { resolve, reject, timer });
          try { send({ version: VERSION, kind: "event", method: "ui.screenshot", requestId, sessionId: s.sessionId, params: { sessionId: s.sessionId, tabId, mode: m.mode || "viewport", region } }); }
          catch (e) { clearTimeout(timer); uiCaptures.delete(requestId); reject(e); }
        });
      }
      case "focus": {
        const s = sessions[m.sessionId];
        if (!s || s.stopped || s.windowId === undefined) throw new BridgeError("SESSION_NOT_FOUND", "任务窗口已关闭");
        return foreground(async () => { await chrome.windows.update(s.windowId!, { focused: true }); return { focused: true }; });
      }
      case "reconnect":
        port?.disconnect();
        port = undefined;
        connect();
        return { reconnecting: true };
      case "rename":
        profileName = String(m.name || "我的 Chrome").slice(0, 60);
        await chrome.storage.local.set({ profileName });
        return { saved: true };
      case "stop": {
        const s = sessions[m.sessionId];
        if (s) {
          s.stopped = true;
          for (const id of s.tabs) void driver.detach(id);
          await save();
          try {
            send({
              version: VERSION,
              kind: "event",
              method: "session.stop",
              sessionId: s.sessionId,
            });
          } catch {}
        }
        return { stopped: true };
      }
      default:
        throw new BridgeError("UNKNOWN_METHOD", "未知界面请求");
    }
  })().then(
    (result) => reply({ result }),
    (error) => reply({ error: errorOf(error) }),
  );
  return true;
});
