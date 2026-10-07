const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id)! as T;
const call = async (method: string, extra: Record<string, unknown> = {}) => {
  const r = await chrome.runtime.sendMessage({
    scope: "team-browser-ui",
    method,
    ...extra,
  });
  if (r.error) throw new Error(r.error.message);
  return r.result;
};
const message = (text: string, error = false) => {
  $("notice").textContent = text;
  $("notice").className = error ? "notice error" : "notice";
};
let captureBusy = false;
async function refresh() {
  try {
    const s = await call("status");
    $("connection").textContent = s.connected ? "本机服务已连接" : "尚未连接";
    $("lamp").className = s.connected ? "lamp online" : "lamp";
    $("detail").textContent = s.connected
      ? `${s.profileName} · v${s.version} · 协议 ${s.protocol}`
      : s.lastError;
    $("profile").textContent = s.profileId;
    $("site-access").textContent = s.allSitesAllowed
      ? "网站访问：所有普通网站，无需逐个添加"
      : "Chrome 尚未开放所有网站，请在扩展详情中确认网站访问权限。";
    $("tasks").replaceChildren();
    const current = s.sessions.slice(-12).reverse();
    const select = $<HTMLSelectElement>("capture-tab"), previous = select.value;
    select.replaceChildren();
    for (const task of current.filter((x: any) => !x.stopped)) for (const tabId of task.tabIds || []) {
      const option = document.createElement("option"); option.value = task.sessionId + ":" + tabId; option.textContent = `${task.name} · 页面 ${tabId}`; select.append(option);
    }
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
    const hasTabs = select.options.length > 0;
    if (!hasTabs) {
      const option = document.createElement("option"); option.value = "";
      option.textContent = "暂无任务页面，请先让智能体打开或接管网页"; select.append(option);
    }
    select.disabled = !hasTabs;
    $<HTMLButtonElement>("capture").disabled = captureBusy || !hasTabs || !s.connected;
    if (s.lastScreenshot) {
      $("capture-path").textContent = s.lastScreenshot.path + (s.lastScreenshot.images > 1 ? `（共 ${s.lastScreenshot.images} 段）` : "");
      const preview = $<HTMLImageElement>("capture-preview"); preview.src = "data:image/png;base64," + s.lastScreenshot.data; preview.hidden = false;
    }
    if (!current.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "暂无任务。在 Codex 中开始网页任务后，会在这里显示。";
      $("tasks").append(empty);
    }
    for (const s of current) {
      const card = document.createElement("div");
      card.className = "task";
      const heading = document.createElement("strong");
      heading.textContent = s.name;
      const text = document.createElement("p");
      text.textContent = s.stopped ? "已停止" : `${s.tabs} 个任务标签页 · ${s.windowId !== undefined ? `独立窗口 ${s.windowId}` : "窗口已关闭"} · 后台操作`;
      card.append(heading, text);
      if (s.progress) {
        const counts = s.progress.counts || {};
        const progress = document.createElement("progress");
        progress.max = s.progress.total;
        progress.value =
          (counts.done || 0) + (counts.failed || 0) + (counts.cancelled || 0);
        const label = document.createElement("small");
        label.textContent = `已完成 ${counts.done || 0} · 失败 ${counts.failed || 0} · 总计 ${s.progress.total}`;
        card.append(progress, label);
      }
      if (!s.stopped) {
        if (s.windowId !== undefined) {
          const show = document.createElement("button");
          show.textContent = "查看任务窗口";
          show.addEventListener("click", () => void call("focus", { sessionId: s.sessionId }).catch(e => message(String(e), true)));
          card.append(show);
        }
        const stop = document.createElement("button");
        stop.className = "danger";
        stop.textContent = "停止任务";
        stop.addEventListener("click", async () => {
          await call("stop", { sessionId: s.sessionId });
          message("已停止后续动作；已经提交的操作无法撤回。");
          await refresh();
        });
        card.append(stop);
      }
      $("tasks").append(card);
    }
  } catch (e) {
    message(String(e), true);
  }
}
$("reconnect").addEventListener(
  "click",
  () => void call("reconnect").then(() => refresh()),
);
$("rename").addEventListener(
  "click",
  () =>
    void call("rename", { name: $<HTMLInputElement>("name").value }).then(
      () => {
        message("名称已保存，下次连接时生效");
        return refresh();
      },
    ),
);
void refresh();
$("capture").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("capture"); captureBusy = true; button.disabled = true;
  try {
    const [sessionId, tab] = $<HTMLSelectElement>("capture-tab").value.split(":");
    if (!sessionId || !tab) throw new Error("请先在智能体中开始网页任务，打开或接管页面");
    const mode = $<HTMLSelectElement>("capture-mode").value;
    message(mode === "region" ? "请到目标页面拖动框选；Esc 可取消" : "正在截图…");
    const result = await call("screenshot", { sessionId, tabId: Number(tab), mode });
    message("截图已保存：" + result.path); await refresh();
  } catch (e) { message(String(e), true); } finally { captureBusy = false; await refresh(); }
});
setInterval(() => void refresh(), 2000);
