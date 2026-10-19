import { existsSync, writeFileSync,readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const path = new URL('../.env', import.meta.url);
if (existsSync(path)) {
  if(!/^SENSOR_INGEST_TOKEN=.+$/m.test(readFileSync(path,'utf8'))){const current=readFileSync(path,'utf8'),line=`SENSOR_INGEST_TOKEN=${randomBytes(32).toString('hex')}`;writeFileSync(path,/^SENSOR_INGEST_TOKEN=.*$/m.test(current)?current.replace(/^SENSOR_INGEST_TOKEN=.*$/m,line):current+`\n${line}\n`);console.log('Token del receptor de sensores añadido. Credenciales existentes conservadas.');}
  else console.log('.env ya existe; se conserva.');
}
else {
  writeFileSync(path, `PORT=3020\nURANO_URL=http://127.0.0.1:6274/v1/webhook/mcp_water-lab/default\nURANO_TOKEN=${randomBytes(32).toString('hex')}\nLAB_API_TOKEN=${randomBytes(32).toString('hex')}\nSENSOR_INGEST_TOKEN=${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  console.log('.env creado. Copia URANO_TOKEN a INCOMING_WEBHOOK_SECRET y LAB_API_TOKEN al Vault de water-lab.');
}
