import { randomUUID, createHash } from 'node:crypto';

export const scenarios = [
  { id: 'normal', name: 'Un día normal', description: 'Duchas, cocina y consumo nocturno bajo.' },
  { id: 'slow-leak', name: 'Fuga silenciosa', description: 'Una pérdida pequeña que persiste durante horas.' },
  { id: 'burst', name: 'Rotura de tubería', description: 'Aumento súbito y sostenido del caudal.' },
  { id: 'stuck-sensor', name: 'Sensor congelado', description: 'El medidor repite una lectura mientras el consumo continúa.' },
  { id: 'irrigation', name: 'Riego programado', description: 'Consumo alto legítimo respaldado por el calendario.' },
  { id: 'missing', name: 'Telemetría interrumpida', description: 'El sensor deja de enviar mediciones.' }
];
const round = n => Math.round(n * 1000) / 1000;
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const base = slot => { const h = slot / 12; return 0.18 + 3.5 * Math.exp(-(((h - 7) / 1.3) ** 2)) + 2.8 * Math.exp(-(((h - 19) / 1.8) ** 2)) + (h > 11 && h < 14 ? 0.7 : 0); };
export function simulate({ scenario = 'slow-leak', seed = 42, leakLpm = 0.8 } = {}) {
  if (!scenarios.some(s => s.id === scenario)) throw new Error('Escenario inválido');
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new Error('Semilla inválida');
  if (!Number.isFinite(leakLpm) || leakLpm < 0.2 || leakLpm > 5) throw new Error('Fuga debe estar entre 0.2 y 5 L/min');
  const random = rng(seed), samples = [], truth = [], start = 336;
  for (let i = 0; i < 576; i++) {
    const ordinary = Math.max(0.01, base(i % 288) + (random() - 0.5) * 0.12);
    const loss = i >= start ? scenario === 'slow-leak' ? leakLpm : scenario === 'burst' ? 15 : 0 : 0;
    const irrigation = scenario === 'irrigation' && i >= 360 && i < 384 ? 9 : 0;
    const actual = ordinary + loss + irrigation;
    let flow = round(actual);
    if (scenario === 'stuck-sensor' && i >= start) flow = samples[start - 1].flowLpm;
    if (scenario === 'missing' && i >= start && i < 432) flow = null;
    samples.push({ index: i, timestamp: new Date(Date.UTC(2026, 0, 1) + i * 300000).toISOString(), flowLpm: flow });
    truth.push({ index: i, leak: loss > 0, lossLiters: loss * 5, actualLpm: round(actual) });
  }
  const observation = {
    site: { id: 'casa-demo', name: 'Casa del jardín', occupants: 4, timezone: 'UTC', simulated: true },
    samplingMinutes: 5, calibrationSamples: 288,
    schedule: scenario === 'irrigation' ? [{ startIndex: 360, endIndex: 384, extraLpm: 9, activity: 'Riego autorizado' }] : [], samples
  };
  const evidenceId = createHash('sha256').update(JSON.stringify(observation)).digest('hex');
  const run = { id: randomUUID(), createdAt: new Date().toISOString(), scenario, seed, leakLpm, observation, evidenceId, truth };
  run.evaluation = evaluate(run);
  return run;
}
// Neither detector reads scenario labels or hidden ground truth.
export function detect(observation, strategy = 'statistical') {
  const { samples, calibrationSamples: n, schedule } = observation;
  const flags = []; let streak = 0, identical = 0, missing = 0, firstLeak = null, usable = 0;
  for (let i = n; i < samples.length; i++) {
    const flow = samples[i].flowLpm;
    if (flow === null) { missing++; streak = 0; identical = 0; if (missing >= 3) flags.push({ index: i, kind: 'sensor_missing' }); continue; }
    missing = 0;
    identical = samples[i - 1].flowLpm === flow ? identical + 1 : 0;
    if (identical >= 7) { streak = 0; flags.push({ index: i, kind: 'sensor_stuck' }); continue; }
    const reference = samples[i % n]?.flowLpm;
    if (strategy === 'statistical' && (reference === null || reference === undefined)) { streak=0; continue; }
    usable++;
    const expected = reference + schedule.filter(s => i >= s.startIndex && i < s.endIndex).reduce((a, s) => a + s.extraLpm, 0);
    const suspicious = strategy === 'threshold' ? flow > 12 : flow - expected > 0.18;
    streak = suspicious ? streak + 1 : 0;
    if (streak >= (strategy === 'threshold' ? 3 : 12)) {
      flags.push({ index: i, kind: 'possible_leak' }); firstLeak ??= i;
    }
  }
  const quality = flags.find(f => f.kind.startsWith('sensor_'));
  return { strategy, diagnosis: quality?.kind || (firstLeak !== null ? 'possible_leak' : usable < 12 ? 'insufficient_data' : 'normal'), firstLeakIndex: firstLeak, flags };
}
export function evaluate(run) {
  const truthLeak = run.truth.some(t => t.leak), start = run.truth.findIndex(t => t.leak);
  return ['threshold', 'statistical'].map(strategy => {
    const result = detect(run.observation, strategy), predicted = new Set(result.flags.filter(f => f.kind === 'possible_leak').map(f => f.index));
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (let i = 288; i < run.truth.length; i++) {
      const actual = run.truth[i].leak, flag = predicted.has(i);
      if (actual && flag) tp++; else if (flag) fp++; else if (actual) fn++; else tn++;
    }
    const detected = result.firstLeakIndex;
    return { ...result, tp, fp, fn, tn, truthLeak,
      detectionDelayMinutes: truthLeak && detected !== null ? (detected - start) * 5 : null,
      lostBeforeDetectionLiters: truthLeak ? round(run.truth.filter(t => detected === null || t.index <= detected).reduce((a, t) => a + t.lossLiters, 0)) : 0,
      totalLostLiters: round(run.truth.reduce((a, t) => a + t.lossLiters, 0)) };
  });
}
export function evidence(run) {
  return { runId: run.id, evidenceId: run.evidenceId, ...run.observation, note: run.observation.site.simulated ? 'Datos sintéticos. Primeras 24 h de calibración; siguientes 24 h de evaluación. Etiqueta y verdad oculta excluidas.' : 'Observaciones externas, sin verdad oculta ni confirmación física de fugas. Primeras 24 h como referencia; la comparación necesita muestras posteriores. Fuente declarada por el importador o gateway; calidad y calibración del instrumento no verificadas.' };
}
export function intervention(run, { repairAfterMinutes = 60 } = {}) {
  if (!Number.isFinite(repairAfterMinutes) || repairAfterMinutes < 0 || repairAfterMinutes > 1440) throw new Error('Tiempo de reparación inválido');
  // Uses observations only; estimates savings, never reads hidden losses.
  const o = run.observation, n=o.calibrationSamples;
  const diagnosis=detect(o).diagnosis;
  if(['insufficient_data','sensor_stuck','sensor_missing'].includes(diagnosis))return {runId:run.id,evidenceId:run.evidenceId,status:'unavailable',reason:'No se estima ahorro sin referencia suficiente y telemetría utilizable.'};
  const residuals = o.samples.slice(n).filter(s => s.flowLpm !== null && o.samples[s.index%n]?.flowLpm != null).map(s => s.flowLpm - o.samples[s.index % n].flowLpm - o.schedule.filter(p => s.index >= p.startIndex && s.index < p.endIndex).reduce((a,p) => a+p.extraLpm,0)).sort((a,b) => a-b);
  const estimate = Math.max(0, residuals[Math.floor(residuals.length / 2)] || 0);
  return { runId: run.id, evidenceId: run.evidenceId, estimatedLeakLpm: round(estimate), estimatedAvoidableLitersNext24h: round(estimate * (1440 - repairAfterMinutes)), repairAfterMinutes, assumption: 'Residual mediano atribuido hipotéticamente a fuga; no confirma causa. Caudal constante y reparación efectiva dentro del horizonte.' };
}
