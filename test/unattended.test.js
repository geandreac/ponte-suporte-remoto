import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { computeProof, delaySeconds, LOCKOUT, UnattendedStore } from '../desktop/unattended.mjs';
import { deviceIdForPublicKey } from '../server/device-identity.js';
import { registrationPayload } from '../shared/device-identity.js';
import { checkPassword } from '../shared/password-policy.js';

const PASSWORD = 'Casa-Rio#2026!azul';
const KDF = { N: 2 ** 14, r: 8, p: 1 }; // mais leve só para os testes (produção: 2^17)
const BINDING = 'sha-256 AA|sha-256 BB';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ponte-unatt-'));
  let t = 1_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  // "Cofre do sistema" de teste: inverte o texto (só para provar que o arquivo passa por ele).
  const store = new UnattendedStore({
    dir, now: clock.now, kdf: KDF, protection: 'system',
    protect: (s) => Buffer.from(s).toString('base64'), unprotect: (s) => Buffer.from(s, 'base64').toString(),
  });
  return { dir, store, clock, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function attempt(store, password, techId = 'tec-trabalho', binding = BINDING) {
  const challenge = store.createChallenge();
  const mac = await computeProof(password, challenge, { techId, binding });
  return store.verify({ challengeId: challenge.id, mac, techId, techName: 'Notebook do trabalho', binding, ip: '203.0.113.9' });
}

test('desativado por padrão; ativar exige senha forte e nunca guarda a senha', async () => {
  const { dir, store, cleanup } = setup();
  try {
    assert.equal(await store.load(), false);
    assert.equal(store.summary.enabled, false);
    assert.equal((await store.enable({ password: '12345678' })).error, 'weak_password');
    const r = await store.enable({ password: PASSWORD, deviceName: 'PC de casa', permissions: { control: true, record: true } });
    assert.equal(r.ok, true);
    assert.match(store.summary.deviceId, /^[1-9]\d{8}$/);
    assert.equal(store.summary.allowNewDevices, true);
    assert.equal(store.summary.permissions.view, true, 'ver a tela sempre incluído');
    const raw = readFileSync(join(dir, 'unattended.json'), 'utf8');
    const log = readFileSync(join(dir, 'security-log.jsonl'), 'utf8');
    for (const text of [raw, Buffer.from(JSON.parse(raw).data, 'base64').toString(), log]) {
      assert.ok(!text.includes(PASSWORD), 'senha em texto puro');
    }
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'unattended.json')).mode & 0o777, 0o600);
    // Recarrega do disco (como ao reabrir o app).
    const again = new UnattendedStore({ dir, kdf: KDF, unprotect: (s) => Buffer.from(s, 'base64').toString() });
    assert.equal(await again.load(), true);
    assert.equal(again.deviceId, store.deviceId);
  } finally {
    cleanup();
  }
});

test('ID do computador deriva da chave e a assinatura de registro confere', async () => {
  const { store, cleanup } = setup();
  try {
    await store.enable({ password: PASSWORD });
    assert.equal(deviceIdForPublicKey(store.publicKey), store.deviceId);
    const sig = store.signRegistration('desafio-123');
    const key = createPublicKey({ key: Buffer.from(store.publicKey, 'base64'), format: 'der', type: 'spki' });
    assert.equal(verify(null, Buffer.from(registrationPayload('desafio-123', store.deviceId)), key, Buffer.from(sig, 'base64')), true);
  } finally {
    cleanup();
  }
});

test('senha certa autentica e registra o dispositivo; prova presa às impressões digitais e ao desafio', async () => {
  const { store, cleanup } = setup();
  try {
    await store.enable({ password: PASSWORD, permissions: { control: true } });
    const ok = await attempt(store, PASSWORD);
    assert.equal(ok.ok, true);
    assert.equal(ok.newDevice, true);
    assert.equal(ok.permissions.control, true);
    assert.equal(store.summary.devices[0].name, 'Notebook do trabalho');

    // Desafio é de uso único: reapresentar a mesma prova falha.
    const challenge = store.createChallenge();
    const mac = await computeProof(PASSWORD, challenge, { techId: 'tec-trabalho', binding: BINDING });
    assert.equal((await store.verify({ challengeId: challenge.id, mac, techId: 'tec-trabalho', binding: BINDING })).ok, true);
    assert.equal((await store.verify({ challengeId: challenge.id, mac, techId: 'tec-trabalho', binding: BINDING })).error, 'expired');

    // Prova calculada para outras impressões digitais (intermediário) não vale.
    const c2 = store.createChallenge();
    const mitm = await computeProof(PASSWORD, c2, { techId: 'tec-trabalho', binding: 'sha-256 XX|sha-256 YY' });
    assert.equal((await store.verify({ challengeId: c2.id, mac: mitm, techId: 'tec-trabalho', binding: BINDING })).ok, false);
  } finally {
    cleanup();
  }
});

