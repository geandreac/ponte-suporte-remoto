// Validação das mensagens de sinalização (cliente -> servidor) e do canal de dados (cliente <-> cliente).
// Toda entrada externa passa por aqui antes de ser usada.

import { normalizeCapabilities, normalizePermissions, PERMISSIONS } from './permissions.js';

export const LIMITS = Object.freeze({
  name: 64,
  sdp: 32_000,
  candidate: 2_048,
  chat: 2_000,
  fileName: 255,
  mime: 127,
  token: 128,
  dataMessage: 64 * 1024,
});

export const SECRET_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const SECRET_LENGTH = 8;
export const SESSION_ID_PATTERN = /^\d{9}$/;
export const SECRET_PATTERN = /^[2-9A-HJKMNP-Z]{8}$/;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const END_REASONS_FROM_HOST = new Set(['revoked', 'disabled', 'auth_failed', 'auth_timeout', 'policy_violation']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });

// Remove caracteres de controle e de direção de texto (evita nomes que se disfarçam na tela).
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

export function sanitizeName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name);
}

export function normalizeSessionId(value) {
  return typeof value === 'string' ? value.replace(/[\s.-]/g, '') : '';
}

export function normalizeSecret(value) {
  return typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : '';
}

export function formatSessionId(id) {
  return String(id).replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
}

export function formatSecret(secret) {
  return String(secret).replace(/^(.{4})(.{4})$/, '$1-$2');
}

function validateSignalPayload(p) {
  if (!isObject(p)) return fail('invalid_signal');
  if (p.kind === 'offer' || p.kind === 'answer') {
    if (typeof p.sdp !== 'string' || p.sdp.length === 0 || p.sdp.length > LIMITS.sdp) return fail('invalid_signal');
    return ok({ kind: p.kind, sdp: p.sdp });
  }
  if (p.kind === 'ice') {
    if (p.candidate === null) return ok({ kind: 'ice', candidate: null });
    const c = p.candidate;
    if (!isObject(c) || typeof c.candidate !== 'string' || c.candidate.length > LIMITS.candidate) return fail('invalid_signal');
    const out = { candidate: c.candidate };
    if (typeof c.sdpMid === 'string' && c.sdpMid.length <= 32) out.sdpMid = c.sdpMid;
    if (Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 64) out.sdpMLineIndex = c.sdpMLineIndex;
    if (typeof c.usernameFragment === 'string' && c.usernameFragment.length <= 256) out.usernameFragment = c.usernameFragment;
    return ok({ kind: 'ice', candidate: out });
  }
  return fail('invalid_signal');
}

const hasAny = (perms) => PERMISSIONS.some((p) => perms[p]);

export function validateClientMessage(msg) {
  if (!isObject(msg) || typeof msg.type !== 'string') return fail('invalid_message');
  const { type } = msg;
  switch (type) {
    case 'host:create':
      return ok({ type, name: sanitizeName(msg.name ?? ''), capabilities: normalizeCapabilities(msg.capabilities) });

    case 'tech:join': {
      const sessionId = normalizeSessionId(msg.sessionId);
      const secret = normalizeSecret(msg.secret);
      const name = sanitizeName(msg.name);
      const requested = normalizePermissions(msg.requested);
      if (!SESSION_ID_PATTERN.test(sessionId) || !SECRET_PATTERN.test(secret)) return fail('invalid_credentials');
      if (!name) return fail('invalid_name');
      if (!hasAny(requested)) return fail('no_permissions_requested');
      return ok({ type, sessionId, secret, name, requested });
    }

    case 'host:respond':
      if (typeof msg.requestId !== 'string' || !ID_PATTERN.test(msg.requestId)) return fail('invalid_request_id');
      if (typeof msg.accept !== 'boolean') return fail('invalid_message');
      return ok({ type, requestId: msg.requestId, accept: msg.accept, granted: normalizePermissions(msg.granted) });

    case 'signal': {
      const payload = validateSignalPayload(msg.payload);
      return payload.ok ? ok({ type, payload: payload.value }) : payload;
    }

    case 'permissions:update':
      return ok({ type, granted: normalizePermissions(msg.granted) });

    case 'permissions:request': {
      const requested = normalizePermissions(msg.requested);
      return hasAny(requested) ? ok({ type, requested }) : fail('no_permissions_requested');
    }

    case 'session:end':
      // Motivo opcional, só de uma lista fechada (mostrado ao outro lado).
      return ok({ type, reason: END_REASONS_FROM_HOST.has(msg.reason) ? msg.reason : null });
    case 'keepalive':
      return ok({ type });

    case 'device:register': {
      const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
      if (typeof msg.deviceId !== 'string' || !SESSION_ID_PATTERN.test(msg.deviceId)) return fail('invalid_device');
      if (typeof msg.publicKey !== 'string' || msg.publicKey.length > 200 || !b64.test(msg.publicKey)) return fail('invalid_device');
      if (typeof msg.signature !== 'string' || msg.signature.length > 200 || !b64.test(msg.signature)) return fail('invalid_device');
      return ok({
        type, deviceId: msg.deviceId, publicKey: msg.publicKey, signature: msg.signature,
        name: sanitizeName(msg.name ?? ''), capabilities: normalizeCapabilities(msg.capabilities),
      });
    }

    case 'unattended:connect': {
      const deviceId = normalizeSessionId(msg.deviceId);
      const name = sanitizeName(msg.name);
      const requested = normalizePermissions(msg.requested);
      if (!SESSION_ID_PATTERN.test(deviceId)) return fail('invalid_device');
      if (!name) return fail('invalid_name');
      if (!hasAny(requested)) return fail('no_permissions_requested');
      return ok({ type, deviceId, name, requested });
    }

    case 'session:resume': {
      const sessionId = normalizeSessionId(msg.sessionId);
      if (!SESSION_ID_PATTERN.test(sessionId) || typeof msg.token !== 'string' || !TOKEN_PATTERN.test(msg.token)) {
        return fail('invalid_session');
      }
      return ok({ type, sessionId, token: msg.token });
    }

    default:
      return fail('unknown_type');
  }
}

