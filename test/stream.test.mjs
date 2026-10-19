import test from 'node:test';
import assert from 'node:assert/strict';
import { applyExecutionEvent } from '../src/stream.mjs';
const event = (sequence, chunk, type='TokenStreamChunk') => ({id:`turn:${sequence}`,sequence,turnId:'turn',type,chunk});
test('texto se acumula incrementalmente y done reemplaza el borrador con el resultado final',()=>{
  const job={events:[],state:'running'};
  applyExecutionEvent(job,event(1,'Hay ')); assert.equal(job.liveText,'Hay '); assert.equal(job.response,undefined);
  applyExecutionEvent(job,event(2,'una anomalía.')); assert.equal(job.liveText,'Hay una anomalía.');
  applyExecutionEvent(job,{...event(3,undefined,'done'),response:'Diagnóstico final revisado.'});
  assert.equal(job.state,'succeeded'); assert.equal(job.response,'Diagnóstico final revisado.');
});
test('replay no duplica texto ni retrocede cursor aunque el evento ya salió del registro visible',()=>{
  const job={events:[]}; for(let i=1;i<=250;i++)applyExecutionEvent(job,event(i,'a'));
  assert.equal(job.events.length,200); assert.equal(applyExecutionEvent(job,event(1,'duplicado')),false);
  assert.equal(job.liveText.length,250); assert.equal(job.lastEventId,'turn:250');
  applyExecutionEvent(job,event(251,'b')); assert.equal(job.liveText.length,251);
});
test('actividad no expone razonamiento ni mezcla resultados de herramientas con la respuesta',()=>{
  const job={events:[]};applyExecutionEvent(job,event(1,'borrador'));
  applyExecutionEvent(job,event(2,'razonamiento privado','ReasoningStreamChunk'));
  assert.equal(job.liveText,'borrador');assert.ok(!JSON.stringify(job).includes('privado'));
  applyExecutionEvent(job,event(3,'datos internos','ToolCallStarted'));assert.match(job.activity,/herramientas/);
  applyExecutionEvent(job,event(4,'datos internos','ToolCallCompleted'));assert.equal(job.liveText,'borrador');
  applyExecutionEvent(job,event(5,undefined,'error'));assert.equal(job.liveText,'borrador');assert.ok(job.deliveryError);assert.notEqual(job.state,'succeeded');
});
test('texto vivo queda acotado',()=>{
  const job={events:[]}; applyExecutionEvent(job,event(1,'a'.repeat(65000)));assert.equal(job.liveText.length,64000);assert.equal(job.liveTruncated,true);
});
