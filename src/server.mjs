import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { simulate, scenarios, evidence, intervention } from './model.mjs';
import { Store, validId } from './store.mjs';
import { Urano, terminal } from './urano.mjs';
import { applyExecutionEvent } from './stream.mjs';
import { parseCSV, observationRun, mergeSensor } from './sources.mjs';
import { parseReport } from '../public/report.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const equal = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };
async function body(req) {
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 262144) throw Object.assign(new Error('Payload demasiado grande'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
}
export function createApp({ dataDir = resolve(root, 'data'), labToken, uranoToken, sensorToken, uranoUrl = 'http://127.0.0.1:6274/v1/webhook/mcp_water-lab/default', fetchImpl } = {}) {
  if (!labToken || !uranoToken) throw new Error('Faltan secretos. Ejecuta npm run setup.');
  const store = new Store(dataDir), connectionPath = resolve(dataDir, 'connection.json'), peers = new Set(), active = new Map();
  const savedConnection = existsSync(connectionPath) ? JSON.parse(readFileSync(connectionPath, 'utf8')) : null;
  let urano = new Urano({ url: savedConnection?.url || uranoUrl, token: uranoToken, fetchImpl });
  const sessionsPath=resolve(dataDir,'sessions.json');
  const sessions=existsSync(sessionsPath)?JSON.parse(readFileSync(sessionsPath,'utf8')):{enabled:false,byWebhook:{}};
  const saveSessions=()=>{writeFileSync(`${sessionsPath}.tmp`,JSON.stringify(sessions,null,2));renameSync(`${sessionsPath}.tmp`,sessionsPath);};
  const sessionView=()=>({enabled:sessions.enabled,generation:sessions.byWebhook[urano.url]?.generation||null,sessionId:sessions.byWebhook[urano.url]?.sessionId||null,lastJobId:sessions.byWebhook[urano.url]?.lastJobId||null});
  function sharedEntry(){
    if(!sessions.byWebhook[urano.url]){
      const recent=store.list('job').find(j=>j.webhookUrl===urano.url&&j.sessionId&&terminal.has(j.state));
      sessions.byWebhook[urano.url]={generation:randomUUID(),sessionId:recent?.sessionId||null,lastJobId:recent?.id||null};saveSessions();
    }
    return sessions.byWebhook[urano.url];
  }
  const clientFor = job => new Urano({ url: job.webhookUrl || uranoUrl, token: uranoToken, fetchImpl });
  // A process crash never silently reissues a model invocation.
  for (const job of store.list('job')) {
    let changed = false;
    if (!job.webhookUrl) { job.webhookUrl = new Urano({ url: uranoUrl, token: uranoToken, fetchImpl }).url; changed = true; }
    if (!terminal.has(job.state)) { job.state = 'interrupted'; job.streamOpen = false; job.deliveryError = 'La demo se reinició. Consulta estado antes de reintentar.'; changed = true; }
    if (changed) store.save('job', job);
  }
  const pendingUpdates = new Map();
  const publicJob = job => {
    const { payload, ...rest } = job;
    if(job.state==='succeeded'){
      const run=store.get('run',job.runId);
      return {...rest,...parseReport(job.response,{runId:job.runId,evidenceId:run?.evidenceId,sampleCount:run?.observation.samples.length})};
    }
    return rest;
  };
  function publish(job) {
    clearTimeout(pendingUpdates.get(job.id)); pendingUpdates.delete(job.id);
    store.save('job', job);
    const shared=sessions.byWebhook[job.webhookUrl];
    if(job.sessionGeneration&&shared?.generation===job.sessionGeneration&&shared.lastJobId===job.id&&job.sessionId&&shared.sessionId!==job.sessionId){shared.sessionId=job.sessionId;saveSessions();}
    const frame = `event: job\ndata: ${JSON.stringify(publicJob(job))}\n\n`;
    for (const res of peers) if (res.writableLength > 256000 || !res.write(frame)) { peers.delete(res); res.end(); }
  }
  function publishSoon(job) {
    if (!pendingUpdates.has(job.id)) pendingUpdates.set(job.id, setTimeout(() => publish(job), 60));
  }
  async function execute(job, action) {
    if (active.has(job.id)) throw Object.assign(new Error('Entrega en curso'), { status: 409 });
    active.set(job.id, job);
    try {
      job.streamOpen = action === 'events' || (!action && job.transport === 'sse');
      if (job.streamOpen) job.activity = 'Conectando con el agente';
      if (!action) { if (!terminal.has(job.state)) job.state = 'running'; job.deliveryError = null; publish(job); }
      const result = await clientFor(job).deliver(job, { action,
        onHeaders: ids => {
          if(job.turnId&&ids.turnId&&job.turnId!==ids.turnId)throw Error('El webhook devolvió otro turnId para la ejecución original. No se reemplazan sus IDs.');
          if(job.payload?.sessionId&&ids.sessionId&&job.payload.sessionId!==ids.sessionId)throw Error('El webhook no respetó la sesión solicitada. No se cambia de sesión silenciosamente.');
          for (const [key, value] of Object.entries(ids)) if (value) job[key] = value; publish(job);
        },
        onEvent: event => {
          if (!applyExecutionEvent(job, event)) return;
          if (event.type === 'TokenStreamChunk' || event.type === 'ReasoningStreamChunk') publishSoon(job);
          else publish(job);
        }
      });
      if (result) {
        for(const key of ['turnId','sessionId','requestId'])if(result[key]&&!job[key])job[key]=result[key];
        if (result.state) {
          job.state = result.state; job.metrics = result.metrics;
          job.response = result.result?.response ?? job.response;
          job.deliveryError = result.deliveryError || null;
        } else if (!action && job.transport === 'wait' && !result.error) {
          job.state = 'succeeded'; job.response = result;
        }
        job.controlResult = result;
      }
      // Stream exhaustion/timeout doesn't prove that the execution ended.
      if (!terminal.has(job.state) && ((!action && job.transport !== 'async') || action === 'events')) job.deliveryError ||= 'Entrega cerrada. Consulta estado o retoma los eventos del mismo turno.';
    } catch (error) { job.deliveryError = error.message; if (!job.turnId) job.state = 'delivery_unknown'; }
    finally { job.streamOpen = false; active.delete(job.id); publish(job); }
  }
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
    try {
      // Local UI has no CORS. Check Host and Origin to prevent browser cross-site writes.
      const authority = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(authority)) return json(403, { error: 'Host no autorizado' });
      if (req.headers.origin && req.headers.origin !== `http://${authority}`) return json(403, { error: 'Origin no autorizado' });
      const url = new URL(req.url, `http://${authority}`), path = url.pathname;
      if(req.method==='POST'&&path==='/ingest/readings'){
        if(!sensorToken||!equal(req.headers.authorization,`Bearer ${sensorToken}`))return json(401,{error:'Configura SENSOR_INGEST_TOKEN y autentica el gateway del sensor'});
        const data=await body(req),previous=store.list('sensor').find(s=>s.sensorId===data.sensorId);
        const sensor=store.save('sensor',mergeSensor(previous,data));
        for(const peer of peers)if(peer.writableLength>256000||!peer.write(`event: sources\ndata: {}\n\n`)){peers.delete(peer);peer.end();}
        return json(202,{sensorId:sensor.sensorId,readingCount:sensor.samples.length,lastTimestamp:sensor.samples.at(-1).timestamp});
      }
      if (path.startsWith('/agent/')) {
        if (!equal(req.headers.authorization, `Bearer ${labToken}`)) return json(401, { error: 'Credenciales de laboratorio inválidas' });
        const match = path.match(/^\/agent\/runs\/([a-f0-9-]{36})(?:\/(compare|intervention))?$/);
        if (!match || !validId(match[1])) return json(404, { error: 'Recurso desconocido' });
        const run = store.get('run', match[1]); if (!run) return json(404, { error: 'Experimento inexistente' });
        if (req.method === 'GET' && !match[2]) return json(200, evidence(run));
        if (req.method === 'GET' && match[2] === 'compare') {
          // Blind outputs: no truth labels, confusion matrices, scenario name or hidden losses.
          return json(200, { runId: run.id, evidenceId: run.evidenceId, detectors: run.evaluation.map(({ strategy, diagnosis, firstLeakIndex, flags }) => ({ strategy, diagnosis, firstLeakIndex, flags })) });
        }
        if (req.method === 'POST' && match[2] === 'intervention') return json(200, intervention(run, await body(req)));
        return json(405, { error: 'Método no permitido' });
      }
      if (req.method === 'GET' && path === '/health') return json(200, { ok: true, service: 'water-lab', version: '0.1.0' });
      if (req.method === 'GET' && path === '/api/state') return json(200, { scenarios, runs: store.list('run').slice(0, 100), jobs: store.list('job').slice(0, 100).map(publicJob), sensors:store.list('sensor').map(({samples,...s})=>({...s,readingCount:samples.length,lastTimestamp:samples.at(-1)?.timestamp})), sensorIngestConfigured:!!sensorToken, connection: { url: urano.url, configured: true },sessionPolicy:sessionView() });
      if(req.method==='POST'&&path==='/api/session-policy'){
        const data=await body(req);
        if(typeof data.enabled!=='boolean')return json(400,{error:'enabled debe ser booleano'});
        sessions.enabled=data.enabled;if(data.enabled)sharedEntry();saveSessions();return json(200,sessionView());
      }
      if(req.method==='POST'&&path==='/api/session-reset'){
        if(store.list('job').some(j=>j.webhookUrl===urano.url&&!terminal.has(j.state)))return json(409,{error:'Termina o reconcilia las investigaciones pendientes antes de empezar otra sesión.'});
        sessions.byWebhook[urano.url]={generation:randomUUID(),sessionId:null,lastJobId:null};saveSessions();return json(200,sessionView());
      }
      if(req.method==='POST'&&path==='/api/import/csv'){
        const data=await body(req);return json(201,store.save('run',observationRun({readings:parseCSV(data.csv),samplingMinutes:data.samplingMinutes,name:data.name||'Archivo CSV',kind:'csv'})));
      }
      const snapshot=path.match(/^\/api\/sensors\/([a-f0-9-]{36})\/snapshot$/);
      if(req.method==='POST'&&snapshot){
        const sensor=store.get('sensor',snapshot[1]);if(!sensor)return json(404,{error:'Sensor inexistente'});
        return json(201,store.save('run',observationRun({readings:sensor.samples,samplingMinutes:sensor.samplingMinutes,name:sensor.sensorId,kind:'sensor',sensorId:sensor.sensorId})));
      }
      if (req.method === 'POST' && path === '/api/connection') {
        const data = await body(req);
        const next = new Urano({ url: data.url, token: uranoToken, fetchImpl });
        writeFileSync(`${connectionPath}.tmp`, JSON.stringify({ url: next.url }, null, 2));
        renameSync(`${connectionPath}.tmp`, connectionPath);
        urano = next;
        return json(200, { url: urano.url, configured: true });
      }
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.write(': water-lab\n\n'); peers.add(res);
        const timer = setInterval(() => res.write(': keepalive\n\n'), 15000);
        res.on('close', () => { clearInterval(timer); peers.delete(res); }); return;
      }
      if (req.method === 'GET' && path === '/api/discovery') {
        try { return json(200, await urano.discover()); } catch (error) { return json(502, { error: error.message }); }
      }
      if (req.method === 'POST' && path === '/api/runs') { const run = store.save('run', simulate(await body(req))); return json(201, run); }
      if (req.method === 'POST' && path === '/api/jobs') {
        const data = await body(req), run = validId(data.runId) && store.get('run', data.runId);
        if (!run) return json(404, { error: 'Experimento inexistente' });
        if (!['wait', 'sse', 'async'].includes(data.transport)) return json(400, { error: 'Transporte inválido' });
        if (store.list('job').filter(j => !terminal.has(j.state)).length >= 8) return json(429, { error: 'Consulta o cancela investigaciones pendientes (máximo 8).' });
        const payload = { runId: run.id, text: typeof data.question === 'string' ? data.question.slice(0, 2000) : 'Investiga anomalías, distingue fuga de falla del sensor y riego. Consulta evidencia y compara detectores. Devuelve diagnóstico y acciones justificadas.' };
        let shared;
        if(sessions.enabled){
          if(data.previousJobId)return json(409,{error:'Desactiva Sesión única para elegir manualmente otra conversación.'});
          if(store.list('job').some(j=>j.webhookUrl===urano.url&&!terminal.has(j.state)))return json(409,{error:'Hay una investigación pendiente en este webhook. Consulta su estado antes de enviar otro turno a la sesión única.'});
          shared=sharedEntry();
          if(shared.lastJobId&&!shared.sessionId)return json(409,{error:'La sesión de la consulta anterior todavía es desconocida. Recupera ese turno antes de crear otro.'});
          if(shared.sessionId)payload.sessionId=shared.sessionId;
        }
        if (data.previousJobId) {
          const previous = validId(data.previousJobId) && store.get('job', data.previousJobId);
          if (!previous || previous.runId !== run.id || !previous.sessionId || !terminal.has(previous.state)) return json(409, { error: 'La continuidad requiere un turno terminado del mismo experimento con sessionId.' });
          if (previous.webhookUrl !== urano.url) return json(409, { error: 'La sesión pertenece a otro webhook. Selecciona Nueva investigación para la URL actual.' });
          payload.sessionId = previous.sessionId;
        }
        const job = { id: randomUUID(), createdAt: new Date().toISOString(), runId: run.id, webhookUrl: urano.url, transport: data.transport, payload, idempotencyKey: randomUUID(), state: 'queued', events: [] };
        if(shared){job.sessionGeneration=shared.generation;shared.lastJobId=job.id;saveSessions();}
        store.save('job', job); json(202, publicJob(job)); void execute(job); return;
      }
      const control = path.match(/^\/api\/jobs\/([a-f0-9-]{36})\/(status|events|cancel|retry)$/);
      if (req.method === 'POST' && control) {
        const job = active.get(control[1]) || store.get('job', control[1]); if (!job) return json(404, { error: 'Investigación inexistente' });
        const action = control[2];
        if (active.has(job.id) && action === 'status' && job.turnId) {
          const result = await clientFor(job).deliver(job, { action: 'status' });
          if (result?.state) { job.state = result.state; job.response = result.result?.response ?? job.response; job.metrics = result.metrics; publish(job); }
          return json(200, result);
        }
        if (active.has(job.id)) return json(409, { error: 'Entrega en curso. Espera a que cierre para retomar o reentregar; puedes consultar Estado o cancelar.' });
        if (action === 'retry' && !job.turnId && Date.now() - Date.parse(job.createdAt) >= 23 * 3600000) return json(409, { error: 'Reintento bloqueado cerca del vencimiento de idempotencia. Reconcilia el turno.' });
        if(action==='retry'&&!job.turnId){const discovery=await clientFor(job).discover();if(discovery.protocolVersion!==1)return json(409,{error:'El webhook no anuncia protocolo v1; no se reentrega una invocación incierta sin protección idempotente.'});}
        if (action !== 'retry' && !job.turnId) return json(409, { error: 'Sin turnId. Reintenta la entrega idéntica con su misma clave.' });
        json(202, publicJob(job)); void execute(job, action === 'retry' ? (job.turnId?'status':undefined) : action); return;
      }
      const cancel = path.match(/^\/api\/jobs\/([a-f0-9-]{36})\/cancel-active$/);
      if (req.method === 'POST' && cancel) {
        const job = store.get('job', cancel[1]); if (!job?.turnId) return json(409, { error: 'Todavía no hay turnId' });
        const result = await clientFor(job).deliver(job, { action: 'cancel' }); return json(202, result);
      }
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/connection.css': ['connection.css', 'text/css; charset=utf-8'], '/stream.css': ['stream.css', 'text/css; charset=utf-8'] };
      Object.assign(files,{'/report.js':['report.js','text/javascript; charset=utf-8'],'/reports-ui.js':['reports-ui.js','text/javascript; charset=utf-8'],'/sources.css':['sources.css','text/css; charset=utf-8']});
      if (req.method === 'GET' && files[path]) {
        const [name, type] = files[path]; res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" }); return res.end(readFileSync(resolve(root, 'public', name)));
      }
      json(404, { error: 'Ruta desconocida' });
    } catch (error) { json(error.status || 400, { error: error.message }); }
  });
  server.on('close', () => { for (const peer of peers) peer.end(); });
  return { server, store, active };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
  const port = Number(process.env.PORT || 3020);
  const { server } = createApp({ labToken: process.env.LAB_API_TOKEN, uranoToken: process.env.URANO_TOKEN, sensorToken:process.env.SENSOR_INGEST_TOKEN, uranoUrl: process.env.URANO_URL });
  server.listen(port, '127.0.0.1', () => console.log(`Water Lab · http://127.0.0.1:${port}`));
}
