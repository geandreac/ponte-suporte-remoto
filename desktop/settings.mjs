// Ajustes do app de computador: qual servidor de sinalização usar.
// Fica em JSON na pasta de dados do usuário; não contém segredos.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILE = 'settings.json';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export const DEFAULT_SETTINGS = Object.freeze({ mode: 'local', serverUrl: '' });

// Aceita só HTTPS (ou HTTP no próprio computador, para desenvolvimento) e guarda apenas a origem.
export function validateSettings(input) {
  const mode = input?.mode === 'remote' ? 'remote' : 'local';
  if (mode === 'local') return { ok: true, value: { mode, serverUrl: '' } };
  const raw = typeof input?.serverUrl === 'string' ? input.serverUrl.trim() : '';
  if (!raw) return { ok: false, error: 'Digite o endereço do servidor.' };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'Endereço inválido. Exemplo: https://suporte.exemplo.com' };
  }
  if (url.username || url.password) return { ok: false, error: 'O endereço não pode conter usuário ou senha.' };
  const isLoopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    return { ok: false, error: 'Use um endereço HTTPS para proteger a conexão.' };
  }
  return { ok: true, value: { mode, serverUrl: url.origin } };
}

export function signalingUrlFor(serverUrl) {
  const url = new URL(serverUrl);
  return `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/ws`;
}

export async function loadSettings(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, FILE), 'utf8'));
    const v = validateSettings(parsed);
    return v.ok ? v.value : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(dir, settings) {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${FILE}.tmp`);
  await writeFile(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(tmp, join(dir, FILE));
}
