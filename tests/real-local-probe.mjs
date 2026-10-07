// Uses the installed MCP service and the user's Chrome extension only.
import { MCPClient } from './mcp-client.mjs';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const [binary,profileId,output,phase] = process.argv.slice(2);
if(!binary||!profileId||!output||!phase) throw new Error('binary profileId output phase required');
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><title>本机连接验收</title><h1>本机连接验收</h1><p>Native Messaging 本地读取与图片传输</p><canvas width="480" height="180" style="background:#145f68" aria-label="本地图表"></canvas>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const a=new MCPClient(binary,process.env),report={phase,startedAt:new Date().toISOString(),passed:false,realUserChrome:true,transport:'installed MCP + Native Messaging'},out=join(output,'代理连接验收');
let session;
try {
  await mkdir(out,{recursive:true});await a.init();let status;
  const end=Date.now()+20000;
  do {status=await a.tool('connection_status');if(status.profiles.some(p=>p.profileId===profileId))break;await new Promise(r=>setTimeout(r,400));}while(Date.now()<end);
  const profile=status.profiles.find(p=>p.profileId===profileId);assert.ok(profile,'Chrome 配置文件未连接');assert.equal(profile.upgradeRequired,false);
  report.capabilities=profile.details.capabilities;report.version=status.version;
  session=await a.tool('session_start',{name:'本地连接验收 '+phase,profileId,outputDir:out});
  const tab=await a.tool('tab_open',{sessionId:session.sessionId,url:`http://127.0.0.1:${server.address().port}/`,operationId:randomUUID()});
  const base={sessionId:session.sessionId,tabId:tab.tabId},observed=await a.tool('page_observe',base);assert.match(observed.body,/本机连接验收/);
  const screenshot=await a.request('tools/call',{name:'page_screenshot',arguments:base});assert.ok(!screenshot.isError);assert.ok(screenshot.content.some(c=>c.type==='image'));
  report.screenshot=screenshot.structuredContent.path;report.imageBytes=screenshot.content.filter(c=>c.type==='image').reduce((n,c)=>n+Buffer.from(c.data,'base64').length,0);
  report.passed=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally {if(session)await a.tool('session_end',{sessionId:session.sessionId}).catch(()=>{});await a.close();server.closeAllConnections();await new Promise(r=>server.close(r));report.finishedAt=new Date().toISOString();await writeFile(join(out,phase+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
