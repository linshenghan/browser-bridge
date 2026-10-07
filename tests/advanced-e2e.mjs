import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile);
export async function advancedChecks({a,b,sa,sb,origin,check,waitFor,uploadPath,browser,ui}) {
  const tab = await a.tool('tab_open',{sessionId:sa.sessionId,url:origin+'/advanced',operationId:randomUUID()});
  const base={sessionId:sa.sessionId,tabId:tab.tabId};
  const obs=()=>a.tool('page_observe',base);
  const act=async(name,action='click',extra={})=>{
    const p=await obs(); const candidates=p.elements.filter(e=>e.name===name);
    assert.ok(candidates.length,'target '+name);
    const e=candidates.find(e=>e.role!=='generic')||candidates[0];
    return a.tool('page_action',{...base,pageVersion:p.pageVersion,elementId:e.elementId,frameId:e.frameId,action,operationId:randomUUID(),...extra});
  };
  await check('custom menus AX shadow DOM and visible structured content',async()=>{
    const p=await obs();assert.ok(!p.body.includes('禁止出现的隐藏正文'));assert.ok(p.body.includes('第一段可见正文。\n'));
    assert.equal(p.inaccessibleFrames.length,0);assert.equal(p.frames.length,3);
    assert.ok(p.tables.some(t=>t[1]?.includes('42')));assert.ok(p.tableInfo.some(t=>t.partial));
    await act('数据看板');assert.match((await obs()).body,/当前菜单：数据看板/);
    await act('近30日');assert.match((await obs()).body,/日期：近30日/);
    await act('Shadow 按钮');assert.match((await obs()).body,/Shadow 点击成功/);
    await act('封闭组件按钮');assert.match((await obs()).body,/封闭组件点击成功/);
    return {frames:p.frames.length,ariaTable:true,closedShadowViaAX:true};
  });
  await check('native hover double right click keyboard rich text and checkboxes',async()=>{
    await act('悬停菜单','hover');assert.match((await obs()).body,/悬停子菜单已打开/);
    await act('双击目标','doubleClick');assert.match((await obs()).body,/双击 true/);
    await act('右键目标','rightClick');assert.match((await obs()).body,/右键 true/);
    await act('连续输入','fill',{text:'ABC'});await act('连续输入','type',{text:'123'});
    assert.equal((await obs()).elements.find(e=>e.name==='连续输入').value,'ABC123');
    await act('连续输入','key',{key:'a',modifiers:['Control']});
    await a.tool('page_action',{...base,pageVersion:(await obs()).pageVersion,action:'type',text:'替换',operationId:randomUUID()});
    assert.equal((await obs()).elements.find(e=>e.name==='连续输入').value,'替换');
    await act('富文本','fill',{text:'富文本验证'});assert.match((await obs()).body,/富文本验证/);
    await act('同意选项','check');assert.equal((await obs()).elements.find(e=>e.name==='同意选项').checked,true);
    await act('同意选项','uncheck');assert.equal((await obs()).elements.find(e=>e.name==='同意选项').checked,false);
    await act('方案一','check');
    await act('自定义勾选','check');
  });
  await check('HTML drag container scrolling text selection and find',async()=>{
    await act('拖动源','hover');const p=await obs(),from=p.elements.find(e=>e.name==='拖动源'),to=p.elements.find(e=>e.name==='放置区');
    await a.tool('page_action',{...base,pageVersion:p.pageVersion,elementId:from.elementId,action:'drag',destination:{elementId:to.elementId},operationId:randomUUID()});
    assert.match((await obs()).body,/拖动完成：fixture-drag/);
    await act('滚动列表','scroll',{y:550});
    const found=await a.tool('page_find',{...base,name:'近7日',role:'tab',exact:true});assert.equal(found.matches.length,1);
    const r=await a.tool('page_action',{...base,pageVersion:found.pageVersion,elementId:found.matches[0].elementId,action:'selectText',operationId:randomUUID()});assert.equal(r.text,'近7日');
  });
  await check('viewport fullpage region element screenshots and actual MCP image content',async()=>{
    const p=await obs();
    for(const mode of ['viewport','fullpage','region','element']){
      const extra=mode==='region'?{region:{x:10,y:10,width:220,height:120}}:mode==='element'?{pageVersion:p.pageVersion,elementId:p.elements.find(e=>e.name==='连续输入').elementId}:{};
      const r=await a.request('tools/call',{name:'page_screenshot',arguments:{...base,mode,...extra}});
      assert.ok(!r.isError,JSON.stringify(r.content));assert.ok(r.content.some(c=>c.type==='image'&&c.mimeType==='image/png'));
      const meta=r.structuredContent;assert.ok(meta.screenshotId);assert.ok(meta.images.length);for(const im of meta.images){assert.ok(im.width>0&&im.height>0);assert.ok((await readFile(im.path)).length>100);}
      if(mode==='region'){assert.equal(meta.images[0].width,Math.round(220*meta.viewport.dpr));assert.equal(meta.images[0].height,Math.round(120*meta.viewport.dpr));}
      if(mode==='fullpage'){
        assert.ok(meta.images.reduce((v,i)=>v+i.height,0)>3500);
        const tile=meta.images.find(i=>i.clip.y<=2815&&i.clip.y+i.clip.height>2815);
        await run('python',['tests/assert-mask.py',tile.path,String(Math.round((55-tile.clip.x)*meta.viewport.dpr)),String(Math.round((2815-tile.clip.y)*meta.viewport.dpr))]);
      }
    }
  });
  await check('offscreen chart screenshot restores container and rejects stale coordinates',async()=>{
    const fixturePage=browser.pages().find(p=>p.url()===origin+'/advanced');
    const state=()=>fixturePage.evaluate(()=>({x:scrollX,y:scrollY,container:document.getElementById('chartScroller').scrollTop}));
    const before=await state(),p=await obs(),e=p.elements.find(e=>e.name==='容器底部图表');assert.ok(e);
    const shot=await a.tool('page_screenshot',{...base,mode:'element',pageVersion:p.pageVersion,elementId:e.elementId,frameId:e.frameId});
    await run('python',['tests/assert-mask.py',shot.path,'20','20','36,92,164']);
    assert.equal(shot.scrollRestored,true);assert.equal(shot.coordinateActionReady,false);assert.deepEqual(await state(),before);
    await assert.rejects(a.tool('page_action',{...base,pageVersion:shot.pageVersion,action:'click',target:{screenshotId:shot.screenshotId,x:20,y:20},operationId:randomUUID()}),e=>e.code==='STALE_SCREENSHOT');
    return {path:shot.path,scrollRestored:true,staleCoordinatesRejected:true};
  });
  await check('dashboard fullpage scroll segments continuation masking and restoration',async()=>{
    const t=await a.tool('tab_open',{sessionId:sa.sessionId,url:origin+'/scroll-page',operationId:randomUUID()}),args={sessionId:sa.sessionId,tabId:t.tabId};
    const page=browser.pages().find(p=>p.url()===origin+'/scroll-page');
    let shot=await a.tool('page_screenshot',{...args,mode:'fullpage'});
    assert.equal(shot.captureScope,'main-scroll-container');assert.equal(shot.loadedContentHeight,8700);assert.equal(shot.truncated,true);assert.equal(shot.images.length,20);
    assert.equal(shot.coordinateActionReady,false);assert.equal(await page.evaluate(()=>document.getElementById('panel').scrollTop),0);
    const tile=shot.images.find(i=>i.contentOffsetY===2000);
    await run('python',['tests/assert-mask.py',tile.path,String(Math.round(50*tile.width/tile.clip.width)),String(Math.round(210*tile.height/tile.clip.height))]);
    const offset=shot.nextOffsetY;
    shot=await a.tool('page_screenshot',{...args,mode:'fullpage',offsetY:offset});assert.equal(shot.truncated,false);
    const last=shot.images.at(-1);assert.equal(last.contentOffsetY+last.clip.height,8700);
    await run('python',['tests/assert-mask.py',last.path,'30',String(Math.round((8520-last.contentOffsetY)*last.height/last.clip.height)),'24,107,112']);
    assert.equal(await page.evaluate(()=>document.getElementById('panel').scrollTop),0);
    await a.tool('tab_close',{...args,operationId:randomUUID()});
    return {height:8700,continuation:offset,sensitiveInputsMasked:true,restored:true};
  });
  await check('paused animation frames do not hang or replay input and element capture',async()=>{
    const t=await a.tool('tab_open',{sessionId:sa.sessionId,url:origin+'/paused-paint',operationId:randomUUID()}),args={sessionId:sa.sessionId,tabId:t.tabId};
    const p=await a.tool('page_observe',args),button=p.elements.find(e=>e.name==='执行一次');
    await a.tool('page_action',{...args,pageVersion:p.pageVersion,elementId:button.elementId,action:'click',operationId:randomUUID()});
    const page=browser.pages().find(p=>p.url()===origin+'/paused-paint');assert.equal(await page.locator('#result').innerText(),'1');
    const fresh=await a.tool('page_observe',args),canvas=fresh.elements.find(e=>e.role==='canvas');
    const shot=await a.tool('page_screenshot',{...args,mode:'element',pageVersion:fresh.pageVersion,elementId:canvas.elementId});
    await run('python',['tests/assert-mask.py',shot.path,'20','20','36,92,164']);
    await a.tool('tab_close',{...args,operationId:randomUUID()});
  });
  await check('screenshots and coordinate clicks at 100 125 150 200 percent zoom',async()=>{
    try {
      for (const zoom of [1,1.25,1.5,2]) {
        await ui.evaluate(({tabId,zoom})=>chrome.tabs.setZoom(tabId,zoom),{tabId:tab.tabId,zoom});
        await act('趋势图','hover');const p=await obs(),e=p.elements.find(e=>e.name==='趋势图'),shot=await a.tool('page_screenshot',base);
        const count=Number(p.body.match(/图表坐标点击 true 次数 (\d+)/)?.[1]||0);
        assert.equal(shot.images[0].width,Math.round(shot.images[0].clip.width*shot.viewport.dpr));
        await run('python',['tests/assert-mask.py',shot.images[0].path,String(Math.round((e.bounds.x+20)*shot.viewport.dpr)),String(Math.round((e.bounds.y+20)*shot.viewport.dpr)),'24,107,112']);
        await a.tool('page_action',{...base,pageVersion:shot.pageVersion,action:'click',target:{screenshotId:shot.screenshotId,x:(e.bounds.x+20)*shot.viewport.dpr,y:(e.bounds.y+20)*shot.viewport.dpr},operationId:randomUUID()});
        assert.match((await obs()).body,/图表坐标点击 true/);
        const after=(await obs()).body.match(/图表坐标点击 true 次数 (\d+)/)?.[1];
        assert.equal(Number(after),count+1,JSON.stringify({zoom,count,after,bounds:e.bounds,screenshot:shot.path,viewport:shot.viewport}));
      }
    } finally { await ui.evaluate(tabId=>chrome.tabs.setZoom(tabId,1),tab.tabId); }
  });
  await check('coordinate screenshot click and stale scroll rejection',async()=>{
    await act('趋势图','hover');const p=await obs(),canvas=p.elements.find(e=>e.name==='趋势图');
    const shot=await a.tool('page_screenshot',base);
    const target={screenshotId:shot.screenshotId,x:(canvas.bounds.x+30)*shot.viewport.dpr,y:(canvas.bounds.y+30)*shot.viewport.dpr};
    await a.tool('page_action',{...base,pageVersion:shot.pageVersion,target,action:'click',operationId:randomUUID()});assert.match((await obs()).body,/图表坐标点击 true/);
    const fresh=await a.tool('page_screenshot',base);
    await a.tool('page_action',{...base,pageVersion:fresh.pageVersion,action:'scroll',y:200,operationId:randomUUID()});
    await assert.rejects(a.tool('page_action',{...base,pageVersion:fresh.pageVersion,action:'click',target:{...target,screenshotId:fresh.screenshotId},operationId:randomUUID()}),e=>['STALE_PAGE','STALE_SCREENSHOT'].includes(e.code));
  });
  await check('iframe native input and element screenshot',async()=>{
    await act('内联输入','fill',{text:'内联成功'});assert.equal((await obs()).elements.find(e=>e.name==='内联输入').value,'内联成功');
    await act('嵌入输入','fill',{text:'跨进程成功'});const p=await obs(),e=p.elements.find(e=>e.name==='嵌入输入');assert.equal(e.value,'跨进程成功');
    const r=await a.tool('page_screenshot',{...base,mode:'element',pageVersion:p.pageVersion,elementId:e.elementId,frameId:e.frameId});assert.ok(r.images[0].width>30);
    await a.tool('page_action',{...base,pageVersion:r.pageVersion,action:'fill',text:'截图框架输入',target:{screenshotId:r.screenshotId,x:r.images[0].width/2,y:r.images[0].height/2},operationId:randomUUID()});
    assert.equal((await obs()).elements.find(e=>e.name==='嵌入输入').value,'截图框架输入');
  });
  await check('JavaScript dialogs and prompt completion without action replay',async()=>{
    const r=await act('打开提示框');let d=r.dialog;
    if(!d)try{d=(await a.tool('page_wait',{...base,condition:'dialog',timeoutSeconds:3})).dialog}catch(error){
      const page=browser.pages().find(p=>p.url()===origin+'/advanced');
      const evidence=await page.evaluate(()=>({events:window.fixturePointerEvents.slice(-10),target:JSON.stringify(document.getElementById('alertButton').getBoundingClientRect())}));
      throw new Error(error.message+' '+JSON.stringify({action:r,evidence}));
    }assert.ok(d);
    await a.tool('page_dialog',{...base,action:'accept',dialogId:d.dialogId,operationId:randomUUID()});
    const pr=await act('打开输入框'),pd=pr.dialog||(await a.tool('page_wait',{...base,condition:'dialog',timeoutSeconds:3})).dialog;
    await a.tool('page_dialog',{...base,action:'accept',dialogId:pd.dialogId,text:'验证备注',operationId:randomUUID()});
    assert.match((await obs()).body,/输入结果：验证备注/);
  });
  await check('file chooser upload through Chrome event',async()=>{
    const r=await act('选择附件');const chooserId=r.chooserId||(await a.tool('page_wait',{...base,condition:'fileChooser',timeoutSeconds:5})).chooserId;
    assert.ok(chooserId);await a.tool('file_upload',{...base,chooserId,files:[uploadPath],operationId:randomUUID()});assert.match((await obs()).body,/附件：authorized-upload.txt/);
  });
  await check('click export and blob download associated with the task',async()=>{
    for (const name of ['导出文件','导出本地表格']) {
      const ex=await a.tool('download_expect',{...base,operationId:randomUUID(),timeoutSeconds:10});
      await act(name);
      const d=await waitFor(async()=>{const v=await a.tool('download_status',{sessionId:sa.sessionId,expectationId:ex.expectationId});return v.state==='complete'?v:null},13000);
      assert.ok((await readFile(d.path)).length>0);assert.ok(d.path.includes(sa.sessionId));
      await assert.rejects(b.tool('download_status',{sessionId:sb.sessionId,expectationId:ex.expectationId}),e=>e.code==='SESSION_ISOLATION');
    }
  });
  await check('window open adopts only owned child tab',async()=>{
    const before=(await a.tool('tabs_list',{sessionId:sa.sessionId})).tabs.map(t=>t.tabId);
    await act('打开子页面');const r=await a.tool('page_wait',{...base,condition:'newTab',knownTabIds:before,timeoutSeconds:5});assert.equal(r.tabIds.length,1);
    await a.tool('tab_close',{sessionId:sa.sessionId,tabId:r.tabIds[0],operationId:randomUUID()});
  });
  await check('claim existing tab isolation release and preserve at session end',async()=>{
    await ui.bringToFront();
    const privatePage=await browser.newPage();await privatePage.goto(origin+'/frame?existing=1');
    const c=await a.tool('session_start',{name:'接管验收'}), cb={sessionId:c.sessionId};
    let list=await a.tool('tabs_list',{...cb,scope:'available'}), t=list.tabs.find(t=>t.url.includes('existing=1'));assert.ok(t,JSON.stringify(list));
    await a.tool('tab_claim',{...cb,tabId:t.tabId,discoveryToken:t.discoveryToken,operationId:randomUUID()});
    assert.ok(!(await b.tool('tabs_list',{sessionId:sb.sessionId,scope:'available'})).tabs.some(v=>v.tabId===t.tabId));
    await a.tool('tab_release',{...cb,tabId:t.tabId,operationId:randomUUID()});
    list=await a.tool('tabs_list',{...cb,scope:'available'});t=list.tabs.find(t=>t.url.includes('existing=1'));
    await a.tool('tab_claim',{...cb,tabId:t.tabId,discoveryToken:t.discoveryToken,operationId:randomUUID()});
    await a.tool('session_end',cb);assert.equal(privatePage.isClosed(),false);await privatePage.close();
  });
  await check('extension screenshot button saves through native service',async()=>{
    await ui.reload();await ui.locator('#capture-tab').selectOption(sa.sessionId+':'+tab.tabId);await ui.locator('#capture').click();await ui.locator('#capture-path').filter({hasText:'.png'}).waitFor({timeout:15000});
    const file=await ui.locator('#capture-path').innerText();assert.ok(file.includes(sa.outputDir));
  });
  await check('back forward reload and explicit waits',async()=>{
    await a.tool('page_navigate',{...base,pageVersion:(await obs()).pageVersion,url:origin+'/frame?history=1',operationId:randomUUID()});
    await a.tool('page_wait',{...base,condition:'navigation',url:origin+'/frame?history=1',timeoutSeconds:3});
    await a.tool('page_navigate',{...base,pageVersion:(await obs()).pageVersion,direction:'back',operationId:randomUUID()});assert.match((await obs()).body,/网页操作能力验收/);
    await a.tool('page_navigate',{...base,pageVersion:(await obs()).pageVersion,direction:'forward',operationId:randomUUID()});assert.match((await obs()).url,/history=1/);
    await a.tool('page_navigate',{...base,pageVersion:(await obs()).pageVersion,direction:'reload',operationId:randomUUID()});assert.match((await obs()).body,/已授权的嵌入内容/);
  });
  await check('user debugger cancellation stops only its task',async()=>{
    const session=await a.tool('session_start',{name:'取消控制验收'});
    const t=await a.tool('tab_open',{sessionId:session.sessionId,url:origin+'/frame?cancel=1',operationId:randomUUID()});
    await a.tool('page_observe',{sessionId:session.sessionId,tabId:t.tabId});
    // Test-only fault injection: emulate the user's Chrome debugger cancellation.
    await ui.evaluate(tabId=>chrome.debugger.detach({tabId}),t.tabId);
    await waitFor(async()=>{try{await a.tool('page_observe',{sessionId:session.sessionId,tabId:t.tabId});return false}catch(e){return e.code==='SESSION_STOPPED'}});
    assert.ok((await obs()).body);
    await a.tool('session_end',{sessionId:session.sessionId});
  });
  await a.tool('tab_close',{...base,operationId:randomUUID()});
}
