// Packaged, isolated-world helpers only. The public protocol never accepts code.
(() => {
  const root = globalThis as any;
  if (root.__teamBrowserVersion === "0.2.0") return;
  // A Chrome extension reload destroys the previous isolated-world listener.
  root.__teamBrowserVersion = "0.2.0";
  const doc = crypto.randomUUID();
  let version = "", observedURL = "", revision = 0;
  const nodes = new Map<string, Element>(), signatures = new Map<string, string>();
  const masks: HTMLElement[] = [];
  let containerCapture: { id: string; element: Element; x: number; y: number; height: number; width: number; viewHeight: number } | undefined;
  const painted = () => new Promise<void>(resolve => { const timer = setTimeout(resolve, 250); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); });
  const fail = (code: string, message: string): never => { throw { code, message }; };
  function deep(selector: string, parent: Document | ShadowRoot | Element = document): Element[] {
    const result = [...parent.querySelectorAll(selector)];
    for (const e of parent.querySelectorAll("*")) if (e.shadowRoot) result.push(...deep(selector, e.shadowRoot));
    return result;
  }
  function shown(e: Element): boolean {
    const r = e.getBoundingClientRect(), css = getComputedStyle(e);
    if (!r.width || !r.height || css.visibility === "hidden" || css.display === "none" || css.opacity === "0") return false;
    for (let p: Element | null = e; p; p = p.parentElement || (p.getRootNode() as ShadowRoot).host || null)
      if (p.hasAttribute("hidden") || p.getAttribute("aria-hidden") === "true") return false;
    return true;
  }
  const secret = (e: Element) => e.matches("input,textarea,[contenteditable]") &&
    (e.getAttribute("type") === "password" || /password|passwd|one-time-code|cc-number|cc-csc|验证码|密码|安全码/i.test(
      ["name", "id", "autocomplete", "aria-label", "placeholder"].map(a => e.getAttribute(a) || "").join(" ")));
  const text = (e: Element) => ((e as HTMLElement).innerText ?? e.textContent ?? "").trim();
  function label(e: Element) {
    const refs = (e.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => (e.getRootNode() as Document).getElementById?.(id)?.textContent || "").join(" ").trim();
    return (e.getAttribute("aria-label") || refs || (e as HTMLInputElement).labels?.[0]?.innerText || e.getAttribute("placeholder") || e.getAttribute("alt") || text(e) || e.getAttribute("title") || "").trim().slice(0, 300);
  }
  function role(e: Element) {
    return e.getAttribute("role") || (e.matches("a[href]") ? "link" : e.matches("button,input[type=button],input[type=submit]") ? "button" :
      e.matches("input[type=checkbox]") ? "checkbox" : e.matches("input[type=radio]") ? "radio" : e.matches("select") ? "combobox" :
      e.matches("textarea,input,[contenteditable=true]") ? "textbox" : e.matches("form") ? "form" : e.matches("canvas") ? "canvas" : "generic");
  }
  const box = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  function signature(e: Element) {
    const i = e as HTMLInputElement;
    return JSON.stringify([e.tagName, e.getAttribute("type"), label(e), e.getAttribute("href"), e.getAttribute("action"),
      e.getAttribute("disabled"), e.getAttribute("aria-disabled"), secret(e) ? "[sensitive]" : i.value, i.checked, e.getAttribute("aria-checked")]);
  }
  function blocked() {
    const status = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming)?.responseStatus;
    if (status >= 400) fail(status === 401 || status === 403 ? "HOST_DENIED" : "HTTP_ERROR", `页面返回 HTTP ${status}`);
    if (document.documentElement.getAttribute("data-team-browser-policy") === "deny" || /access denied|访问被拒绝|禁止自动化/i.test(document.title))
      fail("HOST_DENIED", "此页面明确拒绝自动化，停止操作");
  }
  function bodyText() {
    let out = "";
    function walk(n: Node) {
      if (out.length >= 600001) return;
      if (n.nodeType === Node.TEXT_NODE) { out += n.textContent?.replace(/\s+/g, " ") || ""; return; }
      if (!(n instanceof Element) && !(n instanceof ShadowRoot)) return;
      if (n instanceof Element) {
        if (n.matches("script,style,noscript,input,textarea,select,[data-tbb-overlay]") || !shown(n)) return;
        const block = /^(block|flex|grid|table|list-item)/.test(getComputedStyle(n).display) || n.tagName === "BR";
        if (block) out += "\n";
        for (const c of n.shadowRoot?.childNodes || n.childNodes) walk(c);
        if (block) out += "\n";
      } else for (const c of n.childNodes) walk(c);
    }
    if (document.body) walk(document.body);
    return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function observe() {
    blocked(); nodes.clear(); signatures.clear();
    const candidates = deep("a[href],button,input,textarea,select,form,[role],[tabindex],[onclick],[contenteditable],label,summary,canvas,div,span,li").filter(e => {
      if (!shown(e) || e.closest("[data-tbb-overlay]")) return false;
      if (e.matches("a[href],button,input,textarea,select,form,[role],[tabindex],[onclick],[contenteditable],label,summary,canvas")) return true;
      const t = text(e);
      // Covers custom menus with delegated handlers, without returning every layout wrapper.
      return t.length > 0 && t.length <= 100 && (getComputedStyle(e).cursor === "pointer" || e.children.length === 0);
    });
    candidates.sort((a, b) => Number(!a.matches('a[href],button,input,textarea,select,[role],[contenteditable=true]')) - Number(!b.matches('a[href],button,input,textarea,select,[role],[contenteditable=true]')));
    const elements = candidates.slice(0, 2500).map((e, i) => {
      const id = `e${i + 1}`; nodes.set(id, e); signatures.set(id, signature(e));
      const item: any = { elementId: id, tag: e.tagName.toLowerCase(), type: e.getAttribute("type") || "", role: role(e), label: label(e), name: label(e),
        disabled: e.matches(":disabled,[aria-disabled=true],[inert]") || !!e.closest("[inert]"), sensitive: secret(e), bounds: box(e),
        checked: e.matches("input") ? (e as HTMLInputElement).checked : e.getAttribute("aria-checked"), expanded: e.getAttribute("aria-expanded") };
      if (e instanceof HTMLAnchorElement) item.url = e.href;
      if (e instanceof HTMLSelectElement) item.options = [...e.options].map(o => ({ text: o.text, value: o.value, selected: o.selected }));
      if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) item.value = secret(e) ? "[已隐藏]" : e.type === "file" ? "[文件控件]" : e.value.slice(0, 2000);
      return item;
    });
    const allLinks = deep("a[href]").filter(shown).map(e => ({ text: label(e), url: (e as HTMLAnchorElement).href })).filter(e => /^https?:/.test(e.url));
    const tableElements = deep('table,[role=table],[role=grid],[role=treegrid]').filter(shown);
    const tables = tableElements.slice(0, 100).map(t => {
      const rows = t instanceof HTMLTableElement ? [...t.rows] : [...t.querySelectorAll('[role=row]')];
      return rows.filter(shown).slice(0, 500).map(r => (r instanceof HTMLTableRowElement ? [...r.cells] : [...r.querySelectorAll('[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]')]).map(c => text(c).slice(0, 2000)));
    });
    const body = bodyText(); observedURL = location.href; version = `${doc}:${++revision}`;
    return { url: location.href, title: document.title, version, body: body.slice(0, 600000), links: allLinks.slice(0, 3000), tables, elements,
      viewport: geometry(), tableInfo: tableElements.slice(0, 100).map((t, i) => ({ tableIndex: i, loadedRows: tables[i].length, declaredRows: Number(t.getAttribute("aria-rowcount")) || null,
        partial: Number(t.getAttribute("aria-rowcount")) > tables[i].length || t.querySelectorAll('tr,[role=row]').length > 500, scope: "当前已加载行" })),
      limits: { bodyTruncated: body.length > 600000, elementsTruncated: candidates.length > 2500, linksTruncated: allLinks.length > 3000, tablesTruncated: tableElements.length > 100, canvas: "画布请按需截图；未加载列表需滚动或翻页" } };
  }
  function validate(v: string) { blocked(); if (!v || v !== version || observedURL !== location.href) fail("STALE_PAGE", "观察已过期，请重新读取页面"); }
  function get(p: any, sensitiveOK = false) {
    validate(p.version); const e = nodes.get(p.elementId);
    if (!e?.isConnected || !shown(e)) fail("ELEMENT_NOT_FOUND", "目标已消失或隐藏，请重新观察");
    if (signature(e!) !== signatures.get(p.elementId)) fail("STALE_PAGE", "目标内容或状态已改变，请重新观察");
    if (!sensitiveOK && secret(e!)) fail("SENSITIVE_CONTROL", "密码和验证码由用户输入");
    if (e!.matches(":disabled,[aria-disabled=true]") || e!.closest("[inert]")) fail("CONTROL_DISABLED", "目标已禁用");
    return e!;
  }
  function geometry() {
    let layoutHash = 2166136261;
    for (const [id, e] of nodes) {
      const b = box(e); if (b.y > innerHeight || b.y + b.height < 0) continue;
      const value = id + JSON.stringify(b) + signature(e);
      for (let i = 0; i < value.length; i++) layoutHash = Math.imul(layoutHash ^ value.charCodeAt(i), 16777619);
    }
    return { width: innerWidth, height: innerHeight, scrollX, scrollY, dpr: devicePixelRatio, scale: visualViewport?.scale || 1, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight, layoutHash: layoutHash >>> 0 };
  }
  function atPoint(x: number, y: number) {
    let e = document.elementFromPoint(x, y);
    while (e?.shadowRoot) { const next = e.shadowRoot.elementFromPoint(x, y); if (!next || next === e) break; e = next; }
    if (!e) fail("TARGET_OUTSIDE_VIEWPORT", "目标不在当前可见区域");
    if (secret(e!)) fail("SENSITIVE_CONTROL", "密码和验证码由用户输入");
    return e!;
  }
  function describe(e: Element) { return { ...box(e), tag: e.tagName.toLowerCase(), type: e.getAttribute("type"), role: role(e), name: label(e),
    url: (e.closest("a[href]") as HTMLAnchorElement)?.href, formURL: e instanceof HTMLFormElement ? e.action : (e as HTMLInputElement).form?.action,
    checked: e instanceof HTMLInputElement ? e.checked : e.getAttribute("aria-checked") === "true", sensitive: secret(e), editable: e.matches("input,textarea") || (e as HTMLElement).isContentEditable }; }
  async function handle(method: string, p: any): Promise<any> {
    switch (method) {
      case "observe": return observe();
      case "validate": validate(p.version); return { valid: true };
      case "geometry": blocked(); return geometry();
      case "fullpageBegin": {
        blocked();
        if (containerCapture) fail("CAPTURE_IN_PROGRESS", "此页面正在截图");
        // Dashboard shells often keep the document fixed and scroll only their main panel.
        if (document.documentElement.scrollHeight > innerHeight + 2) return null;
        const candidates = deep("*").filter(e => {
          if (e === document.documentElement || e === document.body || !shown(e)) return false;
          const r = e.getBoundingClientRect();
          return /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 2 &&
            e.clientWidth > innerWidth * .5 && e.clientHeight > innerHeight * .35 &&
            r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
        }).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
        const e = candidates[0]; if (!e) return null;
        containerCapture = { id: crypto.randomUUID(), element: e, x: e.scrollLeft, y: e.scrollTop, height: e.scrollHeight, width: e.clientWidth, viewHeight: e.clientHeight };
        return { captureId: containerCapture.id, contentHeight: e.scrollHeight, width: e.clientWidth, viewHeight: e.clientHeight, additionalScrollRegions: candidates.length - 1 };
      }
      case "fullpageScroll": {
        blocked(); const s = containerCapture;
        if (!s || s.id !== p.captureId || !s.element.isConnected) fail("STALE_PAGE", "截图区域已改变");
        const e = s!.element, offset = Number(p.offsetY);
        if (!Number.isFinite(offset) || offset < 0 || offset >= s!.height) fail("INVALID_REGION", "截图续页位置无效");
        e.scrollTo({ left: 0, top: offset, behavior: "instant" }); await painted();
        const r = e.getBoundingClientRect();
        if (e.clientWidth !== s!.width || e.clientHeight !== s!.viewHeight || e.scrollHeight < s!.height) fail("STALE_PAGE", "截图过程中页面尺寸发生改变，请重新观察：" + JSON.stringify({expected:[s!.width,s!.viewHeight,s!.height],actual:[e.clientWidth,e.clientHeight,e.scrollHeight]}));
        const inset = offset - e.scrollTop, height = Math.min(s!.viewHeight - inset, s!.height - offset);
        if (inset < 0 || height <= 0) fail("INVALID_REGION", "无法定位整页截图分段");
        return { x: r.x + e.clientLeft + scrollX, y: r.y + e.clientTop + scrollY + inset, width: e.clientWidth, height, scale: 1 };
      }
      case "fullpageEnd": {
        const s = containerCapture;
        if (s && s.id === p.captureId) { containerCapture = undefined; if (s.element.isConnected) { s.element.scrollTo({ left: s.x, top: s.y, behavior: "instant" }); await painted(); } }
        return {};
      }
      case "inspect": return describe(get(p));
      case "target": {
        const e = get(p); e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const r = e.getBoundingClientRect(), x = Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)), y = Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2));
        const hit = atPoint(x, y);
        // A shadow descendant's composed ancestor can be the requested host.
        let composed: Element | null = hit;
        while (composed && composed !== e) composed = composed.parentElement || (composed.getRootNode() as ShadowRoot).host || null;
        if (!composed && hit !== e && !e.contains(hit)) fail("TARGET_OCCLUDED", "目标被其他内容遮挡，请重新观察");
        return { ...describe(e), center: { x, y } };
      }
      case "point": blocked(); return describe(atPoint(p.x, p.y));
      case "focused": { const active = document.activeElement; if (!active) fail("NO_FOCUS", "请先选择输入目标"); return describe(active!); }
      case "mark": {
        const e = get(p); e.setAttribute("data-team-browser-target", p.marker); return describe(e);
      }
      case "clearMarks": deep("[data-team-browser-target]").forEach(e => e.removeAttribute("data-team-browser-target")); return {};
      case "select": {
        const e = get(p); if (!(e instanceof HTMLSelectElement)) fail("INVALID_CONTROL", "自定义下拉框请点击选项；此操作需要 select 控件");
        const el = e as HTMLSelectElement, values: string[] = p.values || [];
        if (!el.multiple && values.length !== 1 || values.some(v => ![...el.options].some(o => o.value === v && !o.disabled))) fail("INVALID_SELECTION", "选项不可用");
        for (const o of el.options) o.selected = values.includes(o.value);
        el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); version = ""; return { performed: "select" };
      }
      case "submit": { const e = get(p), f = e instanceof HTMLFormElement ? e : (e as HTMLInputElement).form; if (!f) fail("INVALID_FORM", "没有关联表单"); f!.requestSubmit(); version = ""; return { performed: "submit" }; }
      case "selectText": { const e = get(p); const range = document.createRange(); range.selectNodeContents(e); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range); return { text: selection?.toString().slice(0, 600000) || "" }; }
      case "invalidate": version = ""; return {};
      case "mask": {
        blocked();
        for (const e of deep("input,textarea,[contenteditable]")) if (secret(e) && shown(e)) {
          const r = e.getBoundingClientRect(), mask = document.createElement("div"); mask.setAttribute("data-tbb-overlay", "mask");
          Object.assign(mask.style, { position: "absolute", left: `${r.left + scrollX}px`, top: `${r.top + scrollY}px`, width: `${r.width}px`, height: `${r.height}px`, background: "#20252e", zIndex: "2147483647", pointerEvents: "none" });
          document.documentElement.append(mask); masks.push(mask);
        }
        return { masked: masks.length };
      }
      case "unmask": for (const m of masks.splice(0)) m.remove(); return {};
      case "pickRegion": {
        blocked();
        return new Promise((resolve, reject) => {
          const overlay = document.createElement("div"), rect = document.createElement("div"), hint = document.createElement("div");
          overlay.setAttribute("data-tbb-overlay", "region");
          Object.assign(overlay.style, { position: "fixed", inset: "0", zIndex: "2147483647", cursor: "crosshair", background: "#00394022" });
          Object.assign(rect.style, { position: "fixed", border: "2px solid #0b8286", background: "#ffffff44", pointerEvents: "none" });
          Object.assign(hint.style, { position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)", padding: "12px", background: "white", color: "#123", borderRadius: "8px" }); hint.textContent = "拖动框选截图区域，Esc 取消";
          overlay.append(rect, hint); document.documentElement.append(overlay); let start: { x: number; y: number } | undefined;
          const cleanup = () => { clearTimeout(timer); overlay.remove(); document.removeEventListener("keydown", key, true); };
          const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); cleanup(); reject({ code: "CANCELLED", message: "已取消框选" }); } };
          const timer = setTimeout(() => { cleanup(); reject({ code: "TIMEOUT", message: "框选已超时" }); }, 60000);
          document.addEventListener("keydown", key, true);
          overlay.onpointerdown = e => { start = { x: e.clientX, y: e.clientY }; overlay.setPointerCapture(e.pointerId); };
          overlay.onpointermove = e => { if (start) Object.assign(rect.style, { left: Math.min(start.x, e.clientX) + "px", top: Math.min(start.y, e.clientY) + "px", width: Math.abs(e.clientX - start.x) + "px", height: Math.abs(e.clientY - start.y) + "px" }); };
          overlay.onpointerup = e => { if (!start) return; const result = { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) }; cleanup(); if (result.width < 2 || result.height < 2) reject({ code: "INVALID_REGION", message: "区域太小" }); else resolve(result); };
        });
      }
      default: fail("UNKNOWN_METHOD", "不支持该页面操作");
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.scope !== "browser-bridge" || sender.id !== chrome.runtime.id) return;
    void handle(message.method, message.params || {}).then(result => reply({ result }), error => reply({ error: { code: error.code || "PAGE_ERROR", message: error.message || String(error) } }));
    return true;
  });
})();
