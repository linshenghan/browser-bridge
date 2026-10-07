export function advancedFixture(origin) {
  return `<!doctype html><meta charset="utf-8"><title>高级网页验收</title>
  <style>body{font:16px system-ui;margin:24px;color:#19363a}button,input,select,[role=tab],[role=checkbox]{padding:10px;margin:5px}nav div{display:inline-block;cursor:pointer;padding:12px;background:#dcefea}#plot{background:#186b70}#drop,#drag{display:inline-block;padding:30px;margin:10px;background:#ddd}#scrollbox{height:100px;overflow:auto;width:250px}.secret{position:absolute;top:2800px;left:40px}iframe{width:450px;height:150px}#hidden{display:none}</style>
  <h1>网页操作能力验收</h1><nav id="menu"><div>数据看板</div><div>内容分析</div></nav><p id="menuResult">尚未切换</p>
  <div role="tab" tabindex="0">近7日</div><div role="tab" tabindex="0">近30日</div>
  <button id="hover">悬停菜单</button><span id="hoverResult"></span><button id="double">双击目标</button><button id="right">右键目标</button><p id="pointerResult"></p>
  <input aria-label="连续输入"><input type="checkbox" aria-label="同意选项"><input type="radio" name="choice" aria-label="方案一"><div contenteditable="true" role="textbox" aria-label="富文本">原始内容</div>
  <div role="checkbox" aria-label="自定义勾选" aria-checked="false" tabindex="0"></div>
  <div id="shadow"></div><div id="closed"></div>
  <canvas id="plot" aria-label="趋势图" width="240" height="90"></canvas><p id="plotResult">尚未点击图表</p>
  <div id="drag" draggable="true" role="button">拖动源</div><div id="drop" role="button">放置区</div><p id="dragResult"></p>
  <div id="scrollbox" role="region" aria-label="滚动列表"><div style="height:650px">列表顶部</div><div>列表底部</div></div>
  <div id="chartScroller" style="height:180px;width:300px;overflow:auto" role="region" aria-label="图表滚动区"><div style="height:500px">图表上方内容</div><canvas aria-label="容器底部图表" width="180" height="80" style="background:rgb(36,92,164)"></canvas><div style="height:400px">图表下方内容</div></div>
  <div role="grid" aria-rowcount="100"><div role="row"><span role="columnheader">项目</span><span role="columnheader">数量</span></div><div role="row"><span role="gridcell">可见项</span><span role="gridcell">42</span></div></div>
  <div id="hidden">禁止出现的隐藏正文</div><p>第一段可见正文。</p><p>第二段可见正文。</p>
  <button id="alertButton">打开提示框</button><button id="promptButton">打开输入框</button><p id="dialogResult"></p>
  <button id="openTab">打开子页面</button><button id="export">导出文件</button><button id="blobExport">导出本地表格</button>
  <button id="upload">选择附件</button><input id="hiddenFile" type="file" hidden><p id="uploadResult"></p>
  <iframe src="about:blank" title="空白框架"></iframe><iframe srcdoc="<h2>内联框架</h2><input aria-label='内联输入'>" title="内联框架"></iframe>
  <iframe src="${origin.replace('127.0.0.1','localhost')}/frame" title="跨进程框架"></iframe>
  <p id="clock"></p><div style="height:3300px;background:linear-gradient(white,#ddf2ee)">长页内容</div>
  <input class="secret" type="password" aria-label="密码" value="never-export-secret"><input class="secret" style="top:2860px" autocomplete="one-time-code" aria-label="验证码" value="843927">
  <script>
  const by=id=>document.getElementById(id);
  window.fixturePointerEvents=[];for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,e=>window.fixturePointerEvents.push({type,id:e.target.id,x:e.clientX,y:e.clientY,trusted:e.isTrusted}),true);
  by('menu').addEventListener('click',e=>by('menuResult').textContent='当前菜单：'+e.target.textContent);
  document.querySelectorAll('[role=tab]').forEach(e=>e.onclick=()=>by('menuResult').textContent='日期：'+e.textContent);
  by('hover').onmouseenter=()=>by('hoverResult').textContent='悬停子菜单已打开';
  by('double').ondblclick=e=>by('pointerResult').textContent='双击 '+e.isTrusted;
  by('right').oncontextmenu=e=>{e.preventDefault();by('pointerResult').textContent='右键 '+e.isTrusted};
  document.querySelector('[role=checkbox]').onclick=e=>e.target.setAttribute('aria-checked',String(e.target.getAttribute('aria-checked')!=='true'));
  const sh=by('shadow').attachShadow({mode:'open'});sh.innerHTML='<button>Shadow 按钮</button><input aria-label="Shadow 输入">';sh.querySelector('button').onclick=()=>by('menuResult').textContent='Shadow 点击成功';
  const closed=by('closed').attachShadow({mode:'closed'});closed.innerHTML='<button aria-label="封闭组件按钮">封闭组件按钮</button>';closed.querySelector('button').onclick=()=>by('menuResult').textContent='封闭组件点击成功';
  let plotClicks=0;const ctx=by('plot').getContext('2d');ctx.strokeStyle='white';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(10,65);ctx.lineTo(100,40);ctx.lineTo(225,12);ctx.stroke();by('plot').onclick=e=>by('plotResult').textContent='图表坐标点击 '+e.isTrusted+' 次数 '+(++plotClicks);
  by('drag').ondragstart=e=>e.dataTransfer.setData('text/plain','fixture-drag');by('drop').ondragover=e=>e.preventDefault();by('drop').ondrop=e=>{e.preventDefault();by('dragResult').textContent='拖动完成：'+e.dataTransfer.getData('text/plain')};
  by('alertButton').onclick=()=>alert('普通网页提示');by('promptButton').onclick=()=>by('dialogResult').textContent='输入结果：'+prompt('请输入备注','');
  by('openTab').onclick=()=>window.open('/frame?child=1','_blank');
  by('export').onclick=()=>{const a=document.createElement('a');a.href='/download?export=1';a.click()};
  by('blobExport').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['项目,数量\\n测试,42'],{type:'text/csv'}));a.download='数据.csv';a.click()};
  by('upload').onclick=()=>by('hiddenFile').click();by('hiddenFile').onchange=e=>by('uploadResult').textContent='附件：'+e.target.files[0]?.name;
  setInterval(()=>by('clock').textContent='无关计时 '+Date.now(),100);
  </script>`;
}
