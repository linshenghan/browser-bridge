import http from "node:http";
import { advancedFixture } from "./advanced-fixture.mjs";
export async function fixture() {
  let submits = 0;
  let flakyRequests = 0;
  const requests = [];
  let active = 0,
    maxActive = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    const u = new URL(req.url, "http://fixture");
    requests.push(u.pathname + u.search);
    if (u.pathname === "/advanced") { res.end(advancedFixture(`http://127.0.0.1:${server.address().port}`)); return; }
    if (u.pathname === "/paused-paint") { res.end('<!doctype html><meta charset="utf-8"><title>绘制暂停验收</title><button id="once">执行一次</button><p id="result">0</p><canvas width="180" height="80" aria-label="暂停绘制图表" style="background:rgb(36,92,164)"></canvas><script>window.requestAnimationFrame=()=>0;document.getElementById("once").onclick=()=>document.getElementById("result").textContent=String(Number(document.getElementById("result").textContent)+1)</script>'); return; }
    if (u.pathname === "/scroll-page") { res.end(`<!doctype html><meta charset="utf-8"><title>主滚动区截图验收</title>
      <style>html,body{margin:0;overflow:hidden}#panel{position:absolute;left:20px;right:20px;top:70px;height:400px;overflow:auto;background:rgb(36,92,164)}input{position:absolute;top:2200px;left:40px}</style>
      <h1>主滚动区截图验收</h1><div id="panel" role="region" aria-label="主面板"><div style="height:8700px;position:relative"><input type="password" value="masked-secret" aria-label="密码"><canvas width="150" height="80" aria-label="底部图表" style="position:absolute;top:8500px;background:rgb(24,107,112)"></canvas></div></div>`); return; }
    if (u.pathname === "/flaky" && ++flakyRequests <= 3) {
      res.writeHead(503);
      res.end("<title>Temporary failure</title>Retry fixture");
      return;
    }
    if (u.pathname === "/download") {
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="fixture.txt"',
      });
      res.end("Team Browser Bridge download fixture");
      return;
    }
    if (u.pathname === "/redirect") {
      res.writeHead(302, { location: "/page?redirected=yes" });
      res.end();
      return;
    }
    if (u.pathname === "/slow") {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) =>
        setTimeout(r, Number(u.searchParams.get("ms")) || 4000),
      );
      active--;
    }
    if (u.pathname === "/missing") {
      res.writeHead(404);
      res.end("<title>Not Found</title><h1>404 missing fixture</h1>");
      return;
    }
    if (u.pathname === "/deny") {
      res.end(
        '<html data-team-browser-policy="deny"><title>Restricted fixture</title><body>Automated access denied by this test page</body></html>',
      );
      return;
    }
    if (u.pathname === "/submit") {
      submits++;
      res.end(`<title>提交成功</title><h1>提交成功 ${submits}</h1>`);
      return;
    }
    if (u.pathname === "/frame") {
      res.end(
        '<title>嵌入区域</title><h2>已授权的嵌入内容</h2><input aria-label="嵌入输入"><button type="button">嵌入按钮</button>',
      );
      return;
    }
    if (u.pathname === "/large") {
      res.end(
        "<title>大正文</title><article>" +
          "大型页面正文。".repeat(80000) +
          "</article>",
      );
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>Chrome 操作助手验收页</title><style>body{font:16px system-ui;max-width:900px;margin:40px auto;color:#17323a;background:#f5f9f8}section{background:white;padding:20px;margin:14px 0;border-radius:12px}label{display:block;margin:10px}input,select,button{padding:8px;margin:4px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:8px}iframe{height:140px;width:95%}</style></head><body><h1>Chrome 操作助手 · 自有验收页面</h1><p>页面编号 ${u.searchParams.get("n") || "首页"}。仅供内部开发验证。</p><section><h2>搜索与动态内容</h2><input id="search" aria-label="搜索关键词"><button id="searchButton" type="button">搜索</button><p id="result">等待搜索</p><button id="dynamic" type="button">动态更新</button><button id="delayed" type="button">延迟更新</button><button id="property" type="button">属性更新</button></section><section><h2>商品表格</h2><table><thead><tr><th>商品</th><th>价格</th></tr></thead><tbody><tr><td>测试产品</td><td>128</td></tr><tr><td>示例产品</td><td>256</td></tr></tbody></table></section><section><form action="/submit" method="get"><label>姓名<input name="name" aria-label="姓名"></label><label>城市<select name="city" aria-label="城市"><option value="sh">上海</option><option value="bj">北京</option></select></label><label>文件<input type="file" id="file" aria-label="上传测试文件"></label><p id="fileStatus">尚未选择文件</p><label>密码<input type="password" autocomplete="current-password" aria-label="密码" value="do-not-export-password"></label><button type="submit">保存表单</button></form></section><section><a href="/page?n=next">下一页</a> <a href="/download">下载测试文件</a></section>${u.searchParams.has("frames") ? '<iframe src="/frame" title="同站嵌入页面"></iframe>' : ""}${u.searchParams.has("foreign") ? '<iframe src="http://localhost:' + server.address().port + '/frame" title="未授权区域"></iframe>' : ""}<script>searchButton.onclick=()=>result.textContent='搜索结果：'+document.querySelector('#search').value;dynamic.onclick=()=>result.textContent='动态内容 '+Date.now();delayed.onclick=()=>setTimeout(()=>result.textContent='延迟内容 '+Date.now(),800);property.onclick=()=>setTimeout(()=>document.querySelector('#search').value='脚本修改输入值',800);document.querySelector('#file').onchange=e=>fileStatus.textContent='已选择：'+e.target.files[0]?.name;</script></body></html>`,
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    server,
    requests,
    get submits() {
      return submits;
    },
    get maxActive() {
      return maxActive;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
