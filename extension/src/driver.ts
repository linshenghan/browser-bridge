import { BridgeError, normalizedOrigin } from "./protocol";
type Endpoint = { tabId: number; sessionId?: string };
type Connection = { endpoints: Map<string, Endpoint>; contexts: Map<number, string> };
export const capabilities = ["semantic-targets", "screenshots-v2", "native-input", "frames-v2", "claim-tabs", "wait-dialog", "download-expect", "file-chooser", "session-windows", "background-input"];
export class Driver {
  connections = new Map<number, Connection>();
  private opening = new Map<number, Promise<void>>();
  private intentional = new Set<number>();
  dialogs = new Map<number, any>();
  choosers = new Map<string, any>();
  drags = new Map<number, any>();
  onDownload: (tabId: number, event: any) => void = () => {};
  onPopup: (tabId: number, event: any) => void = () => {};
  constructor(private cancelled: (tabId: number) => void) {
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (!source.tabId) return;
      this.connections.delete(source.tabId); this.dialogs.delete(source.tabId);
      const expected = this.intentional.delete(source.tabId);
      if (!expected && reason === "canceled_by_user") this.cancelled(source.tabId);
    });
    chrome.debugger.onEvent.addListener((source, method, value: any) => { if (source.tabId) void this.event({ tabId: source.tabId, sessionId: source.sessionId }, method, value).catch(() => {}); });
  }
  async attach(tabId: number) {
    if (this.connections.has(tabId)) return;
    const pending = this.opening.get(tabId); if (pending) return pending;
    const job = (async () => {
      try { await chrome.debugger.attach({ tabId }, "1.3"); }
      catch (e) { throw new BridgeError("HOST_DENIED", "Chrome 拒绝连接，停止操作，不切换通道：" + String(e)); }
      this.connections.set(tabId, { endpoints: new Map([["", { tabId }]]), contexts: new Map() });
      await this.enable({ tabId });
    })(); this.opening.set(tabId, job);
    try { await job; } finally { this.opening.delete(tabId); }
  }
  async detach(tabId: number) {
    if (!this.connections.has(tabId)) return;
    this.intentional.add(tabId);
    try { await chrome.debugger.detach({ tabId }); }
    catch {} finally { this.connections.delete(tabId); this.dialogs.delete(tabId); this.intentional.delete(tabId); }
  }
  async cmd(endpoint: Endpoint, method: string, params: any = {}): Promise<any> {
    try { return await chrome.debugger.sendCommand(endpoint, method, params); }
    catch (e) {
      if (/Debugger is not attached|not attached to the tab/i.test(String(e))) {
        this.connections.delete(endpoint.tabId); this.cancelled(endpoint.tabId);
        throw new BridgeError("CONTROL_CANCELLED", "Chrome 控制连接已撤销，当前任务停止，不自动重新接管");
      }
      throw e;
    }
  }
  async enable(endpoint: Endpoint) {
    await this.cmd(endpoint, "Page.enable");
    await this.cmd(endpoint, "Runtime.enable");
    // Keep input scoped to this CDP target without activating an OS window/tab.
    await this.cmd(endpoint, "Emulation.setFocusEmulationEnabled", { enabled: true });
    await this.cmd(endpoint, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe", exclude: false }] });
  }
  private async event(source: Endpoint, method: string, p: any) {
    if (!source.tabId) return;
    const connection = this.connections.get(source.tabId); if (!connection) return;
    if (method === "Target.attachedToTarget" && p.targetInfo?.type === "iframe") {
      const endpoint = { tabId: source.tabId, sessionId: p.sessionId };
      connection.endpoints.set(p.sessionId, endpoint); await this.enable(endpoint);
    } else if (method === "Target.detachedFromTarget") connection.endpoints.delete(p.sessionId);
    else if (method === "Page.javascriptDialogOpening") this.dialogs.set(source.tabId, { ...p, dialogId: crypto.randomUUID(), endpoint: source });
    else if (method === "Page.javascriptDialogClosed") this.dialogs.delete(source.tabId);
    else if (method === "Page.fileChooserOpened") {
      const chooserId = crypto.randomUUID();
      this.choosers.set(chooserId, { ...p, chooserId, endpoint: source, tabId: source.tabId, created: Date.now() });
    } else if (method === "Input.dragIntercepted") this.drags.set(source.tabId, p.data);
    else if (method === "Page.downloadWillBegin") this.onDownload(source.tabId, p);
    else if (method === "Page.windowOpen") this.onPopup(source.tabId, p);
  }
  async armChooser(tabId: number) {
    await this.attach(tabId);
    for (const ep of this.connections.get(tabId)!.endpoints.values()) await this.cmd(ep, "Page.setInterceptFileChooserDialog", { enabled: true });
  }
  latestChooser(tabId: number) { return [...this.choosers.values()].filter(c => c.tabId === tabId && Date.now() - c.created < 60000).at(-1); }
  async treeNode(tabId: number, marker: string) {
    await this.attach(tabId);
    function search(n: any): number | undefined {
      const a = n.attributes || [];
      for (let i = 0; i < a.length; i += 2) if (a[i] === "data-team-browser-target" && a[i + 1] === marker) return n.backendNodeId;
      for (const child of [...(n.children || []), ...(n.shadowRoots || []), ...(n.contentDocument ? [n.contentDocument] : [])]) { const id = search(child); if (id) return id; }
    }
    for (const endpoint of this.connections.get(tabId)!.endpoints.values()) {
      const { root } = await this.cmd(endpoint, "DOM.getDocument", { depth: -1, pierce: true });
      const backendNodeId = search(root); if (backendNodeId) return { endpoint, backendNodeId };
    }
    throw new BridgeError("FRAME_UNAVAILABLE", "目标所在框架已经改变，请重新观察");
  }
  async ax(tabId: number) {
    await this.attach(tabId); const result: any[] = [];
    for (const endpoint of this.connections.get(tabId)!.endpoints.values()) {
      const tree = await this.cmd(endpoint, "Accessibility.getFullAXTree");
      for (const n of tree.nodes || []) if (!n.ignored && n.backendDOMNodeId && /^(button|link|tab|menuitem|menuitemcheckbox|menuitemradio|checkbox|radio|combobox|textbox|slider|treeitem|option)$/.test(n.role?.value)) {
        result.push({ role: n.role.value, name: String(n.name?.value || "").slice(0, 300), backendNodeId: n.backendDOMNodeId, endpoint,
          disabled: n.properties?.some((p: any) => p.name === "disabled" && p.value?.value === true) || false });
      }
    }
    return result.slice(0, 2500);
  }
  async backend(target: any, scroll = false): Promise<any> {
    const resolved = await this.cmd(target.endpoint, "DOM.resolveNode", { backendNodeId: target.backendNodeId });
    const objectId = resolved.object.objectId;
    try {
      const result = await this.cmd(target.endpoint, "Runtime.callFunctionOn", {
        objectId, returnByValue: true, awaitPromise: true, arguments: [{ value: scroll }],
        functionDeclaration: `async function(scroll) {
          const e=this;if(!e.isConnected) return {error:'STALE_PAGE'};
          const status=performance.getEntriesByType('navigation')[0]?.responseStatus;
          if(status>=400||document.documentElement.getAttribute('data-team-browser-policy')==='deny'||/access denied|访问被拒绝|禁止自动化/i.test(document.title))return {error:'HOST_DENIED'};
          const secret = n => n && n.matches('input,textarea,[contenteditable]') && (n.type==='password' || /password|passwd|one-time-code|cc-number|cc-csc|验证码|密码|安全码/i.test(['name','id','autocomplete','aria-label','placeholder'].map(a=>n.getAttribute(a)||'').join(' ')));
          if(secret(e)) return {error:'SENSITIVE_CONTROL'};
          if(e.matches(':disabled,[aria-disabled=true]') || e.closest('[inert]')) return {error:'CONTROL_DISABLED'};
          if(scroll){e.scrollIntoView({block:'center',inline:'center',behavior:'instant'});await new Promise(resolve=>{const timer=setTimeout(resolve,250);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve()}));});}
          const r=e.getBoundingClientRect(),css=getComputedStyle(e);
          if(!r.width||!r.height||css.visibility==='hidden'||css.display==='none')return {error:'TARGET_HIDDEN'};
          let x=Math.max(0,Math.min(innerWidth-1,r.x+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.y+r.height/2));
          let hit=document.elementFromPoint(x,y);while(hit?.shadowRoot){const n=hit.shadowRoot.elementFromPoint(x,y);if(!n||n===hit)break;hit=n;}
          let p=hit;while(p&&p!==e)p=p.parentElement||p.getRootNode().host;
          let host=e.getRootNode().host,closedHit=false;while(host){if(hit===host)closedHit=true;host=host.getRootNode().host;}
          if(scroll&&!p&&!closedHit&&!e.contains(hit))return {error:'TARGET_OCCLUDED'};
          if(secret(hit))return {error:'SENSITIVE_CONTROL'};
          return {x:r.x,y:r.y,width:r.width,height:r.height,center:{x,y},name:(e.getAttribute('aria-label')||e.innerText||e.textContent||'').trim().slice(0,300),
            type:e.type,tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),editable:e.matches('input,textarea')||e.isContentEditable,checked:!!e.checked||e.getAttribute('aria-checked')==='true',
            signature:JSON.stringify([e.tagName,e.type,e.getAttribute('aria-label'),e.innerText,e.value,e.checked,e.getAttribute('href'),e.getAttribute('disabled')]),
            url:e.closest('a[href]')?.href,formURL:e.action||e.form?.action};
        }`,
      });
      if (result.exceptionDetails) throw new BridgeError("FRAME_UNAVAILABLE", "无法核对目标");
      if (result.result.value?.error) throw new BridgeError(result.result.value.error, `${result.result.value.error}：目标已变化、受限或被遮挡，请重新观察`);
      const info = result.result.value;
      if (info.url) normalizedOrigin(info.url); if (info.formURL) normalizedOrigin(info.formURL);
      return info;
    } finally { await this.cmd(target.endpoint, "Runtime.releaseObject", { objectId }).catch(() => {}); }
  }
  async prepareElementCapture(target: any): Promise<{ restore: () => Promise<void>; scrolled: boolean }> {
    const ep = target.endpoint;
    const { object } = await this.cmd(ep, "DOM.resolveNode", { backendNodeId: target.backendNodeId });
    let stateId: string | undefined;
    const restore = async () => {
      if (!stateId) return;
      try {
        await this.cmd(ep, "Runtime.callFunctionOn", { objectId: stateId, functionDeclaration: `function(){
          for(const item of this.records.slice().reverse()) if(item.element.isConnected)item.element.scrollTo({left:item.x,top:item.y,behavior:'instant'});
          this.window.scrollTo({left:this.x,top:this.y,behavior:'instant'});
        }` });
      } finally { await this.cmd(ep, "Runtime.releaseObject", { objectId: stateId }).catch(() => {}); }
    };
    try {
      const state = await this.cmd(ep, "Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: `function(){
        const records=[];let p=this;
        while(p){records.push({element:p,x:p.scrollLeft,y:p.scrollTop});p=p.parentElement||p.getRootNode().host;}
        const window=this.ownerDocument.defaultView;return {element:this,records,window,x:window.scrollX,y:window.scrollY};
      }` });
      stateId = state.result?.objectId;
      if (state.exceptionDetails || !stateId) throw new BridgeError("CAPTURE_PREPARE_FAILED", "无法保存截图前的滚动位置");
      const result = await this.cmd(ep, "Runtime.callFunctionOn", { objectId: stateId, awaitPromise: true, returnByValue: true, functionDeclaration: `async function(){
        const e=this.element,w=this.window;
        const visible=()=>{const r=e.getBoundingClientRect();let left=0,top=0,right=w.innerWidth,bottom=w.innerHeight;
          for(const {element:p} of this.records.slice(1)){const css=w.getComputedStyle(p),b=p.getBoundingClientRect();
            if(/auto|scroll|hidden|clip/.test(css.overflowX)){left=Math.max(left,b.left+p.clientLeft);right=Math.min(right,b.left+p.clientLeft+p.clientWidth);}
            if(/auto|scroll|hidden|clip/.test(css.overflowY)){top=Math.max(top,b.top+p.clientTop);bottom=Math.min(bottom,b.top+p.clientTop+p.clientHeight);}}
          return r.width>0&&r.height>0&&r.left>=left-1&&r.top>=top-1&&r.right<=right+1&&r.bottom<=bottom+1;};
        if(!visible())e.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
        await new Promise(resolve=>{const timer=w.setTimeout(resolve,250);w.requestAnimationFrame(()=>w.requestAnimationFrame(()=>{w.clearTimeout(timer);resolve()}));});
        return {visible:visible(),scrolled:this.x!==w.scrollX||this.y!==w.scrollY||this.records.some(i=>i.x!==i.element.scrollLeft||i.y!==i.element.scrollTop)};
      }` });
      if (result.exceptionDetails) throw new BridgeError("CAPTURE_PREPARE_FAILED", "截图准备失败");
      if (!result.result?.value?.visible) throw new BridgeError("ELEMENT_CAPTURE_CLIPPED", "元素大于可见滚动区域，不能完整截图；请滚动后使用区域截图");
      return { restore, scrolled: !!result.result.value.scrolled };
    } catch (error) { await restore().catch(() => {}); throw error; }
    finally { await this.cmd(ep, "Runtime.releaseObject", { objectId: object.objectId }).catch(() => {}); }
  }
  async topPoint(target: any, info: any) {
    // DOM.getContentQuads uses main-frame viewport coordinates, including child-frame offsets.
    const { quads } = await this.cmd(target.endpoint, "DOM.getContentQuads", { backendNodeId: target.backendNodeId });
    if (!quads?.length) throw new BridgeError("TARGET_HIDDEN", "目标没有可见位置");
    const q = quads[0];
    if (target.endpoint.sessionId) return { endpoint: target.endpoint, x: info.center.x, y: info.center.y };
    return { endpoint: target.endpoint, x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
  }
  async hit(tabId: number, x: number, y: number) {
    for (const endpoint of [...this.connections.get(tabId)!.endpoints.values()].reverse()) {
      if (!endpoint.sessionId) continue;
      const origin = await this.toTop(endpoint, 0, 0), metrics = await this.cmd(endpoint, "Page.getLayoutMetrics");
      const viewport = metrics.cssLayoutViewport || metrics.layoutViewport;
      if (x < origin.x || y < origin.y || x >= origin.x + viewport.clientWidth || y >= origin.y + viewport.clientHeight) continue;
      const { frameTree } = await this.cmd(endpoint, "Page.getFrameTree");
      if (/^https?:/.test(frameTree.frame.url)) normalizedOrigin(frameTree.frame.url);
      const hit = await this.cmd(endpoint, "DOM.getNodeForLocation", { x: Math.round(x - origin.x), y: Math.round(y - origin.y), includeUserAgentShadowDOM: false });
      return this.backend({ endpoint, backendNodeId: hit.backendNodeId });
    }
    const hit = await this.cmd({ tabId }, "DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false });
    const options: any[] = [];
    const find = (tree: any, id: string): any => tree.frame.id === id ? tree.frame : (tree.childFrames || []).map((c: any) => find(c, id)).find(Boolean);
    for (const endpoint of this.connections.get(tabId)!.endpoints.values()) {
      const { frameTree } = await this.cmd(endpoint, "Page.getFrameTree");
      const frame = find(frameTree, hit.frameId);
      if (frame) options.push({ endpoint, frame, exact: frameTree.frame.id === hit.frameId });
    }
    const chosen = options.find(o => o.exact) || options[0];
    if (!chosen || !hit.backendNodeId) throw new BridgeError("FRAME_UNAVAILABLE", "无法核对坐标对应的框架目标");
    if (/^https?:/.test(chosen.frame.url)) normalizedOrigin(chosen.frame.url);
    const info = await this.backend({ endpoint: chosen.endpoint, backendNodeId: hit.backendNodeId });
    if (["iframe", "frame"].includes(info.tag)) throw new BridgeError("FRAME_TARGET_REQUIRED", "嵌入区域没有返回可核对的目标，请重新观察");
    return info;
  }
  async toTop(endpoint: Endpoint, x: number, y: number, visited = new Set<string>()): Promise<{ x: number; y: number }> {
    if (!endpoint.sessionId) return { x, y };
    if (visited.has(endpoint.sessionId)) throw new BridgeError("FRAME_UNAVAILABLE", "框架关系无效");
    visited.add(endpoint.sessionId);
    const { frameTree } = await this.cmd(endpoint, "Page.getFrameTree");
    for (const parent of this.connections.get(endpoint.tabId)!.endpoints.values()) {
      if (parent.sessionId === endpoint.sessionId) continue;
      let owner: any;
      try { owner = await this.cmd(parent, "DOM.getFrameOwner", { frameId: frameTree.frame.id }); } catch { continue; }
      if (!owner?.backendNodeId) continue;
      const { model } = await this.cmd(parent, "DOM.getBoxModel", { backendNodeId: owner.backendNodeId });
      return this.toTop(parent, x + model.content[0], y + model.content[1], visited);
    }
    throw new BridgeError("FRAME_UNAVAILABLE", "无法计算嵌入框架位置");
  }
  async maskSensitive(tabId: number): Promise<() => Promise<void>> {
    const masks: { endpoint: Endpoint; objectId: string }[] = [];
    const cleanup = async () => { for (const m of masks) { await this.cmd(m.endpoint, "Runtime.callFunctionOn", { objectId: m.objectId, functionDeclaration: "function(){this.remove()}" }).catch(() => {}); await this.cmd(m.endpoint, "Runtime.releaseObject", { objectId: m.objectId }).catch(() => {}); } };
    try {
      for (const endpoint of this.connections.get(tabId)!.endpoints.values()) {
        const { root } = await this.cmd(endpoint, "DOM.getDocument", { depth: -1, pierce: true });
        const inputs: any[] = [];
        const collect = (n: any) => {
          const attrs: Record<string, string> = {}; for (let i = 0; i < (n.attributes?.length || 0); i += 2) attrs[n.attributes[i]] = n.attributes[i + 1];
          if (["INPUT", "TEXTAREA"].includes(n.nodeName) && (attrs.type === "password" || /password|passwd|one-time-code|cc-number|cc-csc|验证码|密码|安全码/i.test([attrs.name, attrs.id, attrs.autocomplete, attrs["aria-label"], attrs.placeholder].join(" ")))) inputs.push(n);
          for (const c of [...(n.children || []), ...(n.shadowRoots || []), ...(n.contentDocument ? [n.contentDocument] : [])]) collect(c);
        }; collect(root);
        for (const n of inputs) {
          const { object } = await this.cmd(endpoint, "DOM.resolveNode", { backendNodeId: n.backendNodeId });
          try {
            const { result, exceptionDetails } = await this.cmd(endpoint, "Runtime.callFunctionOn", { objectId: object.objectId,
              functionDeclaration: `function(){const r=this.getBoundingClientRect(),d=this.ownerDocument,w=d.defaultView,m=d.createElement('div');m.setAttribute('data-tbb-overlay','mask');Object.assign(m.style,{position:'absolute',left:(r.x+w.scrollX)+'px',top:(r.y+w.scrollY)+'px',width:r.width+'px',height:r.height+'px',background:'#20252e',zIndex:'2147483647',pointerEvents:'none'});d.documentElement.append(m);return m}` });
            if (exceptionDetails || !result.objectId) throw new BridgeError("MASK_FAILED", "无法遮盖敏感输入，截图已停止");
            masks.push({ endpoint, objectId: result.objectId });
          } finally { await this.cmd(endpoint, "Runtime.releaseObject", { objectId: object.objectId }).catch(() => {}); }
        }
      }
      return cleanup;
    } catch (e) { await cleanup(); throw e; }
  }
  async mouse(ep: Endpoint, type: string, x: number, y: number, extra: any = {}) {
    const command = this.cmd(ep, "Input.dispatchMouseEvent", { type, x, y, ...extra });
    // A JavaScript dialog can keep the input command pending. Report the dialog without replaying.
    let timer: ReturnType<typeof setInterval> | undefined;
    try { return await Promise.race([command, new Promise(resolve => { timer = setInterval(() => { if (this.dialogs.has(ep.tabId)) resolve({ dialogOpened: true }); }, 30); })]); }
    finally { if (timer) clearInterval(timer); }
  }
  async key(ep: Endpoint, key: string, modifiers = 0) {
    const names: Record<string, [string, number]> = { Enter: ["Enter", 13], Tab: ["Tab", 9], Escape: ["Escape", 27], Backspace: ["Backspace", 8], Delete: ["Delete", 46], ArrowLeft: ["ArrowLeft", 37], ArrowUp: ["ArrowUp", 38], ArrowRight: ["ArrowRight", 39], ArrowDown: ["ArrowDown", 40], Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34], Space: ["Space", 32] };
    const [code, vk] = names[key] || [key.length === 1 ? "Key" + key.toUpperCase() : key, key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0];
    if (!vk) throw new BridgeError("INVALID_KEY", "不支持的按键");
    await this.cmd(ep, "Input.dispatchKeyEvent", { type: "keyDown", key: key === "Space" ? " " : key, code, windowsVirtualKeyCode: vk, modifiers, ...(key === "Enter" ? { text: "\r" } : {}) });
    await this.cmd(ep, "Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
  }
}
