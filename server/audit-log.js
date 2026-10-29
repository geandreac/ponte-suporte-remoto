// Log de auditoria em JSON por linha. Registra eventos (quem, quando, o quê), nunca conteúdo:
// segredos, tokens, SDP, candidatos ICE, mensagens de chat ou dados de arquivo são mascarados.

import { createWriteStream } from 'node:fs';

const SENSITIVE_KEY = /secret|token|password|credential|sdp|candidate|text|content|payload|data|key|cookie|authorization/i;

export function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export function createAuditLog({ write, now = Date.now, file } = {}) {
  let sink = write;
  let stream = null;
  if (!sink && file) {
    stream = createWriteStream(file, { flags: 'a', mode: 0o600 });
    sink = (line) => stream.write(`${line}\n`);
  }
  sink ??= (line) => process.stdout.write(`${line}\n`);

  return {
    log(event, fields = {}) {
      sink(JSON.stringify({ ts: new Date(now()).toISOString(), event, ...redact(fields) }));
    },
    close() {
      stream?.end();
    },
  };
}
