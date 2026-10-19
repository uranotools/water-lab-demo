import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
export const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
export class Store {
  constructor(root) { this.root = root; mkdirSync(root, { recursive: true }); }
  path(type, id) { if (!['run', 'job', 'sensor'].includes(type) || !validId(id)) throw new Error('ID inválido'); return join(this.root, `${type}-${id}.json`); }
  save(type, obj) { const file = this.path(type, obj.id); writeFileSync(`${file}.tmp`, JSON.stringify(obj)); renameSync(`${file}.tmp`, file); return obj; }
  get(type, id) { const file = this.path(type, id); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; }
  list(type) { return readdirSync(this.root).filter(f => f.startsWith(`${type}-`) && f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(this.root, f), 'utf8'))).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
}
