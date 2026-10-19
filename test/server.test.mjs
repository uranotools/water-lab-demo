import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { simulate } from '../src/model.mjs';
import { readSSE } from '../src/urano.mjs';
async function fixture(t, fetchImpl = async () => new Response('{}',{headers:{'content-type':'application/json'}})) {
  const dir = mkdtempSync(join(tmpdir(),'water-lab-'));
  const app = createApp({dataDir:dir,labToken:'lab-secret',uranoToken:'urano-secret',fetchImpl});
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); rmSync(dir,{recursive:true,force:true}); });
  return {...app,url,dir};
}
const post = (url,data,headers={}) => fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)});
const until = async check => { for(let i=0;i<100;i++){ const value=check(); if(value)return value; await new Promise(r=>setTimeout(r,10)); } throw new Error('Timeout esperando fixture'); };
test('API local persiste runs, oculta secretos y protege evidencia y origen',async t => {
  const f = await fixture(t);
  const res = await post(f.url+'/api/runs',{scenario:'irrigation',seed:42,leakLpm:0.8}); assert.equal(res.status,201); const run=await res.json();
  const state=await (await fetch(f.url+'/api/state')).text(); assert.ok(!state.includes('lab-secret')); assert.ok(!state.includes('urano-secret'));
  assert.equal((await fetch(f.url+`/agent/runs/${run.id}`)).status,401);
  const e=await (await fetch(f.url+`/agent/runs/${run.id}`,{headers:{Authorization:'Bearer lab-secret'}})).json(); assert.equal(e.truth,undefined); assert.equal(e.scenario,undefined);
  assert.equal((await post(f.url+'/api/runs',{}, {origin:'https://evil.example'})).status,403);
  assert.equal(f.store.list('run').length,1);
});
test('bridge entrega SSE, persiste IDs, reintenta idéntico y consulta el mismo turno',async t => {
  const calls=[];
  const f=await fixture(t,async (url,opts)=>{
    calls.push({url:String(url),...opts}); const b=JSON.parse(opts.body);
    if(b.webhookAction==='status') return Response.json({state:'succeeded',turnId:'turn-1',result:{response:'Respuesta guardada'}});
    return new Response('id: turn-1:1\nevent: turn\ndata: {"turnId":"turn-1","sessionId":"session-1"}\n\nid: turn-1:2\nevent: done\ndata: {"response":"Consumo analizado"}\n\n',{headers:{'content-type':'text/event-stream','x-urano-turn-id':'turn-1'}});
  });
  const run=f.store.save('run',simulate());
  const response=await post(f.url+'/api/jobs',{runId:run.id,transport:'sse'}); const job=await response.json();
  await until(()=>f.store.get('job',job.id).state==='succeeded'&&!f.active.size);
  const saved=f.store.get('job',job.id); assert.equal(saved.turnId,'turn-1'); assert.equal(saved.lastEventId,'turn-1:2'); assert.equal(saved.sessionId,'session-1');
  await post(f.url+`/api/jobs/${job.id}/retry`,{}); await until(()=>calls.length===2&&!f.active.size);
  assert.equal(f.store.get('job',job.id).state,'succeeded');
  assert.deepEqual(JSON.parse(calls[1].body),{webhookAction:'status',turnId:'turn-1'});assert.equal(calls[1].headers['Idempotency-Key'],undefined);
  await post(f.url+`/api/jobs/${job.id}/status`,{}); await until(()=>calls.length===3&&!f.active.size);
  assert.equal(JSON.parse(calls[2].body).turnId,'turn-1'); assert.equal(f.store.get('job',job.id).response,'Respuesta guardada');
  await post(f.url+`/api/jobs/${job.id}/events`,{}); await until(()=>calls.length===4&&!f.active.size);
  assert.equal(calls[3].headers['Last-Event-ID'],'turn-1:2'); assert.equal(f.store.get('job',job.id).events.length,2);
});
test('timeout de entrega conserva turnId y no declara ejecución fallida',async t=>{
  const f=await fixture(t,async()=>new Response('{"error":"agent_timeout"}',{status:504,headers:{'x-urano-turn-id':'still-running'}}));
  const run=f.store.save('run',simulate()); const j=await (await post(f.url+'/api/jobs',{runId:run.id,transport:'wait'})).json();
  await until(()=>!f.active.size&&f.store.get('job',j.id).deliveryError);
  const saved=f.store.get('job',j.id); assert.equal(saved.turnId,'still-running'); assert.equal(saved.state,'running');
});
test('reinicio marca trabajos pendientes como interrumpidos sin invocar al modelo',async t=>{
  const f=await fixture(t); const id='12345678-1234-1234-1234-123456789012';
  f.store.save('job',{id,createdAt:new Date().toISOString(),state:'running',events:[]});
  let called=false; const second=createApp({dataDir:f.dir,labToken:'x',uranoToken:'x',fetchImpl:async()=>{called=true;}});
  assert.equal(second.store.get('job',id).state,'interrupted'); assert.equal(called,false);
});
test('async conserva IDs y consulta resultado; continuidad crea turno con sesión explícita',async t=>{
  const calls=[];
  const f=await fixture(t,async(url,opts)=>{
    const b=JSON.parse(opts.body); calls.push(b);
    if(b.webhookAction==='status') return Response.json({state:'succeeded',result:{response:'Listo'}});
    return new Response('OK',{headers:{'x-urano-turn-id':'async-turn','x-urano-session-id':'session-a'}});
  });
  const run=f.store.save('run',simulate());
  const first=await(await post(f.url+'/api/jobs',{runId:run.id,transport:'async'})).json();
  await until(()=>!f.active.size&&f.store.get('job',first.id).turnId);
  assert.equal(f.store.get('job',first.id).deliveryError,null);
  await post(f.url+`/api/jobs/${first.id}/status`,{}); await until(()=>!f.active.size&&f.store.get('job',first.id).state==='succeeded');
  const next=await post(f.url+'/api/jobs',{runId:run.id,transport:'async',question:'Otra prueba',previousJobId:first.id}); assert.equal(next.status,202);
  await until(()=>calls.length===3&&!f.active.size); assert.equal(calls[2].sessionId,'session-a');
});
test('cancelación durante SSE abierto usa control independiente y estado terminal del stream',async t=>{
  let closeStream;
  const f=await fixture(t,async(url,opts)=>{
    const b=JSON.parse(opts.body);
    if(b.webhookAction==='cancel') { closeStream(); return Response.json({state:'cancelled',turnId:'t-cancel'}); }
    return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('id: t-cancel:1\nevent: turn\ndata: {"turnId":"t-cancel"}\n\n'));
      closeStream=()=>{controller.enqueue(new TextEncoder().encode('id: t-cancel:2\nevent: error\ndata: {"error":"execution_cancelled"}\n\n'));controller.close();};
    }}),{headers:{'content-type':'text/event-stream','x-urano-turn-id':'t-cancel'}});
  });
  const run=f.store.save('run',simulate()), job=await(await post(f.url+'/api/jobs',{runId:run.id,transport:'sse'})).json();
  await until(()=>f.store.get('job',job.id).turnId);
  const cancellation=await post(f.url+`/api/jobs/${job.id}/cancel-active`,{}); assert.equal(cancellation.status,202);
  assert.equal((await cancellation.json()).state,'cancelled'); await until(()=>!f.active.size);
  assert.ok(f.store.get('job',job.id).deliveryError); // error delivery is not a fabricated terminal state
});
test('SSE publica texto al navegador antes de done y conserva el resultado final sin duplicaciones',async t=>{
  let push, finish;
  const f=await fixture(t,async()=>new Response(new ReadableStream({start(controller){
    push=event=>controller.enqueue(new TextEncoder().encode(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
    finish=()=>controller.close();
  }}),{headers:{'content-type':'text/event-stream','x-urano-turn-id':'live-turn'}}));
  const abort=new AbortController(), seen=[];
  const live=await fetch(f.url+'/api/events',{signal:abort.signal});
  const reading=readSSE(live.body,e=>seen.push(e)).catch(e=>{if(!abort.signal.aborted)throw e;});
  t.after(async()=>{abort.abort();await reading;});
  const run=f.store.save('run',simulate()),j=await(await post(f.url+'/api/jobs',{runId:run.id,transport:'sse'})).json();
  await until(()=>push);
  const first={id:'live-turn:1',turnId:'live-turn',type:'TokenStreamChunk',chunk:'El caudal '};
  push(first);
  await until(()=>seen.some(e=>e.liveText==='El caudal '));
  assert.equal(f.store.get('job',j.id).response,undefined); assert.equal(f.store.get('job',j.id).state,'running');
  push(first); push({id:'live-turn:2',turnId:'live-turn',type:'TokenStreamChunk',chunk:'subió.'});
  await until(()=>seen.some(e=>e.liveText==='El caudal subió.'));
  push({id:'live-turn:3',turnId:'live-turn',type:'done',response:'Respuesta final con evidencia.'});finish();
  await until(()=>!f.active.size&&f.store.get('job',j.id).state==='succeeded');
  assert.equal(f.store.get('job',j.id).response,'Respuesta final con evidencia.');assert.equal(f.store.get('job',j.id).streamOpen,false);
});
