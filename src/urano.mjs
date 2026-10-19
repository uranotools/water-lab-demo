export const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
export async function readSSE(body, onEvent) {
  const decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
    if (buffer.length > 1024 * 1024) throw new Error('Frame SSE demasiado grande');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const lines = frame.split('\n'), data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      const event = JSON.parse(data);
      await onEvent({ ...event, type: event.type || lines.find(l => l.startsWith('event:'))?.slice(6).trim(), id: event.id || lines.find(l => l.startsWith('id:'))?.slice(3).trim() });
    }
  }
}
export function normalizeWebhookUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new Error('Introduce una URL completa de webhook HTTP o HTTPS.'); }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash) throw new Error('Usa una URL HTTP/HTTPS sin credenciales, parámetros ni fragmentos. El token se configura en el servidor.');
  return u.href.replace(/\/$/, '');
}
export class Urano {
  constructor({ url, token, fetchImpl = fetch }) {
    this.url = normalizeWebhookUrl(url); this.token = token; this.fetch = fetchImpl;
  }
  headers(extra = {}) { return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}`, 'X-Urano-Protocol-Version': '1', ...extra }; }
  async discover() {
    const res = await this.fetch(this.url, { headers: this.headers(), signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!res.ok) throw new Error(`Discovery HTTP ${res.status}`);
    return res.json();
  }
  async deliver(job, { action, onHeaders, onEvent }) {
    const url = new URL(this.url);
    if (!action) url.searchParams.set('mode', job.transport);
    const payload = action ? { webhookAction: action, turnId: job.turnId } : job.payload;
    const headers = this.headers(action ? (action === 'events' && job.lastEventId ? { 'Last-Event-ID': job.lastEventId } : {}) : { 'Idempotency-Key': job.idempotencyKey });
    const res = await this.fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(action === 'events' || !action ? 310000 : 10000) });
    await onHeaders?.({ turnId: res.headers.get('x-urano-turn-id'), sessionId: res.headers.get('x-urano-session-id'), requestId: res.headers.get('x-request-id') });
    if (!res.ok) { const text = await res.text(); throw new Error(`Urano HTTP ${res.status}: ${text.slice(0, 1000)}`); }
    if (res.headers.get('content-type')?.includes('text/event-stream')) { await readSSE(res.body, onEvent); return null; }
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { acknowledgement: text }; }
  }
}
