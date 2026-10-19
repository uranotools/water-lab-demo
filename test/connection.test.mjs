import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { simulate } from '../src/model.mjs';
const original = 'http://127.0.0.1:6274/v1/webhook/mcp_water-lab/default';
const custom = 'http://localhost:7777/v1/webhook/mcp_water-lab/devtools';
const post = (url, data, headers={}) => fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)});
const until = async check => {for(let i=0;i<100;i++){if(check())return; await new Promise(r=>setTimeout(r,10));}throw new Error('Timeout');};
async function start(t, dataDir, fetchImpl) {
  const app=createApp({dataDir,labToken:'lab-secret',uranoToken:'urano-secret',fetchImpl});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
  return {...app,url:`http://127.0.0.1:${app.server.address().port}`};
}
test('URL guardada persiste entre reinicios, discovery la usa y no persiste secretos',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'water-connection-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const calls=[], fetchImpl=async(url)=>{calls.push(String(url));return Response.json({protocolVersion:1});};
  const app=await start(t,dir,fetchImpl);
  assert.equal((await post(app.url+'/api/connection',{url:custom})).status,200);
  const persisted=JSON.parse(readFileSync(join(dir,'connection.json'),'utf8')); assert.deepEqual(persisted,{url:custom});
  await fetch(app.url+'/api/discovery'); assert.equal(calls[0],custom);
  const second=await start(t,dir,fetchImpl);
  const state=await(await fetch(second.url+'/api/state')).json();assert.equal(state.connection.url,custom);
  assert.ok(!JSON.stringify(state).includes('urano-secret'));
  assert.equal((await post(app.url+'/api/connection',{url:original},{origin:'https://evil.example'})).status,403);
  assert.equal((await post(app.url+'/api/connection',{url:'file:///secret'})).status,400);
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'connection.json'),'utf8')),{url:custom});
});
test('trabajos y sesiones permanecen ligados al destino original al cambiar URL',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'water-job-target-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const calls=[], app=await start(t,dir,async(url,opts)=>{calls.push({url:String(url),payload:JSON.parse(opts.body)});return Response.json({response:'ok'},{headers:{'x-urano-turn-id':'t','x-urano-session-id':'s'}});});
  const run=app.store.save('run',simulate());
  const first=await(await post(app.url+'/api/jobs',{runId:run.id,transport:'wait'})).json();
  await until(()=>!app.active.size&&app.store.get('job',first.id).state==='succeeded');
  await post(app.url+'/api/connection',{url:custom});
  await post(app.url+`/api/jobs/${first.id}/retry`,{});await until(()=>calls.length===2&&!app.active.size);
  assert.ok(calls[1].url.startsWith(original));
  await post(app.url+`/api/jobs/${first.id}/status`,{});await until(()=>calls.length===3&&!app.active.size);
  assert.equal(calls[2].url,original);
  assert.equal((await post(app.url+'/api/jobs',{runId:run.id,transport:'wait',previousJobId:first.id})).status,409);
  await post(app.url+'/api/jobs',{runId:run.id,transport:'wait'});await until(()=>calls.length===4&&!app.active.size);
  assert.ok(calls[3].url.startsWith(custom));
  assert.equal(calls[0].payload.sessionId,undefined);
});
