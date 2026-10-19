import {randomUUID,createHash} from 'node:crypto';
import {detect} from './model.mjs';
export function interval(value=5){const n=Number(value);if(![5,15,60].includes(n))throw Error('Intervalo permitido: 5, 15 o 60 minutos');return n;}
export function normalizeReadings(readings, minutes=5, trim=false){
  minutes=interval(minutes);if(!Array.isArray(readings)||!readings.length||readings.length>2000)throw Error('Envía entre 1 y 2000 lecturas');
  const map=new Map();
  for(const r of readings){
    if(typeof r?.timestamp!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(r.timestamp)||!Number.isFinite(Date.parse(r.timestamp)))throw Error('timestamp debe ser ISO 8601 con zona horaria');
    const [year,month,day,hour,minute,second]=r.timestamp.match(/\d+/g).slice(0,6).map(Number), date=new Date(Date.UTC(year,month-1,day));
    if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||hour>23||minute>59||second>59)throw Error('Fecha de calendario inválida');
    if(r.flowLpm!==null&&(typeof r.flowLpm!=='number'||!Number.isFinite(r.flowLpm)||r.flowLpm<0||r.flowLpm>10000))throw Error('flowLpm debe ser un número de 0 a 10000 o null; unidades L/min');
    const t=Date.parse(r.timestamp);if(map.has(t)&&map.get(t)!==r.flowLpm)throw Object.assign(Error('Lectura conflictiva para el mismo timestamp'),{status:409});map.set(t,r.flowLpm);
  }
  const sorted=[...map.keys()].sort((a,b)=>a-b), step=minutes*60000, last=sorted.at(-1), first=trim?Math.max(sorted[0],last-575*step):sorted[0];
  if((last-first)/step>575)throw Error('Máximo 576 intervalos por importación');
  if(sorted.some(t=>(t-sorted[0])%step!==0))throw Error('Los timestamps no coinciden con el intervalo declarado');
  const samples=[];for(let t=first;t<=last;t+=step)samples.push({index:samples.length,timestamp:new Date(t).toISOString(),flowLpm:map.has(t)?map.get(t):null});return samples;
}
export function parseCSV(csv){
  if(typeof csv!=='string'||Buffer.byteLength(csv)>100000)throw Error('CSV máximo 100 KB');
  csv=csv.replace(/^\uFEFF/,'');const delimiter=csv.split(/\r?\n/)[0].includes(';')?';':',';
  let rows=[],row=[],field='',quoted=false;
  for(let i=0;i<csv.length;i++){const c=csv[i];if(c==='"'){if(quoted&&csv[i+1]==='"'){field+='"';i++;}else if(quoted||field==='')quoted=!quoted;else throw Error('Comillas CSV inválidas');}
    else if(!quoted&&(c===delimiter||c==='\n')){row.push(field.trim());field='';if(c==='\n'){if(row.some(Boolean))rows.push(row);row=[];}}
    else if(c!=='\r'||quoted)field+=c;}
  if(quoted)throw Error('CSV con comillas sin cerrar');row.push(field.trim());if(row.some(Boolean))rows.push(row);
  const header=rows.shift();if(!header||header.length!==2||!header.includes('timestamp')||!header.includes('flowLpm'))throw Error('Cabeceras requeridas: timestamp,flowLpm');
  const ti=header.indexOf('timestamp'),fi=header.indexOf('flowLpm');
  return rows.map(r=>{if(r.length!==2)throw Error('Cada fila debe tener dos columnas');const v=r[fi];if(v!==''&&!/^\d+(?:\.\d+)?$/.test(v))throw Error('Caudal CSV inválido; usa punto decimal o celda vacía');return {timestamp:r[ti],flowLpm:v===''?null:Number(v)};});
}
export function observationRun({readings,samplingMinutes=5,name='Fuente externa',kind='csv',sensorId}){
  const minutes=interval(samplingMinutes), samples=normalizeReadings(readings,minutes);
  const source={kind,name:String(name).slice(0,120),...(sensorId?{sensorId}:{}),receivedAt:new Date().toISOString()};
  const observation={site:{id:sensorId||'imported',name:source.name,timezone:'UTC',simulated:false},source,samplingMinutes:minutes,calibrationSamples:1440/minutes,schedule:[],samples};
  const evidenceId=createHash('sha256').update(JSON.stringify(observation)).digest('hex');
  return {id:randomUUID(),createdAt:new Date().toISOString(),source,scenario:null,observation,evidenceId,truth:null,evaluation:['threshold','statistical'].map(strategy=>({...detect(observation,strategy),groundTruthAvailable:false,detectionDelayMinutes:null,lostBeforeDetectionLiters:null,fp:null}))};
}
export function mergeSensor(previous,{sensorId,readings,samplingMinutes=5,unit}){
  if(typeof sensorId!=='string'||!/^[-a-zA-Z0-9_]{1,64}$/.test(sensorId))throw Error('sensorId debe tener 1–64 letras, números, guion o underscore');
  if(unit!=='L/min')throw Error('Declara unit: L/min');const minutes=interval(samplingMinutes);
  if(previous&&previous.samplingMinutes!==minutes)throw Error('El intervalo del sensor no puede cambiar; usa otro sensorId');
  // Validate the incoming batch before combining with the rolling persisted window.
  const batch=normalizeReadings(readings,minutes,true);
  const merged=new Map((previous?.samples||[]).map(s=>[s.timestamp,s]));
  for(const sample of batch){const old=merged.get(sample.timestamp);if(old?.flowLpm!=null&&sample.flowLpm!=null&&old.flowLpm!==sample.flowLpm)throw Object.assign(Error('Lectura conflictiva para el mismo timestamp'),{status:409});if(!old||old.flowLpm===null)merged.set(sample.timestamp,sample);}
  const samples=normalizeReadings([...merged.values()],minutes,true);
  return {id:previous?.id||randomUUID(),createdAt:previous?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),sensorId,samplingMinutes:minutes,samples};
}
