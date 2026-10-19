import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';import {simulate} from '../src/model.mjs';
const post=(url,data)=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timeout');};
async function fixture(t,fetchImpl,dataDir){const dir=dataDir||mkdtempSync(join(tmpdir(),'water-session-'));const f=createApp({dataDir:dir,labToken:'lab',uranoToken:'urano',fetchImpl});await new Promise(r=>f.server.listen(0,'127.0.0.1',r));t.after(async()=>{f.server.closeAllConnections();await new Promise(r=>f.server.close(r));if(!dataDir)rmSync(dir,{recursive:true,force:true});});return {...f,dir,url:`http://127.0.0.1:${f.server.address().port}`};}
async function submit(f,runId){const res=await post(f.url+'/api/jobs',{runId,transport:'wait'});assert.equal(res.status,202);const job=await res.json();await until(()=>!f.active.size);return f.store.get('job',job.id);}
test('sesión única conserva contexto entre capturas, permite apagar/resetear y persiste tras reinicio',async t=>{
 const calls=[];let count=0;
 const fetchImpl=async(url,options)=>{const b=JSON.parse(options.body);calls.push({url:String(url),body:b});count++;return Response.json({response:'ok'},{headers:{'x-urano-turn-id':`turn-${count}`,'x-urano-session-id':b.sessionId||`session-${count}`}});};
 const f=await fixture(t,fetchImpl),a=f.store.save('run',simulate()),b=f.store.save('run',simulate({scenario:'normal'}));
 await post(f.url+'/api/session-policy',{enabled:true});const first=await submit(f,a.id),next=await submit(f,b.id);
 assert.equal(next.payload.sessionId,first.sessionId);assert.equal(next.sessionId,first.sessionId);assert.notEqual(next.turnId,first.turnId);assert.notEqual(next.idempotencyKey,first.idempotencyKey);
 await post(f.url+'/api/session-policy',{enabled:false});const isolated=await submit(f,a.id);assert.equal(isolated.payload.sessionId,undefined);assert.notEqual(isolated.sessionId,first.sessionId);
 await post(f.url+'/api/session-policy',{enabled:true});const resumed=await submit(f,a.id);assert.equal(resumed.sessionId,first.sessionId);
 await post(f.url+'/api/session-reset',{});const fresh=await submit(f,a.id);assert.equal(fresh.payload.sessionId,undefined);assert.notEqual(fresh.sessionId,first.sessionId);
 const restarted=await fixture(t,fetchImpl,f.dir);const state=await(await fetch(restarted.url+'/api/state')).json();assert.equal(state.sessionPolicy.enabled,true);assert.equal(state.sessionPolicy.sessionId,fresh.sessionId);
 const after=await submit(restarted,b.id);assert.equal(after.sessionId,fresh.sessionId);
 await post(restarted.url+'/api/connection',{url:'http://localhost:7777/v1/webhook/mcp_water-lab/other'});const other=await submit(restarted,b.id);assert.equal(other.payload.sessionId,undefined);assert.notEqual(other.sessionId,fresh.sessionId);
});
test('activar sesión única adopta la última sesión terminada del webhook',async t=>{
 const f=await fixture(t,async()=>Response.json({response:'ok'},{headers:{'x-urano-turn-id':'t','x-urano-session-id':'existing'}}));const run=f.store.save('run',simulate());await submit(f,run.id);
 const res=await post(f.url+'/api/session-policy',{enabled:true});assert.equal((await res.json()).sessionId,'existing');
});
test('primera entrega pendiente bloquea otra consulta y reset hasta conocer la sesión',async t=>{
 let release;const f=await fixture(t,()=>new Promise(r=>{release=()=>r(Response.json({response:'ok'},{headers:{'x-urano-turn-id':'t','x-urano-session-id':'s'}}));}));const run=f.store.save('run',simulate());
 await post(f.url+'/api/session-policy',{enabled:true});await post(f.url+'/api/jobs',{runId:run.id,transport:'wait'});await until(()=>release);
 assert.equal((await post(f.url+'/api/jobs',{runId:run.id,transport:'wait'})).status,409);assert.equal((await post(f.url+'/api/session-reset',{})).status,409);
 release();await until(()=>!f.active.size);
});
test('reentregar turno conocido usa status, aunque haya expirado la clave; no invoca otro turno',async t=>{
 let invoked=0,controls=0;const f=await fixture(t,async(url,options)=>{const b=JSON.parse(options.body);if(b.webhookAction){controls++;assert.equal(b.webhookAction,'status');assert.equal(b.turnId,'original-turn');return Response.json({state:'succeeded',turnId:'original-turn',sessionId:'original-session',result:{response:'original'}});}invoked++;return Response.json({response:'original'},{headers:{'x-urano-turn-id':'original-turn','x-urano-session-id':'original-session'}});});
 const run=f.store.save('run',simulate()),job=await submit(f,run.id);job.createdAt=new Date(Date.now()-48*3600000).toISOString();f.store.save('job',job);
 const res=await post(f.url+`/api/jobs/${job.id}/retry`,{});assert.equal(res.status,202);await until(()=>controls===1&&!f.active.size);assert.equal(invoked,1);assert.equal(f.store.get('job',job.id).sessionId,'original-session');
});
test('reentrega sin turnId exige protocolo v1 y conserva cuerpo y clave originales',async t=>{
 const posts=[];let discoveryVersion=0;
 const f=await fixture(t,async(url,options)=>{if(!options.method)return Response.json({protocolVersion:discoveryVersion});posts.push(options);throw Error('Corte antes de recibir IDs');});const run=f.store.save('run',simulate()),job=await submit(f,run.id);
 assert.equal(job.state,'delivery_unknown');assert.equal((await post(f.url+`/api/jobs/${job.id}/retry`,{})).status,409);assert.equal(posts.length,1);
 discoveryVersion=1;assert.equal((await post(f.url+`/api/jobs/${job.id}/retry`,{})).status,202);await until(()=>posts.length===2&&!f.active.size);
 assert.equal(posts[0].body,posts[1].body);assert.equal(posts[0].headers['Idempotency-Key'],posts[1].headers['Idempotency-Key']);
});
