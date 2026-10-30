import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  codeToKey, createInjector, planKey, toTargetPoint, wheelTicks,
} from '../desktop/input.mjs';
import {
  createResponder, deriveInviteKey, discover, ensureCertificate, isValidAddress, localAddresses, proofFor, verifyProof,
} from '../desktop/lan.mjs';
import { createUpdater, updateMode } from '../desktop/updater.mjs';

/* ---------- Controle remoto ---------- */

function fakeRobot() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    moveMouse: rec('move'), mouseToggle: rec('toggle'), scrollMouse: rec('scroll'),
    typeString: rec('type'), keyTap: rec('tap'),
  };
}

const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 };

test('injeção desligada ou sem alvo não faz nada', () => {
  const robot = fakeRobot();
  const inj = createInjector({ robot });
  assert.equal(inj.handle({ type: 'input', kind: 'pointermove', x: 0.5, y: 0.5 }), false);
  inj.setEnabled(true);
  assert.equal(inj.handle({ type: 'input', kind: 'pointermove', x: 0.5, y: 0.5 }), false, 'sem tela alvo');
  inj.setTarget(SCREEN);
  inj.setEnabled(false);
  assert.equal(inj.handle({ type: 'input', kind: 'pointermove', x: 0.5, y: 0.5 }), false);
  assert.deepEqual(robot.calls, []);
});

test('mouse: coordenadas normalizadas viram pixels da tela compartilhada', () => {
  const robot = fakeRobot();
  const inj = createInjector({ robot });
  inj.setTarget({ x: 1920, y: 0, width: 1280, height: 720 }); // segundo monitor
  inj.setEnabled(true);
  assert.equal(inj.handle({ type: 'input', kind: 'pointermove', x: 0, y: 0 }), true);
  inj.handle({ type: 'input', kind: 'pointerdown', x: 1, y: 1, button: 2 });
  assert.deepEqual(robot.calls, [['move', 1920, 0], ['move', 3199, 719], ['toggle', 'down', 'right']]);
});

test('conversão de pontos lógicos para físicos é aplicada (telas com escala)', () => {
  const robot = fakeRobot();
  const inj = createInjector({ robot, toScreenPoint: (p) => ({ x: p.x * 1.5, y: p.y * 1.5 }) });
  inj.setTarget({ x: 0, y: 0, width: 1001, height: 501 });
  inj.setEnabled(true);
  inj.handle({ type: 'input', kind: 'pointermove', x: 0.5, y: 0.5 });
  assert.deepEqual(robot.calls[0], ['move', 750, 375]);
});

test('desabilitar o controle solta botões pressionados', () => {
  const robot = fakeRobot();
  const inj = createInjector({ robot });
  inj.setTarget(SCREEN);
  inj.setEnabled(true);
  inj.handle({ type: 'input', kind: 'pointerdown', x: 0.1, y: 0.1, button: 0 });
  inj.setEnabled(false);
  assert.deepEqual(robot.calls.at(-1), ['toggle', 'up', 'left']);
});

test('mensagens inválidas são recusadas pelo injetor', () => {
  const robot = fakeRobot();
  const inj = createInjector({ robot });
  inj.setTarget(SCREEN);
  inj.setEnabled(true);
  assert.equal(inj.handle({ type: 'input', kind: 'pointermove', x: 2, y: 0 }), false);
  assert.equal(inj.handle({ type: 'input', kind: 'pointerdown', x: 0, y: 0, button: 7 }), false);
  assert.equal(inj.handle({ type: 'chat', id: 'a', text: 'oi' }), false);
  assert.equal(inj.handle({ type: 'input', kind: 'exec', cmd: 'rm' }), false);
  assert.deepEqual(robot.calls, []);
});

