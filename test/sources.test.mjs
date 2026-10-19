import test from 'node:test';import assert from 'node:assert/strict';
import {parseCSV,normalizeReadings,observationRun,mergeSensor} from '../src/sources.mjs';import {evidence,intervention,simulate} from '../src/model.mjs';
test('CSV quoted, BOM, columnas reordenadas y huecos sin convertirlos a cero',()=>{
  const rows=parseCSV('\uFEFFflowLpm;timestamp\n"0.4";"2026-01-01T00:00:00Z"\n;2026-01-01T00:10:00Z\n');
  const samples=normalizeReadings(rows,5);assert.equal(samples.length,3);assert.equal(samples[1].flowLpm,null);assert.equal(samples[2].flowLpm,null);
  for(const csv of ['timestamp,value\nx,1','timestamp,flowLpm\n2026-01-01T00:00:00Z,NaN','timestamp,flowLpm\n"broken'])assert.throws(()=>parseCSV(csv));
});
test('observaciones externas carecen de verdad oculta y no fabrican métricas con datos insuficientes',()=>{
  const r=observationRun({readings:[{timestamp:'2026-01-01T00:00:00Z',flowLpm:0.4}]});
  assert.equal(r.truth,null);assert.equal(r.observation.site.simulated,false);assert.equal(r.evaluation[1].diagnosis,'insufficient_data');assert.equal(r.evaluation[1].fp,null);assert.equal(evidence(r).truth,undefined);assert.equal(intervention(r).status,'unavailable');
});
test('normalización rechaza unidades implícitas, tiempos sin zona, negativos, duplicados conflictivos y cadencia irregular',()=>{
  const ts='2026-01-01T00:00:00Z';
  for(const readings of [[{timestamp:ts,flowLpm:-1}],[{timestamp:'2026-01-01T00:00:00',flowLpm:1}],[{timestamp:ts,flowLpm:'1'}],[{timestamp:ts,flowLpm:1},{timestamp:ts,flowLpm:2}],[{timestamp:ts,flowLpm:1},{timestamp:'2026-01-01T00:06:00Z',flowLpm:1}]])assert.throws(()=>normalizeReadings(readings));
  assert.throws(()=>mergeSensor(null,{sensorId:'a',readings:[{timestamp:ts,flowLpm:1}]}),/unit/);
});
test('sensor acumula lecturas idempotentes y permite completar una lectura ausente',()=>{
  const batch={sensorId:'meter-1',unit:'L/min',samplingMinutes:5,readings:[{timestamp:'2026-01-01T00:00:00Z',flowLpm:null}]};
  const first=mergeSensor(null,batch);assert.equal(first.samples[0].flowLpm,null);
  const second=mergeSensor(first,{...batch,readings:[{timestamp:'2026-01-01T00:00:00Z',flowLpm:0.4}]});
  const third=mergeSensor(second,{...batch,readings:[{timestamp:'2026-01-01T00:00:00Z',flowLpm:0.4},{timestamp:'2026-01-01T00:10:00Z',flowLpm:1}]});
  assert.equal(third.id,first.id);assert.equal(third.samples.length,3);assert.equal(third.samples[1].flowLpm,null);
  assert.throws(()=>mergeSensor(third,{...batch,readings:[{timestamp:'2026-01-01T00:00:00Z',flowLpm:8}]}),/conflictiva/);
});
test('una referencia ausente no se interpreta como caudal cero en el detector residual',()=>{
  const sim=simulate({scenario:'normal'}),readings=sim.observation.samples.map(s=>({...s,flowLpm:s.index<288?null:s.flowLpm}));
  const r=observationRun({readings});assert.equal(r.evaluation[1].diagnosis,'insufficient_data');assert.equal(r.evaluation[1].firstLeakIndex,null);
});
