// Modelo de permissões da sessão. Usado pelo servidor (normalização e auditoria)
// e pelos clientes (aplicação efetiva das regras no lado de quem compartilha).

export const PERMISSIONS = Object.freeze(['view', 'control', 'files', 'chat', 'record']);

export const PERMISSION_LABELS = Object.freeze({
  view: 'Ver a tela',
  control: 'Controlar teclado e mouse',
  files: 'Transferir arquivos',
  chat: 'Chat',
  record: 'Gravar a sessão',
});

export const PERMISSION_HINTS = Object.freeze({
  view: 'A pessoa vê a tela, janela ou aba que você escolher.',
  control: 'Exige o agente nativo instalado no dispositivo. Indisponível na versão web.',
  files: 'Cada arquivo ainda precisa ser aceito por quem recebe.',
  chat: 'Mensagens de texto durante a sessão.',
  record: 'A gravação fica no dispositivo de quem presta suporte. Exige "Ver a tela".',
});

export function emptyPermissions() {
  return Object.fromEntries(PERMISSIONS.map((p) => [p, false]));
}

// Aceita somente chaves conhecidas com valor booleano `true`. Qualquer outra coisa vira `false`.
export function normalizePermissions(input) {
  const out = emptyPermissions();
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out;
  // Só propriedades próprias: valores herdados via protótipo não concedem nada.
  for (const p of PERMISSIONS) out[p] = Object.hasOwn(input, p) && input[p] === true;
  return out;
}

export function normalizeCapabilities(input) {
  const own = (k) => input !== null && typeof input === 'object' && Object.hasOwn(input, k) && input[k] === true;
  return { screenCapture: own('screenCapture'), inputInjection: own('inputInjection') };
}

export function capabilityAllows(permission, capabilities) {
  const caps = normalizeCapabilities(capabilities);
  if (permission === 'view' || permission === 'record') return caps.screenCapture;
  if (permission === 'control') return caps.inputInjection;
  return true;
}

// Menor privilégio: uma permissão só vale se foi pedida, concedida e o dispositivo suporta.
// Dependências: gravar e controlar só fazem sentido vendo a tela.
export function resolveGrant({ requested, granted, capabilities }) {
  const r = normalizePermissions(requested);
  const g = normalizePermissions(granted);
  const out = emptyPermissions();
  for (const p of PERMISSIONS) out[p] = r[p] && g[p] && capabilityAllows(p, capabilities);
  if (!out.view) {
    out.record = false;
    out.control = false;
  }
  return out;
}

export function mergeRequested(current, extra) {
  const a = normalizePermissions(current);
  const b = normalizePermissions(extra);
  return Object.fromEntries(PERMISSIONS.map((p) => [p, a[p] || b[p]]));
}

export function listGranted(perms) {
  const n = normalizePermissions(perms);
  return PERMISSIONS.filter((p) => n[p]);
}

export function diffPermissions(before, after) {
  const a = normalizePermissions(before);
  const b = normalizePermissions(after);
  return {
    granted: PERMISSIONS.filter((p) => !a[p] && b[p]),
    revoked: PERMISSIONS.filter((p) => a[p] && !b[p]),
  };
}

// Quais mensagens do canal de dados cada lado aceita, e qual permissão exige.
// `null` = sempre aceita (avisos de estado e cancelamentos); ausente = nunca aceita.
const INCOMING_RULES = {
  host: {
    chat: 'chat',
    'file-offer': 'files',
    'file-response': 'files',
    'file-complete': 'files',
    'file-cancel': null,
    'recording-state': null,
    input: 'control',
    'auth-response': null,
  },
  viewer: {
    chat: 'chat',
    'file-offer': 'files',
    'file-response': 'files',
    'file-complete': 'files',
    'file-cancel': null,
    'share-state': null,
    'auth-challenge': null,
    'auth-result': null,
  },
};

export function authorizeIncoming(role, type, granted) {
  const rules = INCOMING_RULES[role];
  if (!rules || !Object.hasOwn(rules, type)) return { allowed: false, reason: 'not_expected' };
  const needed = rules[type];
  if (needed === null) return { allowed: true };
  return normalizePermissions(granted)[needed]
    ? { allowed: true }
    : { allowed: false, reason: 'not_permitted', permission: needed };
}
