import test from 'node:test';import assert from 'node:assert/strict';
import {parseReport,partialSummary} from '../public/report.js';import {renderReportHTML} from '../public/reports-ui.js';
export const report={schemaVersion:'water-lab.report.v1',runId:'run',evidenceId:'hash',summary:'Consumo que requiere revisión.',diagnosis:'possible_leak',severity:'medium',confidence:'low',findings:[{sampleIndices:[1],statement:'Elevación sostenida.'}],uncertainties:['No hay inspección física'],nextChecks:['Verificar medidor'],recommendations:[{priority:'medium',action:'Inspeccionar instalación',reason:'Corroborar origen'}]};
test('JSON válido se segmenta; referencias de otra evidencia o índices inválidos se rechazan',()=>{
  const expected={runId:'run',evidenceId:'hash',sampleCount:3};assert.ok(parseReport(JSON.stringify(report),expected).report);
  for(const changes of [{runId:'other'},{evidenceId:'wrong'},{severity:'critical'},{findings:[{sampleIndices:[3],statement:'x'}]},{nextChecks:null}])assert.equal(parseReport({...report,...changes},expected).report,null);
  assert.equal(parseReport('### Diagnóstico libre',expected).report,null);
  assert.ok(parseReport({response:JSON.stringify(report)},expected).report);
});
test('resumen parcial se decodifica sin mostrar JSON crudo y el HTML escapa contenido',()=>{
  assert.equal(partialSummary('{"summary":"Caudal alto'),'Caudal alto');assert.equal(partialSummary('{"summary":"Medición \\u00e1gil"}'),'Medición ágil');
  const html=renderReportHTML({state:'succeeded',report:{...report,summary:'<script>alert(1)</script>'}},{observation:{samples:[{}, {timestamp:'2026-01-01T00:05:00Z',flowLpm:2}]}});
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('Evidencia observada'));assert.ok(html.includes('2 L/min'));
});
test('extrae informe rodeado de narración, fences y otros objetos sin perder validaciones',()=>{
  const expected={runId:'run',evidenceId:'hash',sampleCount:3};
  const tricky={...report,summary:'Texto con {llaves}, "comillas" y \\ caracteres.'};
  for(const raw of [
    `I'll start by reading the WebSearch skill as instructed, then query the water-lab evidence.\n\n${JSON.stringify(tricky)}`,
    `Antes: {"tool":"get_evidence"}\n\`\`\`json\n${JSON.stringify(tricky)}\n\`\`\`\nFin.`,
    `Datos: ${JSON.stringify({wrapped:tricky})}`
  ]){const parsed=parseReport(raw,expected);assert.equal(parsed.reportError,null);assert.equal(parsed.report.summary,tricky.summary);}
  for(const wrong of [{...report,evidenceId:'foreign'},{...report,runId:'foreign'},{...report,findings:[{sampleIndices:[999],statement:'Fuera de rango'}]}])assert.equal(parseReport(`Narración\n${JSON.stringify(wrong)}`,expected).report,null);
});
test('no acepta JSON incompleto ni elige silenciosamente entre informes distintos',()=>{
  assert.equal(parseReport(`Narración\n${JSON.stringify(report).slice(0,-1)}`).report,null);
  const ambiguous=parseReport(`Primero ${JSON.stringify(report)}\nDespués ${JSON.stringify({...report,summary:'Otro diagnóstico'})}`);
  assert.equal(ambiguous.report,null);assert.match(ambiguous.reportError,/ambigua/);
  const repeated=parseReport(`Antes ${JSON.stringify(report)}\nRepetido ${JSON.stringify(report)}`);assert.ok(repeated.report);
});
test('SSE presenta resumen segmentado aunque exista narración antes del JSON parcial',()=>{
  const html=renderReportHTML({state:'running',liveText:'I will query the tools.\n{"schemaVersion":"water-lab.report.v1","summary":"Caudal elevado'},null);
  assert.ok(html.includes('Caudal elevado'));assert.ok(html.includes('BORRADOR'));assert.ok(!html.includes('I will query'));
});
