export const REPORT_INSTRUCTIONS = `Devuelve exclusivamente un objeto JSON válido, sin Markdown ni bloques de código, con este contrato:
{"schemaVersion":"water-lab.report.v1","runId":"ID consultado","evidenceId":"hash exacto de get_evidence","summary":"Resumen claro en español","diagnosis":"normal|possible_leak|sensor_fault|usage_change|insufficient_data","severity":"low|medium|high","confidence":"low|medium|high","findings":[{"sampleIndices":[0],"statement":"Hallazgo respaldado por esas muestras"}],"uncertainties":["Qué no se puede concluir"],"nextChecks":["Siguiente prueba concreta"],"recommendations":[{"priority":"low|medium|high","action":"Acción propuesta","reason":"Justificación"}]}
Los valores con | son opciones: elige una sola. Consulta get_evidence antes de responder. No inventes mediciones, hashes, muestras ni acciones ejecutadas. confidence expresa una valoración cualitativa del modelo, no una probabilidad calibrada. Usa listas vacías si no hay hallazgos o recomendaciones respaldados. Redacta summary primero para mostrarlo en vivo. Diferencia datos simulados, importados y sensor según la evidencia. Si falta calibración o hay datos ausentes, declara la limitación.`;
const levels = ['low','medium','high'];
const text = (v,max=2000) => typeof v==='string' && v.trim().length>0 && v.length<=max;
const strings = v => Array.isArray(v)&&v.length<=20&&v.every(x=>text(x));
function parseReplyJSON(raw, expected) {
  if(raw.length>64000)throw Error('Informe demasiado grande');
  const clean=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{return JSON.parse(clean);}catch{/* A model may prepend tool narration. Extract complete objects only. */}
  const starts=[],candidates=[],seen=new Set();let quoted=false,escaped=false;
  for(let i=0;i<raw.length;i++){
    const c=raw[i];
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'&&starts.length){quoted=true;continue;}
    if(c==='{')starts.push(i);
    if(c==='}'&&starts.length){
      const start=starts.pop(),slice=raw.slice(start,i+1);
      if(!slice.includes('water-lab.report.v1'))continue;
      try{const value=JSON.parse(slice);if(value?.schemaVersion!=='water-lab.report.v1')continue;const key=JSON.stringify(value);if(!seen.has(key)){seen.add(key);candidates.push(value);}}catch{/* Never repair malformed JSON. */}
      if(candidates.length>32)throw Error('Demasiados informes JSON en una respuesta');
    }
  }
  const valid=candidates.filter(candidate=>parseReport(candidate,expected).report);
  if(valid.length===1)return valid[0];
  if(valid.length>1)throw Error('Respuesta ambigua: contiene varios informes válidos distintos');
  if(candidates.length===1)return candidates[0]; // Preserve the specific validation error.
  throw Error('No se encontró un informe JSON completo y válido en la respuesta');
}
export function parseReport(response, expected={}) {
  let value=response;
  try {
    for(let i=0;i<4;i++){
      if(typeof value==='string') value=parseReplyJSON(value,expected);
      else if(value?.schemaVersion)break;
      else if(value?.report)value=value.report;
      else if(value?.response!==undefined)value=value.response;
      else break;
    }
    const r=value;
    if(!r||r.schemaVersion!=='water-lab.report.v1'||!text(r.runId,80)||!text(r.evidenceId,100)||!text(r.summary,4000))throw Error('Faltan los campos principales del informe JSON v1');
    if(!['normal','possible_leak','sensor_fault','usage_change','insufficient_data'].includes(r.diagnosis)||!levels.includes(r.severity)||!levels.includes(r.confidence))throw Error('Diagnóstico, severidad o confianza inválidos');
    if(expected.runId&&r.runId!==expected.runId)throw Error('El informe pertenece a otro experimento');
    if(expected.evidenceId&&r.evidenceId!==expected.evidenceId)throw Error('El hash del informe no coincide con la evidencia');
    if(!Array.isArray(r.findings)||r.findings.length>20||!r.findings.every(f=>text(f?.statement)&&Array.isArray(f.sampleIndices)&&f.sampleIndices.length>0&&f.sampleIndices.length<=20&&f.sampleIndices.every(i=>Number.isInteger(i)&&i>=0&&i<(expected.sampleCount??576))))throw Error('Referencias de muestras inválidas');
    if(!strings(r.uncertainties)||!strings(r.nextChecks)||!Array.isArray(r.recommendations)||r.recommendations.length>20||!r.recommendations.every(a=>levels.includes(a?.priority)&&text(a.action)&&text(a.reason)))throw Error('Secciones del informe inválidas');
    return {report:{schemaVersion:r.schemaVersion,runId:r.runId,evidenceId:r.evidenceId,summary:r.summary,diagnosis:r.diagnosis,severity:r.severity,confidence:r.confidence,findings:r.findings.map(f=>({statement:f.statement,sampleIndices:f.sampleIndices})),uncertainties:r.uncertainties,nextChecks:r.nextChecks,recommendations:r.recommendations.map(a=>({priority:a.priority,action:a.action,reason:a.reason}))},reportError:null};
  } catch(error){return {report:null,reportError:error.message};}
}
export function partialSummary(raw) {
  const match=String(raw||'').match(/"summary"\s*:\s*"/);if(!match)return '';
  let out='', escaped=false;
  for(const c of String(raw).slice(match.index+match[0].length)){
    if(!escaped&&c==='"')break;
    if(!escaped&&c==='\\'){escaped=true;out+=c;continue;}
    out+=c;escaped=false;
  }
  if(escaped)out=out.slice(0,-1);
  out=out.replace(/\\u[0-9a-f]{0,3}$/i,'');
  try{return JSON.parse(`"${out}"`);}catch{return '';}
}
