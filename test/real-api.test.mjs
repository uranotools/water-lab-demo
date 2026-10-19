import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createApp} from '../src/server.mjs';import {simulate} from '../src/model.mjs';
const post=(url,data,token)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(data)});
async function app(t,fetchImpl){const dir=mkdtempSync(join(tmpdir(),'water-real-')),f=createApp({dataDir:dir,labToken:'lab',uranoToken:'urano',sensorToken:'sensor',fetchImpl});await new Promise(r=>f.server.listen(0,'127.0.0.1',r));t.after(async()=>{f.server.closeAllConnections();await new Promise(r=>f.server.close(r));rmSync(dir,{recursive:true,force:true});});return {...f,url:`http://127.0.0.1:${f.server.address().port}`};}
test('receptor autentica, acumula y crea capturas inmutables consultables por el plugin',async t=>{
 const f=await app(t),batch={sensorId:'meter-01',unit:'L/min',samplingMinutes:5,readings:[{timestamp:'2026-01-01T00:00:00Z',flowLpm:0.4}]};
 assert.equal((await post(f.url+'/ingest/readings',batch)).status,401);assert.equal((await post(f.url+'/ingest/readings',batch,'lab')).status,401);
 assert.equal((await post(f.url+'/ingest/readings',batch,'sensor')).status,202);await post(f.url+'/ingest/readings',batch,'sensor');assert.equal(f.store.list('sensor')[0].samples.length,1);
 const sensor=f.store.list('sensor')[0],snap=await(await post(f.url+`/api/sensors/${sensor.id}/snapshot`,{})).json();
 assert.equal(snap.truth,null);const hash=snap.evidenceId;
 await post(f.url+'/ingest/readings',{...batch,readings:[{timestamp:'2026-01-01T00:05:00Z',flowLpm:0.6}]},'sensor');assert.equal(f.store.get('run',snap.id).evidenceId,hash);assert.equal(f.store.get('run',snap.id).observation.samples.length,1);
 const evidence=await(await fetch(f.url+`/agent/runs/${snap.id}`,{headers:{authorization:'Bearer lab'}})).json();assert.equal(evidence.source.kind,'sensor');assert.equal(evidence.samples[0].flowLpm,0.4);
 const imported=await post(f.url+'/api/import/csv',{csv:'timestamp,flowLpm\n2026-01-01T00:00:00Z,2',samplingMinutes:5,name:'real.csv'});assert.equal(imported.status,201);assert.equal((await imported.json()).source.kind,'csv');
 assert.equal((await post(f.url+'/api/import/csv',{csv:'bad'})).status,400);
});
test('wait y SSE producen el mismo informe validado contra evidencia; hash falso se rechaza',async t=>{
 let run,bad=false;
 const f=await app(t,async(url)=>{
  const report={schemaVersion:'water-lab.report.v1',runId:run.id,evidenceId:bad?'wrong':run.evidenceId,summary:'Resumen de prueba de transporte.',diagnosis:'insufficient_data',severity:'low',confidence:'low',findings:[],uncertainties:['Sin revisión física'],nextChecks:['Comprobar sensor'],recommendations:[]};
  const response=JSON.stringify(report);
  return String(url).includes('mode=sse')?new Response(`id: turn:1\nevent: done\ndata: ${JSON.stringify({type:'done',response})}\n\n`,{headers:{'content-type':'text/event-stream'}}):Response.json({response});
 });run=f.store.save('run',simulate());
 for(const transport of ['wait','sse','wait']){
  const job=await(await post(f.url+'/api/jobs',{runId:run.id,transport})).json();for(let i=0;i<100&&f.store.get('job',job.id).state!=='succeeded';i++)await new Promise(r=>setTimeout(r,10));
  const state=await(await fetch(f.url+'/api/state')).json(),saved=state.jobs.find(j=>j.id===job.id);
  assert.equal(saved.state,'succeeded');if(bad){assert.equal(saved.report,null);assert.match(saved.reportError,/hash/);}else assert.equal(saved.report.summary,'Resumen de prueba de transporte.');
  if(transport==='sse')bad=true;
 }
});
