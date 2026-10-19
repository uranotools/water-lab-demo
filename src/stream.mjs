// Persist text and its replay cursor together. Ignore events at/before that cursor,
// even after their metadata has rolled out of the 200-entry UI log.
function cursor(id) {
  if (typeof id !== 'string') return null;
  const split = id.lastIndexOf(':');
  const sequence = Number(id.slice(split + 1));
  return split > 0 && Number.isSafeInteger(sequence) && sequence > 0 ? { turn: id.slice(0, split), sequence } : null;
}
export function applyExecutionEvent(job, event) {
  const previous = cursor(job.lastEventId), incoming = cursor(event.id);
  if (previous && incoming && previous.turn === incoming.turn && incoming.sequence <= previous.sequence) return false;
  if (event.id && job.events.some(e => e.id === event.id)) return false;
  if (event.turnId) job.turnId = event.turnId;
  if (event.sessionId) job.sessionId = event.sessionId;
  if (event.id) job.lastEventId = event.id;
  job.events.push({ id: event.id, type: event.type, sequence: event.sequence, timestamp: event.timestamp });
  job.events = job.events.slice(-200);
  if (event.type === 'TokenStreamChunk' && typeof event.chunk === 'string') {
    job.liveText = (String(job.liveText || '') + event.chunk).slice(0, 64000);
    job.liveTruncated = job.liveTruncated || job.liveText.length >= 64000;
    job.activity = 'Escribiendo respuesta';
  }
  if (event.type === 'ReasoningStreamChunk') job.activity = 'Analizando las mediciones';
  if (event.type === 'ToolCallStarted') job.activity = 'Consultando herramientas del laboratorio';
  if (event.type === 'ToolCallCompleted') job.activity = 'Evidencia recibida; preparando respuesta';
  if (event.type === 'done') {
    job.state = 'succeeded'; job.response = String(event.response ?? job.liveText ?? '').slice(0, 64000);
    job.activity = 'Respuesta completada'; job.deliveryError = null;
  }
  if (event.type === 'error') {
    job.activity = 'Entrega interrumpida; texto parcial conservado';
    job.deliveryError = 'El stream informó un error. Consulta el estado autoritativo del turno.';
  }
  return true;
}