test('teclado: texto pelo caractere (qualquer layout), atalhos pela tecla física', () => {
  const k = (o) => ({ type: 'input', kind: 'keydown', key: '', code: 'KeyA', ...o });
  assert.deepEqual(planKey(k({ key: 'ç', code: 'Semicolon' })), { type: 'text', text: 'ç' });
  assert.deepEqual(planKey(k({ key: 'A', code: 'KeyA', shift: true })), { type: 'text', text: 'A' });
  assert.deepEqual(planKey(k({ key: '/', code: 'KeyQ', ctrl: true, alt: true })), { type: 'text', text: '/' }); // AltGr
  assert.deepEqual(planKey(k({ key: 'c', code: 'KeyC', ctrl: true })), { type: 'tap', key: 'c', modifiers: ['control'] });
  assert.deepEqual(planKey(k({ key: 'ArrowLeft', code: 'ArrowLeft', shift: true })), { type: 'tap', key: 'left', modifiers: ['shift'] });
  assert.deepEqual(planKey(k({ key: ' ', code: 'Space' })), { type: 'tap', key: 'space', modifiers: [] });
  assert.equal(planKey(k({ key: 'Shift', code: 'ShiftLeft' })), null, 'modificador sozinho não é enviado');
  assert.equal(planKey({ type: 'input', kind: 'keyup', key: 'a', code: 'KeyA' }), null);
  assert.equal(codeToKey('F5'), 'f5');
  assert.equal(codeToKey('Digit7'), '7');
  assert.equal(codeToKey('LaunchMail'), null);
});

test('rolagem e limites de coordenadas', () => {
  assert.equal(wheelTicks(100), 1);
  assert.equal(wheelTicks(-30), -1);
  assert.equal(wheelTicks(100000), 10);
  assert.deepEqual(toTargetPoint({ x: 10, y: 20, width: 101, height: 201 }, 0.5, 1), { x: 60, y: 220 });
  const robot = fakeRobot();
  const inj = createInjector({ robot });
  inj.setTarget(SCREEN);
  inj.setEnabled(true);
  inj.handle({ type: 'input', kind: 'wheel', x: 0.5, y: 0.5, deltaY: 200 });
  // robotjs: y negativo rola para baixo (verificado em X11 real).
  assert.deepEqual(robot.calls.at(-1), ['scroll', 0, -2]);
});

/* ---------- Rede local ---------- */

test('prova da descoberta depende do código, do nonce e do certificado', async () => {
  const key = await deriveInviteKey('123456789', 'ABCDEFGH');
  const fields = { id: '123456789', nonce: 'n'.repeat(24), port: 4000, fp: 'abc' };
  const mac = proofFor(key, fields);
  assert.equal(verifyProof(key, fields, mac), true);
  assert.equal(verifyProof(key, { ...fields, fp: 'outro' }, mac), false, 'certificado trocado');
  assert.equal(verifyProof(key, { ...fields, nonce: 'm'.repeat(24) }, mac), false, 'resposta reaproveitada');
  const wrong = await deriveInviteKey('123456789', 'ZZZZZZZZ');
  assert.equal(verifyProof(wrong, fields, mac), false, 'código errado');
});

test('descoberta real por UDP: acha com o código certo, ignora o errado', async () => {
  const port = 47000 + Math.floor(Math.random() * 500);
  const key = await deriveInviteKey('555666777', 'HJKMNPQR');
  const responder = createResponder({ port, getKey: (id) => (id === '555666777' ? key : null), servicePort: () => 9443, fingerprint: 'fp123' });
  await responder.ready;
  try {
    const found = await discover({ sessionId: '555666777', secret: 'HJKMNPQR', address: '127.0.0.1', port, timeoutMs: 2000 });
    assert.deepEqual(found, { host: '127.0.0.1', port: 9443, fingerprint: 'fp123' });
    assert.equal(await discover({ sessionId: '555666777', secret: 'ZZZZZZZZ', address: '127.0.0.1', port, timeoutMs: 1200 }), null);
    assert.equal(await discover({ sessionId: '111222333', secret: 'HJKMNPQR', address: '127.0.0.1', port, timeoutMs: 1200 }), null);
  } finally {
    await responder.close();
  }
});

