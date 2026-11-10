// Cofre do "Acessar computador sem supervisão" (processo principal do app).
//
// - Desativado por padrão. A senha é definida pela pessoa e vale só para este computador.
// - A senha nunca é guardada: guardamos K = scrypt(senha, salt aleatório, N=2^17, r=8, p=1),
//   com parâmetros versionados. O arquivo inteiro é cifrado pelo cofre do sistema (safeStorage).
// - A autenticação é por desafio-resposta: quem conecta prova que conhece a senha sem enviá-la,
//   com HMAC(K, ID do computador | nonce | ID do dispositivo | impressões digitais DTLS).
// - Força bruta: atraso progressivo por dispositivo, bloqueio de 15 min após 5 falhas seguidas e
//   bloqueio até desbloqueio local após 20 falhas em 24 h.
// - Log de segurança local sem senhas, chaves, tela ou arquivos.

import {
  createHash, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, scrypt as scryptCb, sign,
  timingSafeEqual,
} from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deviceIdFromDigest, registrationPayload } from '../shared/device-identity.js';
import { checkPassword } from '../shared/password-policy.js';
import { normalizePermissions } from '../shared/permissions.js';

const scrypt = promisify(scryptCb);

export const DEFAULT_KDF = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });
const KEY_LEN = 32;
const CHALLENGE_TTL_MS = 60_000;
export const LOCKOUT = Object.freeze({
  consecutiveLimit: 5, // falhas seguidas -> bloqueio temporário
  tempLockMs: 15 * 60_000,
  dailyLimit: 20, // falhas em 24 h -> bloqueio até desbloqueio local
  maxDelaySec: 60,
});
const FILE = 'unattended.json';
const LOG_FILE = 'security-log.jsonl';
const MAX_DEVICES = 20;

const maxmemFor = ({ N, r, p }) => 256 * N * r * p + 32 * 1024 * 1024;

export function deriveKey(password, salt, kdf) {
  return scrypt(String(password).normalize('NFKC'), Buffer.from(salt, 'base64'), KEY_LEN, { ...kdf, maxmem: maxmemFor(kdf) });
}

export function proofMac(key, { deviceId, nonce, techId, binding }) {
  return createHmac('sha256', key).update(`ponte-unattended-v1|${deviceId}|${nonce}|${techId}|${binding}`).digest('base64');
}

