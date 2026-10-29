import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { SECRET_ALPHABET, SECRET_LENGTH } from '../shared/protocol.js';

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function randomSessionId() {
  return String(randomInt(100_000_000, 1_000_000_000));
}

export function randomSecret(length = SECRET_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i++) out += SECRET_ALPHABET[randomInt(SECRET_ALPHABET.length)];
  return out;
}

// Segredos e tokens nunca ficam guardados em claro: só o hash SHA-256.
// São valores aleatórios de alta entropia, então um hash rápido é adequado (não são senhas humanas).
export function hashValue(value) {
  return createHash('sha256').update(String(value)).digest();
}

export function safeEqualHash(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && timingSafeEqual(a, b);
}
