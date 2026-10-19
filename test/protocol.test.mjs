import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readSSE, Urano } from '../src/urano.mjs';
test('SSE admite frames fragmentados, comentarios, CRLF y caracteres UTF8 partidos', async () => {
  const text = ': keepalive\r\n\r\nid: turn:1\r\nevent: done\r\ndata: {"response":"caudal pequeño"}\r\n\r\n';
  const bytes = Buffer.from(text), events = []; await readSSE(Readable.from([...bytes].map(b => Buffer.from([b]))), e => events.push(e));
  assert.equal(events.length,1); assert.equal(events[0].id,'turn:1'); assert.equal(events[0].response,'caudal pequeño');
});
test('reintento conserva payload, identidad y clave; replay usa cursor sin nueva invocación', async () => {
  const calls = [];
  const urano = new Urano({url:'http://127.0.0.1:6274/v1/webhook/mcp_water-lab/default', token:'secret', fetchImpl: async (url,options) => { calls.push({url:String(url),...options}); return new Response('{}',{headers:{'content-type':'application/json'}}); }});
  const job = { transport:'sse', payload:{ runId:'x',text:'a', sessionId:'session'}, idempotencyKey:'stable', turnId:'turn', lastEventId:'turn:7' };
  await urano.deliver(job,{}); await urano.deliver(job,{}); await urano.deliver(job,{action:'events'});
  assert.equal(calls[0].body,calls[1].body); assert.equal(calls[0].headers['Idempotency-Key'],'stable');
  assert.deepEqual(JSON.parse(calls[2].body),{webhookAction:'events',turnId:'turn'}); assert.equal(calls[2].headers['Last-Event-ID'],'turn:7');
  assert.equal(calls[2].headers['Idempotency-Key'],undefined);
});
test('acepta webhook configurable HTTP/HTTPS y rechaza credenciales y esquemas inválidos', () => {
  assert.equal(new Urano({url:'http://localhost:7777/v1/webhook/mcp_water-lab/mi-canal/'}).url,'http://localhost:7777/v1/webhook/mcp_water-lab/mi-canal');
  assert.equal(new Urano({url:'https://urano.example/v1/webhook/mcp_water-lab/custom'}).url,'https://urano.example/v1/webhook/mcp_water-lab/custom');
  for (const url of ['file:///etc/hosts','javascript:alert(1)','http://token@localhost/webhook','https://example.com/hook?secret=x','https://example.com/hook#token','not-a-url']) assert.throws(() => new Urano({url}));
});
