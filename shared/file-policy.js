// Política de transferência de arquivos: lista de tipos permitidos, limite de tamanho,
// nome seguro e checagem da assinatura do conteúdo (não confia só na extensão).

export const MAX_FILE_SIZE = 25 * 1024 * 1024;

// O primeiro MIME de cada lista é o usado ao montar o arquivo recebido.
export const ALLOWED_TYPES = Object.freeze({
  txt: ['text/plain'],
  log: ['text/plain', 'text/x-log'],
  csv: ['text/csv', 'application/vnd.ms-excel'],
  json: ['application/json'],
  md: ['text/markdown', 'text/x-markdown', 'text/plain'],
  pdf: ['application/pdf'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  webp: ['image/webp'],
});

const TEXT_TYPES = new Set(['txt', 'log', 'csv', 'json', 'md']);

export const ACCEPT_ATTRIBUTE = Object.keys(ALLOWED_TYPES).map((e) => `.${e}`).join(',');

export function getExtension(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function sanitizeFileName(name) {
  if (typeof name !== 'string') return '';
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (clean.length <= 255) return clean;
  const ext = getExtension(clean);
  return ext ? `${clean.slice(0, 254 - ext.length)}.${ext}` : clean.slice(0, 255);
}

export function validateFileOffer({ name, size, mime }) {
  const safeName = sanitizeFileName(name);
  if (!safeName) return { ok: false, error: 'invalid_name' };
  const extension = getExtension(safeName);
  const allowed = ALLOWED_TYPES[extension];
  if (!allowed) return { ok: false, error: 'type_not_allowed' };
  if (!Number.isSafeInteger(size) || size <= 0) return { ok: false, error: 'empty_file' };
  if (size > MAX_FILE_SIZE) return { ok: false, error: 'too_large' };
  // Navegadores às vezes não informam MIME (ex.: .log). Vazio é aceito; a assinatura decide.
  const declared = typeof mime === 'string' ? mime.toLowerCase().split(';')[0].trim() : '';
  if (declared && !allowed.includes(declared)) return { ok: false, error: 'mime_mismatch' };
  return { ok: true, value: { name: safeName, extension, mime: allowed[0] } };
}

const startsWith = (bytes, sig, offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

export function verifyFileSignature(extension, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return false;
  switch (extension) {
    case 'pdf': return startsWith(bytes, ascii('%PDF-'));
    case 'png': return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpg':
    case 'jpeg': return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'webp': return startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8);
    default:
      if (!TEXT_TYPES.has(extension)) return false;
      // Texto não deve conter bytes nulos (indício de binário renomeado).
      return !bytes.subarray(0, 8192).includes(0);
  }
}

export const FILE_ERROR_MESSAGES = Object.freeze({
  invalid_name: 'Nome de arquivo inválido.',
  type_not_allowed: `Tipo de arquivo não permitido. Aceitos: ${Object.keys(ALLOWED_TYPES).join(', ')}.`,
  empty_file: 'O arquivo está vazio.',
  too_large: `O arquivo passa do limite de ${MAX_FILE_SIZE / 1024 / 1024} MB.`,
  mime_mismatch: 'O tipo informado não corresponde à extensão do arquivo.',
  content_mismatch: 'O conteúdo do arquivo não corresponde à extensão.',
  integrity: 'O arquivo chegou corrompido (verificação de integridade falhou).',
  not_permitted: 'A transferência de arquivos não está liberada nesta sessão.',
  busy: 'Já existe uma transferência em andamento.',
  rejected: 'A outra pessoa recusou o arquivo.',
  permission_revoked: 'A permissão de arquivos foi revogada.',
  cancelled: 'Transferência cancelada.',
  channel_closed: 'A conexão caiu durante a transferência.',
});