test('certificado da rede local é criado uma vez, com chave privada protegida', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponte-lan-'));
  try {
    const a = await ensureCertificate(dir);
    const b = await ensureCertificate(dir);
    assert.equal(a.fingerprint, b.fingerprint);
    assert.match(a.fingerprint, /^[A-Za-z0-9+/]{43}=$/);
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'lan-key.pem')).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('endereços: broadcast calculado e validação do endereço informado', () => {
  const addrs = localAddresses({
    eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.23', netmask: '255.255.255.0' }],
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
  });
  assert.deepEqual(addrs, [{ address: '192.168.1.23', broadcast: '192.168.1.255' }]);
  assert.equal(isValidAddress('192.168.0.10'), true);
  assert.equal(isValidAddress('notebook.local'), true);
  assert.equal(isValidAddress('http://x'), false);
  assert.equal(isValidAddress('a b'), false);
});

/* ---------- Atualização ---------- */

test('modo de atualização por plataforma e formato', () => {
  assert.equal(updateMode({ isPackaged: false, platform: 'win32' }), 'unsupported');
  assert.equal(updateMode({ isPackaged: true, platform: 'win32', env: {} }), 'auto');
  assert.equal(updateMode({ isPackaged: true, platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'C:\\x' } }), 'notify');
  assert.equal(updateMode({ isPackaged: true, platform: 'linux', env: { APPIMAGE: '/a.AppImage' } }), 'auto');
  assert.equal(updateMode({ isPackaged: true, platform: 'linux', env: {} }), 'notify');
  assert.equal(updateMode({ isPackaged: true, platform: 'darwin', env: {} }), 'notify');
});

function fakeAutoUpdater() {
  const u = new EventEmitter();
  u.checks = 0;
  u.checkForUpdates = () => { u.checks += 1; return Promise.resolve(); };
  u.downloadUpdate = () => Promise.resolve();
  u.quitAndInstall = () => { u.installed = true; };
  return u;
}

test('atualizador: baixa sozinho quando ligado, só avisa quando desligado, nunca instala sem pedido', () => {
  let enabled = true;
  const statuses = [];
  const au = fakeAutoUpdater();
  const up = createUpdater({ autoUpdater: au, mode: 'auto', isEnabled: () => enabled, onStatus: (s) => statuses.push(s.state) });
  up.check();
  assert.equal(au.autoDownload, true);
  au.emit('update-available', { version: '0.2.1' });
  au.emit('download-progress', { percent: 50 });
  au.emit('update-downloaded', { version: '0.2.1' });
  assert.deepEqual(statuses, ['downloading', 'downloading', 'ready']);
  assert.equal(au.installed, undefined, 'não reinicia sozinho');
  assert.equal(up.installNow(), true);
  assert.equal(au.installed, true);

  enabled = false;
  const au2 = fakeAutoUpdater();
  const up2 = createUpdater({ autoUpdater: au2, mode: 'auto', isEnabled: () => enabled, onStatus: () => {} });
  up2.check();
  assert.equal(au2.autoDownload, false);
  au2.emit('update-available', { version: '0.2.1' });
  assert.equal(up2.status.state, 'available');
  assert.equal(up2.download(), true);
  up2.check({ manual: true });
});

test('atualizador em modo "avisar" e sem suporte', () => {
  const au = fakeAutoUpdater();
  const up = createUpdater({ autoUpdater: au, mode: 'notify', isEnabled: () => true, onStatus: () => {} });
  up.check();
  au.emit('update-available', { version: '9.9.9' });
  assert.equal(up.status.state, 'available');
  assert.equal(up.installNow(), false);
  const none = createUpdater({ autoUpdater: fakeAutoUpdater(), mode: 'unsupported', isEnabled: () => true, onStatus: () => {} });
  assert.equal(none.check(), false);
  assert.equal(none.status.state, 'unsupported');
});

test('injetor informa botões pressionados (proteção contra botão preso)', () => {
  const robot = fakeRobot();
  const inj = createInjector({ robot });
  inj.setTarget(SCREEN);
  inj.setEnabled(true);
  inj.handle({ type: 'input', kind: 'pointerdown', x: 0.5, y: 0.5, button: 0 });
  assert.equal(inj.pressedCount, 1);
  inj.releaseAll();
  assert.equal(inj.pressedCount, 0);
  assert.deepEqual(robot.calls.at(-1), ['toggle', 'up', 'left']);
});