// Atraso exigido antes da próxima tentativa de um dispositivo com `count` falhas seguidas.
export function delaySeconds(count) {
  return count <= 0 ? 0 : Math.min(2 ** (count - 1), LOCKOUT.maxDelaySec);
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * `protect`/`unprotect`: cifram o conteúdo com o cofre do sistema (safeStorage). Se o cofre não
 * existir, `protection` = 'file' e a interface avisa que só as permissões do arquivo protegem.
 */
export class UnattendedStore {
  #dir;
  #protect;
  #unprotect;
  #now;
  #kdf;
  #state = null; // null = desativado
  #challenges = new Map();

  constructor({ dir, protect = (s) => s, unprotect = (s) => s, protection = 'file', now = Date.now, kdf = DEFAULT_KDF }) {
    this.#dir = dir;
    this.#protect = protect;
    this.#unprotect = unprotect;
    this.protection = protection;
    this.#now = now;
    this.#kdf = kdf;
  }

  get enabled() {
    return Boolean(this.#state);
  }

  // Resumo seguro para a interface (sem chaves, salt ou K).
  get summary() {
    const s = this.#state;
    if (!s) return { enabled: false, protection: this.protection };
    return {
      enabled: true,
      protection: this.protection,
      deviceId: s.deviceId,
      deviceName: s.deviceName,
      allowNewDevices: s.allowNewDevices,
      permissions: { ...s.permissions },
      devices: s.devices.map(({ id, name, addedAt, lastUsedAt }) => ({ id, name, addedAt, lastUsedAt })),
      lockedUntil: s.lockout.lockedUntil,
      hardLocked: s.lockout.lockedUntil === -1,
      enabledAt: s.enabledAt,
    };
  }

  get deviceId() {
    return this.#state?.deviceId ?? null;
  }

  get publicKey() {
    return this.#state?.publicKey ?? null;
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(join(this.#dir, FILE), 'utf8'));
      if (raw?.v !== 1 || typeof raw.data !== 'string') throw new Error('formato');
      this.#state = JSON.parse(this.#unprotect(raw.data));
    } catch {
      this.#state = null;
    }
    return this.enabled;
  }

  async #save() {
    await mkdir(this.#dir, { recursive: true });
    const tmp = join(this.#dir, `${FILE}.tmp`);
    await writeFile(tmp, JSON.stringify({ v: 1, data: this.#protect(JSON.stringify(this.#state)) }), { mode: 0o600 });
    await rename(tmp, join(this.#dir, FILE));
  }

  async log(event, fields = {}) {
    // Só metadados: nunca senha, K, salt, chaves, tela ou arquivos.
    const entry = { ts: new Date(this.#now()).toISOString(), event, ...fields };
    await mkdir(this.#dir, { recursive: true });
    await appendFile(join(this.#dir, LOG_FILE), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  async readLog(limit = 50) {
    try {
      const lines = (await readFile(join(this.#dir, LOG_FILE), 'utf8')).trim().split('\n').filter(Boolean);
      return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  async #newSecret(password) {
    const policy = checkPassword(password);
    if (!policy.ok) return { ok: false, error: 'weak_password', problems: policy.problems };
    const salt = randomBytes(16).toString('base64');
    const key = (await deriveKey(password, salt, this.#kdf)).toString('base64');
    return { ok: true, secret: { salt, kdf: { ...this.#kdf }, key } };
  }

  async enable({ password, deviceName = '', permissions }) {
    if (this.enabled) return { ok: false, error: 'already_enabled' };
    const secret = await this.#newSecret(password);
    if (!secret.ok) return secret;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const perms = normalizePermissions(permissions);
    perms.view = true; // sem ver a tela o acesso não faz sentido
    this.#state = {
      v: 1,
      deviceId: deviceIdFromDigest(createHash('sha256').update(Buffer.from(pub, 'base64')).digest()),
      deviceName: String(deviceName).slice(0, 64),
      publicKey: pub,
      privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
      ...secret.secret,
      permissions: perms,
      allowNewDevices: true,
      devices: [],
      lockout: { consecutive: 0, lockedUntil: 0, failures: [], perDevice: {} },
      enabledAt: this.#now(),
    };
    await this.#save();
    await this.log('enabled', { deviceId: this.#state.deviceId });
    return { ok: true, summary: this.summary };
  }

  async changePassword(password) {
    if (!this.enabled) return { ok: false, error: 'not_enabled' };
    const secret = await this.#newSecret(password);
    if (!secret.ok) return secret;
    Object.assign(this.#state, secret.secret);
    // Senha nova: todos os dispositivos precisam autenticar de novo.
    this.#state.devices = [];
    this.#state.lockout = { consecutive: 0, lockedUntil: 0, failures: [], perDevice: {} };
    await this.#save();
    await this.log('password_changed');
    return { ok: true, summary: this.summary };
  }

  async disable() {
    if (!this.enabled) return { ok: true };
    const { deviceId } = this.#state;
    this.#state = null;
    this.#challenges.clear();
    await rm(join(this.#dir, FILE), { force: true });
    await this.log('disabled', { deviceId });
    return { ok: true };
  }

  async update({ allowNewDevices, permissions, deviceName }) {
    if (!this.enabled) return { ok: false, error: 'not_enabled' };
    if (typeof allowNewDevices === 'boolean') this.#state.allowNewDevices = allowNewDevices;
    if (permissions) {
      const perms = normalizePermissions(permissions);
      perms.view = true;
      this.#state.permissions = perms;
    }
    if (typeof deviceName === 'string') this.#state.deviceName = deviceName.slice(0, 64);
    await this.#save();
    await this.log('settings_changed', { allowNewDevices: this.#state.allowNewDevices });
    return { ok: true, summary: this.summary };
  }

  async revokeDevice(techId) {
    if (!this.enabled) return { ok: false, error: 'not_enabled' };
    const device = this.#state.devices.find((d) => d.id === techId);
    if (!device) return { ok: false, error: 'not_found' };
    this.#state.devices = this.#state.devices.filter((d) => d.id !== techId);
    await this.#save();
    await this.log('device_revoked', { techId, techName: device.name });
    return { ok: true, summary: this.summary };
  }

  async unlock() {
    if (!this.enabled) return { ok: false, error: 'not_enabled' };
    this.#state.lockout = { consecutive: 0, lockedUntil: 0, failures: [], perDevice: {} };
    await this.#save();
    await this.log('unlocked_locally');
    return { ok: true, summary: this.summary };
  }

  signRegistration(nonce) {
    if (!this.enabled) return null;
    const key = createPrivateKey(this.#state.privateKey);
    return sign(null, Buffer.from(registrationPayload(nonce, this.#state.deviceId)), key).toString('base64');
  }

  createChallenge() {
    if (!this.enabled) return null;
    const t = this.#now();
    for (const [id, c] of this.#challenges) if (c.expiresAt <= t) this.#challenges.delete(id);
    const challenge = {
      id: randomUUID().replaceAll('-', ''),
      salt: this.#state.salt,
      ...this.#state.kdf,
      nonce: randomBytes(24).toString('base64'),
      deviceId: this.#state.deviceId,
    };
    this.#challenges.set(challenge.id, { nonce: challenge.nonce, expiresAt: t + CHALLENGE_TTL_MS });
    return challenge;
  }

  // Verifica a prova do técnico. Devolve { ok, permissions } ou { ok: false, error, retryAfter }.
  async verify({ challengeId, mac, techId, techName = '', binding, ip = '' }) {
    if (!this.enabled) return { ok: false, error: 'not_enabled', retryAfter: 0 };
    const t = this.#now();
    const lock = this.#state.lockout;
    const challenge = this.#challenges.get(challengeId);
    this.#challenges.delete(challengeId); // uso único
    if (!challenge || challenge.expiresAt <= t) return { ok: false, error: 'expired', retryAfter: 0 };

    if (lock.lockedUntil === -1) {
      await this.log('auth_blocked', { reason: 'hard_lock', techId, techName, ip });
      return { ok: false, error: 'locked', retryAfter: 0 };
    }
    if (lock.lockedUntil > t) {
      await this.log('auth_blocked', { reason: 'temp_lock', techId, techName, ip });
      return { ok: false, error: 'locked', retryAfter: Math.ceil((lock.lockedUntil - t) / 1000) };
    }
    const per = lock.perDevice[techId] ?? { count: 0, last: 0 };
    const wait = per.last + delaySeconds(per.count) * 1000 - t;
    if (wait > 0) {
      await this.log('auth_blocked', { reason: 'too_soon', techId, techName, ip });
      return { ok: false, error: 'too_soon', retryAfter: Math.ceil(wait / 1000) };
    }
    const known = this.#state.devices.some((d) => d.id === techId);
    if (!known && !this.#state.allowNewDevices) {
      await this.log('auth_rejected', { reason: 'device_not_allowed', techId, techName, ip });
      return { ok: false, error: 'device_not_allowed', retryAfter: 0 };
    }

    const expected = proofMac(Buffer.from(this.#state.key, 'base64'), {
      deviceId: this.#state.deviceId, nonce: challenge.nonce, techId, binding,
    });
    if (!safeEqual(expected, mac)) {
      lock.consecutive += 1;
      lock.failures = [...lock.failures.filter((f) => f > t - 86_400_000), t];
      lock.perDevice[techId] = { count: per.count + 1, last: t };
      let error = 'wrong_password';
      if (lock.failures.length >= LOCKOUT.dailyLimit) {
        lock.lockedUntil = -1;
        error = 'locked';
      } else if (lock.consecutive >= LOCKOUT.consecutiveLimit) {
        lock.lockedUntil = t + LOCKOUT.tempLockMs;
        lock.consecutive = 0;
        error = 'locked';
      }
      await this.#save();
      await this.log('auth_failed', { techId, techName, ip, consecutive: lock.consecutive, lockedUntil: lock.lockedUntil });
      const retryAfter = error === 'locked'
        ? (lock.lockedUntil === -1 ? 0 : Math.ceil(LOCKOUT.tempLockMs / 1000))
        : delaySeconds(per.count + 1);
      return { ok: false, error, retryAfter };
    }

    lock.consecutive = 0;
    delete lock.perDevice[techId];
    const existing = this.#state.devices.find((d) => d.id === techId);
    if (existing) {
      existing.lastUsedAt = t;
      existing.name = String(techName).slice(0, 64) || existing.name;
    } else {
      this.#state.devices = [...this.#state.devices, { id: techId, name: String(techName).slice(0, 64), addedAt: t, lastUsedAt: t }]
        .slice(-MAX_DEVICES);
    }
    await this.#save();
    await this.log('auth_success', { techId, techName, ip, newDevice: !existing });
    return { ok: true, permissions: { ...this.#state.permissions }, newDevice: !existing };
  }

  isAuthorized(techId) {
    return Boolean(this.#state?.devices.some((d) => d.id === techId));
  }
}

// Lado de quem conecta: calcula a prova a partir da senha digitada (a senha não sai daqui).
export async function computeProof(password, challenge, { techId, binding }) {
  const key = await deriveKey(password, challenge.salt, { N: challenge.N, r: challenge.r, p: challenge.p });
  return proofMac(key, { deviceId: challenge.deviceId, nonce: challenge.nonce, techId, binding });
}
