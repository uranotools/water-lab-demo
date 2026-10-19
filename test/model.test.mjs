import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, evidence, scenarios, intervention } from '../src/model.mjs';
test('semilla reproduce observaciones y hash sin repetir IDs', () => {
  const a = simulate(), b = simulate(); assert.deepEqual(a.observation,b.observation); assert.equal(a.evidenceId,b.evidenceId); assert.notEqual(a.id,b.id);
  assert.notEqual(simulate({seed:43}).evidenceId,a.evidenceId);
});
test('detectores distinguen fuga, normalidad y calidad sin usar verdad oculta', () => {
  const expected = { normal:'normal', 'slow-leak':'possible_leak', burst:'possible_leak', irrigation:'normal', 'stuck-sensor':'sensor_stuck', missing:'sensor_missing' };
  for (const scenario of scenarios) for (const seed of [1,42,500]) {
    const r = simulate({scenario:scenario.id,seed}); const d = r.evaluation[1];
    assert.equal(d.diagnosis,expected[scenario.id], `${scenario.id} seed ${seed}`); assert.equal(d.fp,0);
    assert.equal(d.tp+d.fp+d.fn+d.tn,288);
  }
  const leak = simulate(); assert.equal(leak.evaluation[0].firstLeakIndex,null); assert.equal(leak.evaluation[1].detectionDelayMinutes,55);
});
test('evidencia no filtra etiquetas ni verdad y el contrafactual no usa pérdidas ocultas', () => {
  const r = simulate(); const e = evidence(r); assert.equal(e.scenario,undefined); assert.equal(e.truth,undefined); assert.equal(e.evaluation,undefined);
  const baseline = intervention(r); r.truth = []; assert.deepEqual(intervention(r),baseline);
  assert.ok(baseline.estimatedAvoidableLitersNext24h > 1000); assert.throws(() => intervention(r,{repairAfterMinutes:-1}));
});
test('rechaza parámetros fuera del dominio', () => {
  for (const options of [{scenario:'../bad'}, {seed:NaN}, {seed:-1}, {seed:2**32}, {leakLpm:Infinity}, {leakLpm:0}]) assert.throws(() => simulate(options));
});