test('força bruta: atraso progressivo, bloqueio temporário e bloqueio até desbloqueio local', async () => {
  const { store, clock, cleanup } = setup();
  try {
    await store.enable({ password: PASSWORD });
    const r1 = await attempt(store, 'Senha-Errada#2026');
    assert.deepEqual([r1.ok, r1.error, r1.retryAfter], [false, 'wrong_password', 1]);
    // Tentar de novo antes do atraso: recusado sem nem testar a senha (mesmo que esteja certa).
    const early = await attempt(store, PASSWORD);
    assert.deepEqual([early.ok, early.error], [false, 'too_soon']);
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(delaySeconds), [1, 2, 4, 8, 16, 32, 60, 60]);

    for (let i = 2; i <= LOCKOUT.consecutiveLimit; i++) {
      clock.advance(61_000);
      await attempt(store, `Errada-${i}#Senha!x`);
    }
    assert.ok(store.summary.lockedUntil > clock.now(), 'bloqueio temporário após 5 falhas');
    clock.advance(61_000);
    const locked = await attempt(store, PASSWORD, 'outro-dispositivo');
    assert.deepEqual([locked.ok, locked.error], [false, 'locked'], 'bloqueio vale para todos os dispositivos');

    // Até 20 falhas em 24 h: bloqueio permanente até alguém desbloquear no próprio computador.
    for (let i = 0; i < LOCKOUT.dailyLimit; i++) {
      clock.advance(16 * 60_000);
      await attempt(store, `Outra-Errada-${i}#x`, `disp-${i}`);
    }
    assert.equal(store.summary.hardLocked, true);
    clock.advance(10 * 3_600_000);
    assert.equal((await attempt(store, PASSWORD)).error, 'locked');
    await store.unlock();
    clock.advance(61_000);
    assert.equal((await attempt(store, PASSWORD)).ok, true);
    const events = (await store.readLog(200)).map((e) => e.event);
    for (const e of ['auth_failed', 'auth_blocked', 'unlocked_locally', 'auth_success']) assert.ok(events.includes(e), e);
  } finally {
    cleanup();
  }
});

test('novos dispositivos podem ser bloqueados; revogar e trocar a senha invalidam acessos', async () => {
  const { store, clock, cleanup } = setup();
  try {
    await store.enable({ password: PASSWORD });
    assert.equal((await attempt(store, PASSWORD, 'notebook')).ok, true);
    await store.update({ allowNewDevices: false });
    assert.equal((await attempt(store, PASSWORD, 'desconhecido')).error, 'device_not_allowed');
    assert.equal((await attempt(store, PASSWORD, 'notebook')).ok, true, 'dispositivo já autorizado segue entrando');

    await store.revokeDevice('notebook');
    assert.equal((await attempt(store, PASSWORD, 'notebook')).error, 'device_not_allowed');

    await store.update({ allowNewDevices: true });
    assert.equal((await store.changePassword('fraca')).error, 'weak_password');
    await store.changePassword('Nova-Senha#Forte2026');
    assert.equal(store.summary.devices.length, 0, 'trocar a senha remove os dispositivos');
    clock.advance(61_000);
    assert.equal((await attempt(store, PASSWORD, 'notebook')).ok, false, 'senha antiga não vale');
    clock.advance(61_000);
    assert.equal((await attempt(store, 'Nova-Senha#Forte2026', 'notebook')).ok, true);

    await store.disable();
    assert.equal(store.enabled, false);
    assert.equal(store.createChallenge(), null);
    const events = (await store.readLog(100)).map((e) => e.event);
    for (const e of ['device_revoked', 'password_changed', 'disabled']) assert.ok(events.includes(e), e);
  } finally {
    cleanup();
  }
});

test('política de senha', () => {
  assert.equal(checkPassword(PASSWORD).ok, true);
  assert.equal(checkPassword('uma frase longa e boa para casa').ok, true, 'frase de 16+ caracteres');
  assert.equal(checkPassword('Curta1!').ok, false);
  assert.equal(checkPassword('123456789012345').ok, false);
  assert.equal(checkPassword('Abcdef123456!').ok, false, 'sequência óbvia');
  assert.equal(checkPassword('aaaaBBBB1111!!').ok, false, 'repetição');
  assert.equal(checkPassword('MinhaPonte#2026').ok, false, 'nome do app');
  assert.equal(checkPassword('somenteminusculas').ok, true, '16+ caracteres');
  assert.equal(checkPassword('minusculas12').ok, false, 'curta e só 2 tipos');
});