const INPUT_KINDS = new Set(['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup']);
const isUnit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

function validateInput(msg) {
  if (!INPUT_KINDS.has(msg.kind)) return fail('invalid_input');
  const mods = {
    alt: msg.alt === true, ctrl: msg.ctrl === true, shift: msg.shift === true, meta: msg.meta === true,
  };
  if (msg.kind.startsWith('key')) {
    if (typeof msg.code !== 'string' || msg.code.length === 0 || msg.code.length > 32) return fail('invalid_input');
    const key = typeof msg.key === 'string' ? msg.key.slice(0, 32) : '';
    return ok({ type: 'input', kind: msg.kind, code: msg.code, key, ...mods });
  }
  if (!isUnit(msg.x) || !isUnit(msg.y)) return fail('invalid_input');
  const out = { type: 'input', kind: msg.kind, x: msg.x, y: msg.y, ...mods };
  if (msg.kind === 'wheel') {
    if (typeof msg.deltaY !== 'number' || !Number.isFinite(msg.deltaY) || Math.abs(msg.deltaY) > 10_000) return fail('invalid_input');
    out.deltaY = msg.deltaY;
  }
  if (msg.kind === 'pointerdown' || msg.kind === 'pointerup') {
    if (!Number.isInteger(msg.button) || msg.button < 0 || msg.button > 2) return fail('invalid_input');
    out.button = msg.button;
  }
  return ok(out);
}

export function validateDataMessage(msg) {
  if (!isObject(msg) || typeof msg.type !== 'string') return fail('invalid_message');
  const { type } = msg;
  const validId = typeof msg.id === 'string' && ID_PATTERN.test(msg.id);
  switch (type) {
    case 'chat': {
      if (!validId || typeof msg.text !== 'string') return fail('invalid_message');
      const text = msg.text.trim();
      if (!text || text.length > LIMITS.chat) return fail('invalid_message');
      return ok({ type, id: msg.id, text });
    }
    case 'share-state':
      return typeof msg.paused === 'boolean'
        ? ok({ type, paused: msg.paused, captureActive: msg.captureActive === true, controlActive: msg.controlActive === true })
        : fail('invalid_message');
    case 'recording-state':
      return typeof msg.active === 'boolean' ? ok({ type, active: msg.active }) : fail('invalid_message');
    case 'file-offer': {
      if (!validId || typeof msg.name !== 'string' || msg.name.length > LIMITS.fileName) return fail('invalid_message');
      if (!Number.isSafeInteger(msg.size) || msg.size < 0) return fail('invalid_message');
      if (typeof msg.mime !== 'string' || msg.mime.length > LIMITS.mime) return fail('invalid_message');
      if (typeof msg.sha256 !== 'string' || !SHA256_PATTERN.test(msg.sha256)) return fail('invalid_message');
      return ok({ type, id: msg.id, name: msg.name, size: msg.size, mime: msg.mime, sha256: msg.sha256 });
    }
    case 'file-response':
      if (!validId || typeof msg.accept !== 'boolean') return fail('invalid_message');
      return ok({ type, id: msg.id, accept: msg.accept, reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 64) : '' });
    case 'file-complete':
    case 'file-cancel':
      return validId ? ok({ type, id: msg.id }) : fail('invalid_message');
    case 'input':
      return validateInput(msg);
    // Autenticação do acesso sem supervisão (ver docs/ACESSO-SEM-SUPERVISAO.md).
    case 'auth-challenge': {
      const b64 = /^[A-Za-z0-9+/]{16,88}={0,2}$/;
      const pow2 = Number.isInteger(msg.N) && msg.N >= 2 ** 14 && msg.N <= 2 ** 18 && (msg.N & (msg.N - 1)) === 0;
      if (!validId || !pow2 || !Number.isInteger(msg.r) || msg.r < 1 || msg.r > 16
        || !Number.isInteger(msg.p) || msg.p < 1 || msg.p > 4
        || typeof msg.salt !== 'string' || !b64.test(msg.salt) || typeof msg.nonce !== 'string' || !b64.test(msg.nonce)
        || typeof msg.deviceId !== 'string' || !SESSION_ID_PATTERN.test(msg.deviceId)) return fail('invalid_message');
      return ok({ type, id: msg.id, salt: msg.salt, N: msg.N, r: msg.r, p: msg.p, nonce: msg.nonce, deviceId: msg.deviceId });
    }
    case 'auth-response':
      if (!validId || typeof msg.mac !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(msg.mac)
        || typeof msg.techId !== 'string' || !ID_PATTERN.test(msg.techId)) return fail('invalid_message');
      return ok({ type, id: msg.id, mac: msg.mac, techId: msg.techId });
    case 'auth-result':
      if (!validId || typeof msg.ok !== 'boolean') return fail('invalid_message');
      return ok({
        type, id: msg.id, ok: msg.ok,
        error: typeof msg.error === 'string' ? msg.error.slice(0, 40) : '',
        retryAfter: Number.isInteger(msg.retryAfter) && msg.retryAfter >= 0 ? Math.min(msg.retryAfter, 86_400) : 0,
      });
    default:
      return fail('unknown_type');
  }
}
