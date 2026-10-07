import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function concurrencyChecks({ a, b, sa, sb, origin, ui, browser, check, waitFor }) {
  const clients = [a,b], sessions = [sa,sb];
  const getWindows = () => ui.evaluate(() => chrome.windows.getAll({ populate:true }));
  const tabs = await Promise.all(clients.map((c,i) => c.tool('tab_open', { sessionId:sessions[i].sessionId, url:origin+'/advanced?parallel='+i, operationId:randomUUID() })));
  const base = i => ({sessionId:sessions[i].sessionId,tabId:tabs[i].tabId});
  const obs = i => clients[i].tool('page_observe',base(i));
  const act = async (i,name,action='click',extra={}) => {
    const p=await obs(i), e=p.elements.find(e => e.name===name);
    assert.ok(e,'target '+name);
    return clients[i].tool('page_action',{...base(i),pageVersion:p.pageVersion,elementId:e.elementId,frameId:e.frameId,action,operationId:randomUUID(),...extra});
  };
  await check('each session has an exclusive named window and explicit ownership', async () => {
    assert.equal(sa.windowMode,'dedicated');assert.equal(sb.focusPolicy,'background');
    assert.ok(Number.isInteger(sa.windowId));assert.notEqual(sa.windowId,sb.windowId);
    for(let i=0;i<2;i++) {
      assert.equal(tabs[i].windowId,sessions[i].windowId);
      const listed=await clients[i].tool('tabs_list',{sessionId:sessions[i].sessionId});
      assert.equal(listed.windowId,sessions[i].windowId);
      assert.ok(listed.tabs.every(t=>t.inTaskWindow && t.windowId===listed.windowId && t.sessionId===sessions[i].sessionId),JSON.stringify(listed));
      const available=await clients[i].tool('tabs_list',{sessionId:sessions[i].sessionId,scope:'available'});
      assert.ok(!available.tabs.some(t=>t.windowId===sessions[1-i].windowId));
    }
    await ui.reload();
    await ui.getByText(`1 个任务标签页 · 独立窗口 ${sa.windowId} · 后台操作`,{exact:true}).waitFor();
    return {windowA:sa.windowId,windowB:sb.windowId};
  });
  await check('parallel background input click scroll and screenshots never steal active tabs or windows',async()=>{
    // Observe Chrome activation events as well as final state, so a transient focus
    // switch followed by restoration cannot pass this test.
    await ui.evaluate(async()=>{
      const t=await chrome.tabs.getCurrent();await chrome.windows.update(t.windowId,{focused:true});await chrome.tabs.update(t.id,{active:true});
      window.activationEvents=[];
      chrome.tabs.onActivated.addListener(e=>window.activationEvents.push({kind:'tab',...e}));
      chrome.windows.onFocusChanged.addListener(id=>window.activationEvents.push({kind:'window',id}));
    });
    await new Promise(r=>setTimeout(r,200));
    await ui.evaluate(()=>window.activationEvents=[]);
    const before=await getWindows();
    for(let round=0;round<4;round++) {
      await Promise.all([0,1].map(async i=>{
        const marker=`session-${i}-round-${round}`;
        await act(i,'连续输入','fill',{text:marker});
        const typed=await obs(i);
        await clients[i].tool('page_action',{...base(i),pageVersion:typed.pageVersion,action:'type',text:'-OK',operationId:randomUUID()});
        await act(i,'双击目标','doubleClick');
        const p=await obs(i);
        assert.equal(p.elements.find(e=>e.name==='连续输入').value,marker+'-OK');
        assert.match(p.body,/双击 true/);
        await act(i,'滚动列表','scroll',{y:140});
        const shot=await clients[i].tool('page_screenshot',base(i));
        assert.ok(shot.images[0].width>0);assert.ok(shot.screenshotId);
      }));
    }
    const after=await getWindows();
    for(const w of before) {
      const current=after.find(x=>x.id===w.id);assert.ok(current);
      assert.equal(current.focused,w.focused);
      assert.equal(current.tabs.find(t=>t.active)?.id,w.tabs.find(t=>t.active)?.id);
    }
    assert.deepEqual(await ui.evaluate(()=>window.activationEvents),[]);
    return {rounds:4,sessions:2,activationEvents:0};
  });
  await check('claimed page moves into its task window and foreign-window claims are rejected',async()=>{
    await ui.bringToFront();
    const privatePage=await browser.newPage();await privatePage.goto(origin+'/frame?claim-window=1');
    const available=await a.tool('tabs_list',{sessionId:sa.sessionId,scope:'available'});
    const target=available.tabs.find(t=>t.url===privatePage.url());assert.ok(target);
    const stale=await b.tool('tabs_list',{sessionId:sb.sessionId,scope:'available'});
    const foreignToken=stale.tabs.find(t=>t.tabId===target.tabId).discoveryToken;
    const claimed=await a.tool('tab_claim',{sessionId:sa.sessionId,tabId:target.tabId,discoveryToken:target.discoveryToken,operationId:randomUUID()});
    assert.equal(claimed.windowId,sa.windowId);
    await assert.rejects(b.tool('tab_claim',{sessionId:sb.sessionId,tabId:target.tabId,discoveryToken:foreignToken,operationId:randomUUID()}),e=>e.code==='SESSION_ISOLATION');
    await a.tool('tab_release',{sessionId:sa.sessionId,tabId:target.tabId,operationId:randomUUID()});
    assert.ok(!(await b.tool('tabs_list',{sessionId:sb.sessionId,scope:'available'})).tabs.some(t=>t.tabId===target.tabId));
    await privatePage.close();
  });
  await check('manual cross-window moves fail closed and task popups retain ownership',async()=>{
    await ui.evaluate(async({tabId,windowId})=>chrome.tabs.move(tabId,{windowId,index:-1}),{tabId:tabs[0].tabId,windowId:sb.windowId});
    await assert.rejects(obs(0),e=>e.code==='WINDOW_ISOLATION');
    await assert.rejects(b.tool('page_observe',{sessionId:sb.sessionId,tabId:tabs[0].tabId}),e=>e.code==='SESSION_ISOLATION');
    await ui.evaluate(async({tabId,windowId})=>chrome.tabs.move(tabId,{windowId,index:-1}),{tabId:tabs[0].tabId,windowId:sa.windowId});
    await act(0,'打开子页面');
    const child=await waitFor(async()=>{
      const r=await a.tool('tabs_list',{sessionId:sa.sessionId});return r.tabs.find(t=>t.url.includes('child=1') && t.windowId===sa.windowId);
    });
    await a.tool('tab_close',{sessionId:sa.sessionId,tabId:child.tabId,operationId:randomUUID()});
    return {movedTabRejected:true,popupWindowId:child.windowId};
  });
  await check('concurrent first opens share exactly one task window and end preserves claimed pages',async()=>{
    const s=await a.tool('session_start',{name:'窗口生命周期验收'});
    const opened=await Promise.all([1,2,3].map(n=>a.tool('tab_open',{sessionId:s.sessionId,url:origin+'/frame?lifecycle='+n,operationId:randomUUID()})));
    assert.ok(opened.every(t=>t.windowId===s.windowId));
    await ui.bringToFront();
    const p=await browser.newPage();await p.goto(origin+'/frame?preserve=1');
    const available=await a.tool('tabs_list',{sessionId:s.sessionId,scope:'available'}),t=available.tabs.find(t=>t.url===p.url());
    await a.tool('tab_claim',{sessionId:s.sessionId,tabId:t.tabId,discoveryToken:t.discoveryToken,operationId:randomUUID()});
    await a.tool('session_end',{sessionId:s.sessionId});
    assert.equal(p.isClosed(),false);
    const w=(await getWindows()).find(w=>w.id===s.windowId);assert.equal(w.tabs.length,1);assert.equal(w.tabs[0].id,t.tabId);
    assert.ok((await b.tool('tabs_list',{sessionId:sb.sessionId,scope:'available'})).tabs.some(x=>x.tabId===t.tabId));
    await p.close();
    const empty=await a.tool('session_start',{name:'空窗口结束'});await a.tool('session_end',{sessionId:empty.sessionId});
    assert.ok(!(await getWindows()).some(w=>w.id===empty.windowId));
  });
  await check('closing an owner window cannot grant access to a moved tab and the next open recreates ownership',async()=>{
    const s=await a.tool('session_start',{name:'关闭窗口归属验收'});
    const tab=await a.tool('tab_open',{sessionId:s.sessionId,url:origin+'/frame?close-window=1',operationId:randomUUID()});
    await ui.evaluate(async({tabId,windowId,oldWindow})=>{
      await chrome.tabs.move(tabId,{windowId,index:-1});await chrome.windows.remove(oldWindow);
    },{tabId:tab.tabId,windowId:sb.windowId,oldWindow:s.windowId});
    await assert.rejects(a.tool('page_observe',{sessionId:s.sessionId,tabId:tab.tabId}),e=>e.code==='WINDOW_ISOLATION');
    const recreated=await a.tool('tab_open',{sessionId:s.sessionId,url:origin+'/frame?recreated=1',operationId:randomUUID()});
    assert.notEqual(recreated.windowId,sb.windowId);assert.notEqual(recreated.windowId,s.windowId);
    await a.tool('session_end',{sessionId:s.sessionId});
  });
  await Promise.all([0,1].map(i=>clients[i].tool('tab_close',{...base(i),operationId:randomUUID()})));
}
