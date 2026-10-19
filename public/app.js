import {renderReportHTML} from './reports-ui.js';
const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const number = n => n === null || n === undefined ? '—' : new Intl.NumberFormat('es-GT', { maximumFractionDigits: 1 }).format(n);
const labels = { normal: 'Sin señal de fuga', possible_leak: 'Posible fuga', sensor_stuck: 'Sensor congelado', sensor_missing: 'Datos ausentes',insufficient_data:'Referencia insuficiente' };
let state, selected, selectedJob, busy = false;
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value;
}
let noticeTimer;
function notify(text) { $('notice').textContent = text; $('notice').classList.add('show'); clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('notice').classList.remove('show'), 7000); }
function run() { return state.runs.find(r => r.id === selected); }
function title(r) { return r.source?.name || state.scenarios.find(s => s.id === r.scenario)?.name || 'Observaciones'; }
function selectRun(id) {
  selected = id; selectedJob = state.jobs.find(j => j.runId === id)?.id;
  localStorage.setItem('water-run', id);
  const r = run(); if(r.seed!==undefined)$('seed').value = r.seed; if(r.leakLpm!==undefined)$('leak').value = r.leakLpm;
  document.querySelectorAll('input[name=scenario]').forEach(input => { input.checked = input.value === (r.scenario||'normal'); });
  $('truth').checked = false; renderRun(); renderJob(); renderHistory();
}
function graph(r) {
  const samples = r.observation.samples, width = 760, height = 390, left = 46, right = 12, top = 18, bottom = 36;
  const last=Math.max(1,samples.length-1),n=r.observation.calibrationSamples,minutes=r.observation.samplingMinutes;
  const reveal = $('truth').checked;
  const max = Math.max(5, ...samples.map(s => s.flowLpm || 0), ...(reveal&&r.truth ? r.truth.map(t => t.lossLiters / minutes) : [])) * 1.15;
  const x = i => left + i / last * (width - left - right), y = value => height - bottom - value / max * (height - top - bottom);
  const line = values => { let lift = true; return values.map((value, i) => { if (value === null) { lift = true; return ''; } const op = lift ? 'M' : 'L'; lift = false; return `${op}${x(i).toFixed(2)},${y(value).toFixed(2)}`; }).join(' '); };
  const expected = samples.map(s => samples[s.index % n]?.flowLpm??null);
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title"><title id="chart-title">Caudal L/min; tiempo transcurrido en horas. Medición y referencia disponible.</title><defs><clipPath id="plot"><rect x="${left}" y="${top}" width="${width-left-right}" height="${height-top-bottom}"/></clipPath></defs>${n<last?`<rect x="${x(n)}" y="${top}" width="${x(last)-x(n)}" height="${height-top-bottom}" fill="#edf2e8"/>`:''}<text x="${left}" y="9">L/min</text>`;
  for (let j = 0; j <= 4; j++) { const value = max * j / 4; svg += `<line x1="${left}" y1="${y(value)}" x2="${width-right}" y2="${y(value)}" stroke="#dce3d7"/><text x="${left-8}" y="${y(value)+3}" text-anchor="end">${number(value)}</text>`; }
  for (let tick=0;tick<=4;tick++)svg+=`<text x="${x(last*tick/4)}" y="${height-12}" text-anchor="middle">${number(last*tick/4*minutes/60)} h</text>`;
  svg += `<g clip-path="url(#plot)"><path d="${line(expected)}" fill="none" stroke="#99ae8d" stroke-width="1.6" stroke-dasharray="4 4"/><path d="${line(samples.map(s => s.flowLpm))}" fill="none" stroke="#204f40" stroke-width="2"/>`;
  if (reveal&&r.truth) svg += `<path d="${line(r.truth.map(t => t.lossLiters/minutes))}" fill="none" stroke="#b87337" stroke-width="2"/>`;
  svg += '</g></svg>'; $('chart').innerHTML = svg;
}
function renderRun() {
  const r = run(); if (!r) return;
  $('run-title').textContent = title(r); graph(r);
  const minutes=r.observation.samplingMinutes,count=r.observation.samples.length;
  const total = r.observation.samples.reduce((sum,s) => sum + (s.flowLpm || 0) * minutes, 0), missing = r.observation.samples.filter(s => s.flowLpm === null).length;
  $('truth').disabled=!r.truth;if(!r.truth)$('truth').checked=false;
  const kind=r.observation.site.simulated?'Simulación':r.source?.kind==='sensor'?'Sensor · gateway HTTP':'Archivo CSV';
  $('source-summary').textContent=`${kind} · ${r.observation.samples[0].timestamp} → ${r.observation.samples.at(-1).timestamp} · ${count} intervalos`;
  document.querySelector('.environment').textContent=`${kind.toUpperCase()} / UTC`;
  $('metrics').innerHTML = `<div class="metric"><small>VOLUMEN REGISTRADO · VENTANA</small><strong>${number(total)}<span>L</span></strong></div><div class="metric"><small>LECTURAS RECIBIDAS</small><strong>${count-missing}<span>/ ${count}</span></strong></div><div class="metric"><small>INTERVALO DE MUESTREO</small><strong>${minutes}<span>min</span></strong></div>`;
  $('detectors').innerHTML = r.evaluation.map(d => `<article class="detector"><div class="detector-head"><h3>${d.strategy === 'threshold' ? 'A / Umbral fijo' : 'B / Residual persistente'}</h3><span class="badge ${d.diagnosis !== 'normal' ? 'warn' : ''}">${escape(labels[d.diagnosis])}</span></div><p>${d.strategy === 'threshold' ? 'Más de 12 L/min durante 3 muestras consecutivas.' : 'Diferencia con el día de referencia, ajustada por riego, durante 12 muestras.'}</p><div class="detector-values"><div><strong>${number(d.detectionDelayMinutes)} <small>min hasta detectar fuga</small></strong></div><div><strong>${number(d.fp)}<small>muestras con falsa alarma</small></strong></div><div><strong>${number(d.lostBeforeDetectionLiters)}<small>L perdidos antes de detectar¹</small></strong></div></div></article>`).join('');
  $('continuity').innerHTML = '<option value="">Nueva investigación</option>' + state.jobs.filter(j => j.runId === r.id && j.webhookUrl === state.connection.url && j.sessionId && ['succeeded','failed','cancelled','interrupted'].includes(j.state)).map(j => `<option value="${j.id}">Continuar ${j.id.slice(0,8)} · ${escape(j.state)}</option>`).join('');
  if(!r.truth)$('detectors').querySelectorAll('.detector-values').forEach(el=>{el.innerHTML='<p>Sin verdad de referencia: no se calculan falsos positivos, retraso real ni pérdidas reales.</p>';});
  document.querySelector('.comparison>.section-heading>.mono').textContent=r.truth?'EVALUACIÓN CON VERDAD OCULTA':'OBSERVACIONES SIN VERDAD DE REFERENCIA';
  document.querySelector('.comparison>.hint').textContent=r.truth?'Métricas sobre las 24 h de evaluación. Falsas alarmas = muestras sin fuga marcadas como fuga. La pérdida incluye el intervalo de primera alarma; sin detección, suma toda la pérdida del horizonte. El agente no recibe esta verdad.':'Datos externos: primeras 24 h como referencia. Se necesitan muestras posteriores para comparar. No hay verdad oculta que permita confirmar aciertos o pérdidas; los detectores son heurísticos.';
  renderSessionPolicy();
}
function renderJob() {
  const j = state.jobs.find(j => j.id === selectedJob);
  document.querySelectorAll('[data-action]').forEach(b => { b.disabled = !j; });
  $('job-state').textContent = j?.state || 'SIN EJECUCIÓN';
  $('export-report').disabled=!j?.report;
  const partial = j && j.state !== 'succeeded' && typeof j.liveText === 'string' && j.liveText.length > 0;
  const liveStatus = $('live-status');
  liveStatus.textContent = !j ? '' : j.state === 'succeeded' ? 'Respuesta final' : j.streamOpen ? `EN VIVO · ${j.activity || 'Esperando al agente'}${partial ? ' · borrador parcial' : ''}` : partial ? 'Texto parcial conservado · consulta Estado o Retomar SSE' : j.activity || '';
  liveStatus.classList.toggle('is-live', !!j?.streamOpen && j.state !== 'succeeded');
  $('agent-response').classList.toggle('is-streaming', !!j?.streamOpen && !!partial);
  $('job-meta').textContent = j ? `job ${j.id}\nturn ${j.turnId || 'pendiente'} · session ${j.sessionId || 'pendiente'}\nwebhook ${j.webhookUrl || 'original'}\nclave ${j.idempotencyKey}\n${j.deliveryError || ''}` : 'La investigación aparecerá aquí.';
  if (!j) $('agent-response').innerHTML = '<div class="empty-illustration">H₂O<span>Los datos primero.<br>Las conclusiones después.</span></div>';
  else {
    const response = j.state === 'succeeded' ? j.response : partial ? j.liveText : j.response;
    const box = $('agent-response'), follow = box.scrollHeight - box.scrollTop - box.clientHeight < 70;
    const formatted=renderReportHTML(j,run());
    if(formatted!==null)box.innerHTML=formatted;
    else box.textContent = typeof response === 'string' ? response : response ? String(response.response ?? JSON.stringify(response, null, 2)) : 'Esperando resultado del agente.';
    if (follow) box.scrollTop = box.scrollHeight;
  }
  $('event-count').textContent = j?.events.length || 0;
  $('events').innerHTML = (j?.events || []).map(e => `<div>${escape(e.sequence ?? '·')} / ${escape(e.type)} <span>${escape(e.id || '')}</span></div>`).join('');
}
function renderHistory() {
  $('history').innerHTML = state.runs.slice(0,12).map(r => `<button data-run="${r.id}" class="${r.id===selected?'selected':''}">${escape(title(r))}<small>${r.source?escape(r.source.kind.toUpperCase()):'SEED '+r.seed} / ${r.id.slice(0,8)}</small></button>`).join('');
  $('history').querySelectorAll('button').forEach(b => b.onclick = () => selectRun(b.dataset.run));
  $('job-history').innerHTML = state.jobs.filter(j => j.runId === selected).slice(0,12).map(j => `<button data-job="${j.id}">Investigación ${j.id.slice(0,8)} · ${escape(j.state)}</button>`).join('');
  $('job-history').querySelectorAll('button').forEach(b => b.onclick = () => { selectedJob = b.dataset.job; renderJob(); $('investigacion').scrollIntoView(); });
}
function download(name,value,type='application/json'){
  const url=URL.createObjectURL(new Blob([typeof value==='string'?value:JSON.stringify(value,null,2)],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('export-report').onclick=()=>{const j=state.jobs.find(j=>j.id===selectedJob);if(j?.report)download(`water-report-${j.id}.json`,j.report);};
$('csv-example').onclick=()=>download('formato-water-lab.csv','timestamp,flowLpm\n2026-01-01T00:00:00Z,0.4\n2026-01-01T00:05:00Z,0.5\n2026-01-01T00:10:00Z,\n','text/csv');
$('csv-form').onsubmit=async event=>{
  event.preventDefault();$('csv-import').disabled=true;
  try{const file=$('csv-file').files[0];if(!file||file.size>100000)throw Error('Selecciona un CSV de hasta 100 KB');const r=await api('/api/import/csv',{csv:await file.text(),name:file.name,samplingMinutes:Number($('csv-interval').value)});state.runs.unshift(r);selectRun(r.id);notify('CSV importado. Las lecturas externas no incluyen verdad oculta.');}catch(error){notify(error.message);}finally{$('csv-import').disabled=false;}
};
function renderSensors(){
  $('sensor-status').textContent=state.sensorIngestConfigured?'Receptor autenticado listo. Crea una captura inmutable para investigar las lecturas recibidas.':'Ejecuta npm run setup y reinicia para generar SENSOR_INGEST_TOKEN. El receptor está deshabilitado hasta configurarlo.';
  $('sensors-list').innerHTML=(state.sensors||[]).map(s=>`<div class="sensor-item"><div><strong>${escape(s.sensorId)}</strong><small>${s.readingCount} intervalos · ${escape(s.lastTimestamp)}</small></div><button class="secondary" data-sensor="${s.id}">Crear captura</button></div>`).join('');
  $('sensors-list').querySelectorAll('button').forEach(b=>b.onclick=async()=>{try{const r=await api(`/api/sensors/${b.dataset.sensor}/snapshot`,{});state.runs.unshift(r);selectRun(r.id);notify('Captura guardada. Las siguientes lecturas no alterarán esta evidencia.');}catch(error){notify(error.message);}});
}
function renderSessionPolicy(){
  const policy=state.sessionPolicy||{enabled:false};
  $('shared-session').checked=policy.enabled;
  $('continuity').disabled=policy.enabled;if(policy.enabled)$('continuity').value='';
  $('reset-session').disabled=!policy.enabled;
  $('session-info').textContent=policy.enabled?(policy.sessionId?`Sesión compartida: ${policy.sessionId}`:'La próxima consulta establecerá la sesión compartida.'):'Desactivado: consultas aisladas o continuidad manual desde Conversación.';
}
$('shared-session').onchange=async()=>{
  try{state.sessionPolicy=await api('/api/session-policy',{enabled:$('shared-session').checked});renderSessionPolicy();notify(state.sessionPolicy.enabled?'Sesión única activada para este webhook. Se reutiliza la última sesión disponible.':'Sesión única desactivada. Puedes iniciar consultas aisladas.');}catch(error){renderSessionPolicy();notify(error.message);}
};
$('reset-session').onclick=async()=>{try{state.sessionPolicy=await api('/api/session-reset',{});renderSessionPolicy();notify('La próxima consulta empezará otra sesión. El historial anterior se conserva.');}catch(error){notify(error.message);}};
$('simulate-form').onsubmit = async event => {
  event.preventDefault();
  try { const r = await api('/api/runs', { scenario: document.querySelector('input[name=scenario]:checked').value, seed: Number($('seed').value), leakLpm: Number($('leak').value) }); state.runs.unshift(r); selectRun(r.id); notify('Simulación guardada. No se ha llamado a ningún modelo.'); }
  catch (error) { notify(error.message); }
};
$('truth').onchange = () => graph(run());
$('export').onclick = () => { const r = run(); const url = URL.createObjectURL(new Blob([JSON.stringify(r,null,2)], { type:'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `water-lab-${r.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
$('connection-form').onsubmit = async event => {
  event.preventDefault(); $('save-connection').disabled = true;
  try {
    state.connection = await api('/api/connection', { url: $('webhook-url').value.trim() });
    state.sessionPolicy=(await api('/api/state')).sessionPolicy;
    $('webhook-url').value = state.connection.url;
    $('connection-status').textContent = 'URL guardada · sin comprobar';
    renderRun();
    notify('URL guardada. Pulsa Comprobar conexión después de vincular el plugin.');
  } catch (error) { notify(error.message); }
  finally { $('save-connection').disabled = false; }
};
$('discover').onclick = async () => {
  $('discover').disabled = true;
  try { const d = await api('/api/discovery'); $('connection-status').textContent = d.protocolVersion === 1 ? 'Protocolo v1 disponible' : 'Core sin protocolo v1'; notify(JSON.stringify(d)); }
  catch (error) { $('connection-status').textContent = 'Urano no disponible'; notify(error.message); }
  finally { $('discover').disabled = false; }
};
$('investigate').onclick = async () => {
  if (busy) return; busy = true; $('investigate').disabled = true;
  try {
    const j = await api('/api/jobs', { runId: selected, question: $('question').value, transport: $('transport').value, previousJobId: state.sessionPolicy?.enabled?undefined:$('continuity').value || undefined });
    state.jobs.unshift(j); selectedJob = j.id; renderJob(); renderHistory(); notify('Investigación enviada a Urano.');
  } catch (error) { notify(error.message); }
  finally { busy = false; $('investigate').disabled = false; }
};
document.querySelectorAll('[data-action]').forEach(button => { button.onclick = async () => {
  if (!selectedJob) return; button.disabled = true;
  try { await api(`/api/jobs/${selectedJob}/${button.dataset.action}`, {}); notify(button.dataset.action === 'retry' ? 'Recuperando el mismo turno; si falta su ID, se reentrega el payload original con su clave.' : 'Control enviado al turno existente.'); }
  catch (error) { notify(error.message); }
  finally { button.disabled = false; }
}; });
async function main() {
  state = await api('/api/state');
  renderSensors();
  $('webhook-url').value = state.connection.url;
  $('scenarios').innerHTML = state.scenarios.map((s,i) => `<label class="scenario"><input type="radio" name="scenario" value="${s.id}" ${i===1?'checked':''}><strong>${escape(s.name)}</strong><small>${escape(s.description)}</small></label>`).join('');
  if (!state.runs.length) state.runs.push(await api('/api/runs', { scenario:'slow-leak', seed:42, leakLpm:0.8 }));
  selectRun(state.runs.some(r => r.id === localStorage.getItem('water-run')) ? localStorage.getItem('water-run') : state.runs[0].id);
  const stream = new EventSource('/api/events');
  stream.addEventListener('sources',async()=>{try{const fresh=await api('/api/state');state.sensors=fresh.sensors;state.sensorIngestConfigured=fresh.sensorIngestConfigured;renderSensors();}catch{}});
  stream.addEventListener('job', event => {
    const j = JSON.parse(event.data), index = state.jobs.findIndex(old => old.id === j.id);
    if (index >= 0) state.jobs[index] = j; else state.jobs.unshift(j);
    if(state.sessionPolicy?.enabled&&j.webhookUrl===state.connection.url&&j.sessionGeneration===state.sessionPolicy.generation&&j.sessionId){state.sessionPolicy.sessionId=j.sessionId;renderSessionPolicy();}
    if (j.id === selectedJob) renderJob(); renderHistory();
    const value = $('continuity').value;
    $('continuity').innerHTML = '<option value="">Nueva investigación</option>' + state.jobs.filter(old => old.runId === selected && old.webhookUrl === state.connection.url && old.sessionId && ['succeeded','failed','cancelled','interrupted'].includes(old.state)).map(old => `<option value="${old.id}">Continuar ${old.id.slice(0,8)} · ${escape(old.state)}</option>`).join('');
    $('continuity').value = value;
    renderSessionPolicy();
  });
  // EventSource reconnects transport; refresh persisted state to catch events missed locally.
  stream.onopen = async () => { try { const fresh = await api('/api/state'); state.jobs = fresh.jobs;state.sessionPolicy=fresh.sessionPolicy;state.sensors=fresh.sensors;state.sensorIngestConfigured=fresh.sensorIngestConfigured;renderSensors();renderSessionPolicy(); renderJob(); renderHistory(); } catch {} };
}
main().catch(error => notify(error.message));
