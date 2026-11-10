import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

let app;
let base;
let offset = 0;
const now = () => Date.now() + offset;
const audit = [];

before(async () => {
  const config = {
    ...loadConfig({}),
    port: 0,
    inviteTtlMs: 60_000,
    joinRequestTtlMs: 30_000,
    graceMs: 5_000,
    stunUrls: ['stun:stun.example.org'],
    turnUrls: ['turn:turn.example.org'],
    turnSecret: 'turn-secret',
    // Todos os clientes de teste vêm do mesmo IP; o limite padrão por IP tem teste próprio no fim do arquivo.
    rateLimits: { create: { capacity: 100, refillPerSecond: 1 }, join: { capacity: 100, refillPerSecond: 1 }, upgrade: { capacity: 200, refillPerSecond: 5 } },
  };
  app = createApp(config, { now, auditWrite: (l) => audit.push(JSON.parse(l)) });
  const { port } = await app.listen();
  base = `127.0.0.1:${port}`;
});

after(() => app.close());

// Cliente de teste: guarda mensagens recebidas e permite aguardar por tipo.
async function client({ origin = `http://${base}` } = {}) {
  const ws = new WebSocket(`ws://${base}/ws`, { headers: { origin } });
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const c = {
    ws,
    send: (type, data = {}) => ws.send(JSON.stringify({ type, ...data })),
    next(type, timeout = 3000) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { type, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`timeout esperando ${type}`)), timeout).unref();
      });
    },
    async none(type, ms = 300) {
      await sleep(ms);
      assert.ok(!inbox.some((m) => m.type === type), `não deveria receber ${type}`);
    },
    close: () => new Promise((resolve) => { ws.once('close', resolve); ws.close(); }),
  };
  await c.next('hello');
  return c;
}

async function hostSession() {
  const host = await client();
  host.send('host:create', { name: 'Maria', capabilities: { screenCapture: true } });
  const created = await host.next('session-created');
  return { host, created };
}

async function connectedPair(requested = { view: true, chat: true }, granted = { view: true, chat: true }) {
  const { host, created } = await hostSession();
  const tech = await client();
  tech.send('tech:join', { sessionId: created.sessionId, secret: created.secret, name: 'João', requested });
  const req = await host.next('join-request');
  host.send('host:respond', { requestId: req.requestId, accept: true, granted });
  const accepted = await tech.next('join-accepted');
  await host.next('peer-joined');
  return { host, tech, created, accepted };
}

test('rejeita WebSocket de outra origem', async () => {
  await assert.rejects(client({ origin: 'https://site-malicioso.example' }));
});

test('aceita a origem do app de computador', async () => {
  const c = await client({ origin: 'ponte://app' });
  await c.close();
});

test('fluxo completo: convite, aprovação, sinalização e encerramento', async () => {
  const { host, created } = await hostSession();
  assert.match(created.sessionId, /^\d{9}$/);
  assert.equal(created.iceServers[1].username.endsWith(`${created.sessionId}-host`), true);

  const tech = await client();
  tech.send('tech:join', { sessionId: created.sessionId, secret: created.secret, name: 'João', requested: { view: true, chat: true, files: true } });
  const req = await host.next('join-request');
  assert.equal(req.name, 'João');
  assert.deepEqual(req.requested, { view: true, control: false, files: true, chat: true, record: false });
  const pending = await tech.next('join-pending');
  assert.equal(pending.hostName, 'Maria');

  // Antes da aprovação o técnico não consegue sinalizar nem receber ICE/TURN.
  tech.send('signal', { payload: { kind: 'offer', sdp: 'v=0' } });
  assert.equal((await tech.next('error')).code, 'not_allowed');

  host.send('host:respond', { requestId: req.requestId, accept: true, granted: { view: true, chat: true } });
  const accepted = await tech.next('join-accepted');
  assert.deepEqual(accepted.granted, { view: true, control: false, files: false, chat: true, record: false });
  assert.ok(accepted.token.length >= 32);
  assert.equal(accepted.iceServers.length, 2);
  await host.next('peer-joined');

  host.send('signal', { payload: { kind: 'offer', sdp: 'v=0\r\n' } });
  assert.equal((await tech.next('signal')).payload.kind, 'offer');
  tech.send('signal', { payload: { kind: 'answer', sdp: 'v=0\r\n' } });
  assert.equal((await host.next('signal')).payload.kind, 'answer');

  host.send('session:end');
  assert.equal((await tech.next('session-ended')).reason, 'host_ended');
  assert.equal((await host.next('session-ended')).reason, 'host_ended');

  // Segredos nunca aparecem no log de auditoria.
  const logText = JSON.stringify(audit);
  assert.ok(!logText.includes(created.secret));
  assert.ok(!logText.includes(created.hostToken));
  assert.ok(!logText.includes(accepted.token));
  await Promise.all([host.close(), tech.close()]);
});

test('recusa do anfitrião não entrega token', async () => {
  const { host, created } = await hostSession();
  const tech = await client();
  tech.send('tech:join', { sessionId: created.sessionId, secret: created.secret, name: 'Golpista', requested: { view: true } });
  const req = await host.next('join-request');
  host.send('host:respond', { requestId: req.requestId, accept: false });
  assert.equal((await tech.next('join-rejected')).reason, 'declined');
  tech.send('signal', { payload: { kind: 'offer', sdp: 'v=0' } });
  assert.equal((await tech.next('error')).code, 'not_allowed');
  await Promise.all([host.close(), tech.close()]);
});

test('técnico não pode alterar permissões; anfitrião revoga na hora', async () => {
  const { host, tech } = await connectedPair();
  tech.send('permissions:update', { granted: { view: true, chat: true, files: true } });
  assert.equal((await tech.next('error')).code, 'not_allowed');

  host.send('permissions:update', { granted: { view: false, chat: true } });
  const update = await tech.next('permissions');
  assert.equal(update.granted.view, false);
  assert.equal(update.granted.chat, true);
  await host.next('permissions');

  tech.send('permissions:request', { requested: { files: true } });
  const ask = await host.next('permissions-request');
  assert.deepEqual(ask.asked, { view: false, control: false, files: true, chat: false, record: false });
  await Promise.all([host.close(), tech.close()]);
});

test('código errado repetido bloqueia a sessão e avisa o anfitrião', async () => {
  const { host, created } = await hostSession();
  const attacker = await client();
  for (let i = 0; i < 5; i++) {
    attacker.send('tech:join', { sessionId: created.sessionId, secret: 'ZZZZZZZZ', name: 'x', requested: { view: true } });
    assert.equal((await attacker.next('error')).code, 'invalid_credentials');
  }
  assert.equal((await host.next('session-ended')).reason, 'too_many_attempts');
  attacker.send('tech:join', { sessionId: created.sessionId, secret: created.secret, name: 'x', requested: { view: true } });
  assert.match((await attacker.next('error')).code, /invalid_credentials|rate_limited/);
  await Promise.all([host.close(), attacker.close()]);
});

test('queda do técnico: anfitrião é avisado e o técnico retoma com o token', async () => {
  const { host, tech, created, accepted } = await connectedPair();
  await tech.close();
  assert.equal((await host.next('peer-status')).status, 'disconnected');

  const back = await client();
  back.send('session:resume', { sessionId: created.sessionId, token: accepted.token });
  const resumed = await back.next('resumed');
  assert.equal(resumed.role, 'tech');
  assert.equal(resumed.peerConnected, true);
  assert.equal((await host.next('peer-status')).status, 'connected');

  const intruder = await client();
  intruder.send('session:resume', { sessionId: created.sessionId, token: 'x'.repeat(43) });
  assert.equal((await intruder.next('resume-failed')).reason, 'invalid_session');
  await Promise.all([host.close(), back.close(), intruder.close()]);
});

test('sem reconexão dentro do prazo a sessão é encerrada para o outro lado', async () => {
  const { host, tech } = await connectedPair();
  await tech.close();
  await host.next('peer-status');
  offset += 6_000;
  assert.equal((await host.next('session-ended', 4000)).reason, 'tech_timeout');
  offset -= 6_000;
  await host.close();
});

test('convite expira e o anfitrião é avisado', async () => {
  const { host, created } = await hostSession();
  offset += 61_000;
  assert.equal((await host.next('session-ended', 4000)).reason, 'invite_expired');
  offset -= 61_000;
  const late = await client();
  late.send('tech:join', { sessionId: created.sessionId, secret: created.secret, name: 'x', requested: { view: true } });
  assert.match((await late.next('error')).code, /invalid_credentials|rate_limited/);
  await Promise.all([host.close(), late.close()]);
});

test('técnico que desiste enquanto aguarda libera o pedido', async () => {
  const { host, created } = await hostSession();
  const tech = await client();
  tech.send('tech:join', { sessionId: created.sessionId, secret: created.secret, name: 'João', requested: { chat: true } });
  const req = await host.next('join-request');
  await tech.close();
  assert.equal((await host.next('join-request-cancelled')).requestId, req.requestId);
  await host.close();
});

test('mensagens inválidas e JSON quebrado são recusados sem derrubar a conexão', async () => {
  const c = await client();
  c.ws.send('{não é json');
  assert.equal((await c.next('error')).code, 'invalid_message');
  c.send('admin:dump');
  assert.equal((await c.next('error')).code, 'unknown_type');
  c.send('host:respond', { requestId: 'abc', accept: true });
  assert.equal((await c.next('error')).code, 'not_allowed');
  await c.close();
});

test('limite padrão por IP barra tentativas de adivinhar códigos em sessões diferentes', async () => {
  const strict = createApp({ ...loadConfig({}), port: 0, stunUrls: [] }, { auditWrite: () => {} });
  const { port } = await strict.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
  const codes = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'error') codes.push(m.code);
  });
  await new Promise((resolve) => ws.once('open', resolve));
  for (let i = 0; i < 12; i++) {
    ws.send(JSON.stringify({ type: 'tech:join', sessionId: String(100000000 + i), secret: 'ABCDEFGH', name: 'x', requested: { view: true } }));
  }
  await sleep(300);
  assert.equal(codes.filter((c) => c === 'invalid_credentials').length, 10);
  assert.equal(codes.filter((c) => c === 'rate_limited').length, 2);
  ws.close();
  await strict.close();
});

test('keepalive é aceito sem erro e sem efeito colateral', async () => {
  const c = await client();
  c.send('keepalive');
  await c.none('error', 300);
  await c.close();
});

/* ---------- Acesso sem supervisão: registro de computadores ---------- */

const { generateKeyPairSync, sign } = await import('node:crypto');
const { deviceIdForPublicKey } = await import('../server/device-identity.js');
const { registrationPayload } = await import('../shared/device-identity.js');

function newDeviceKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return { pub, privateKey, deviceId: deviceIdForPublicKey(pub) };
}

// Conecta como computador: lê o desafio (nonce) do "hello" e registra assinando-o.
async function registerDevice(keys, { name = 'PC de casa', tamper } = {}) {
  const ws = new WebSocket(`ws://${base}/ws`, { headers: { origin: 'ponte://app' } });
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  const next = (type) => {
    const i = inbox.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ type, resolve });
      setTimeout(() => reject(new Error(`timeout ${type}`)), 3000).unref();
    });
  };
  await new Promise((r) => ws.once('open', r));
  const hello = await next('hello');
  const deviceId = tamper?.deviceId ?? keys.deviceId;
  const signature = sign(null, Buffer.from(registrationPayload(tamper?.nonce ?? hello.nonce, deviceId)), keys.privateKey).toString('base64');
  ws.send(JSON.stringify({
    type: 'device:register', deviceId, publicKey: keys.pub, signature, name, capabilities: { screenCapture: true, inputInjection: true },
  }));
  return { ws, next, send: (type, data = {}) => ws.send(JSON.stringify({ type, ...data })), hello };
}

test('computador se registra provando a posse da chave; ID deriva da chave', async () => {
  const keys = newDeviceKeys();
  assert.match(keys.deviceId, /^[1-9]\d{8}$/);
  const dev = await registerDevice(keys);
  assert.equal(dev.hello.version, 2);
  assert.ok(dev.hello.nonce.length >= 32);
  assert.equal((await dev.next('device-registered')).deviceId, keys.deviceId);
  dev.ws.close();
});

test('registro com ID de outro computador, assinatura de outro desafio ou chave errada é recusado', async () => {
  const keys = newDeviceKeys();
  const other = newDeviceKeys();
  const a = await registerDevice(keys, { tamper: { deviceId: other.deviceId } });
  assert.equal((await a.next('error')).code, 'invalid_device');
  const b = await registerDevice(keys, { tamper: { nonce: 'desafio-reaproveitado-de-outra-conexao' } });
  assert.equal((await b.next('error')).code, 'invalid_device');
  a.ws.close();
  b.ws.close();
});

test('técnico não encontra computador desconectado (sem revelar mais nada)', async () => {
  const tech = await client();
  tech.send('unattended:connect', { deviceId: '123456789', name: 'Eu', requested: { view: true } });
  assert.equal((await tech.next('error')).code, 'device_unavailable');
  await tech.close();
});

test('sessão sem supervisão: nasce sem permissões e só o computador pode liberá-las', async () => {
  const keys = newDeviceKeys();
  const dev = await registerDevice(keys);
  await dev.next('device-registered');
  const tech = await client();
  tech.send('unattended:connect', { deviceId: keys.deviceId, name: 'Eu no trabalho', requested: { view: true, control: true } });
  const accepted = await tech.next('join-accepted');
  assert.equal(accepted.unattended, true);
  assert.equal(accepted.hostName, 'PC de casa');
  assert.deepEqual(accepted.granted, { view: false, control: false, files: false, chat: false, record: false });
  const incoming = await dev.next('unattended:incoming');
  assert.equal(incoming.sessionId, accepted.sessionId);
  assert.equal(incoming.techName, 'Eu no trabalho');

  // O técnico não consegue se dar permissões.
  tech.send('permissions:update', { granted: { view: true, control: true } });
  assert.equal((await tech.next('error')).code, 'not_allowed');

  // O computador entra como anfitrião com o token recebido e libera o que decidir.
  const host = await client({ origin: 'ponte://app' });
  host.send('session:resume', { sessionId: incoming.sessionId, token: incoming.hostToken });
  const resumed = await host.next('resumed');
  assert.equal(resumed.role, 'host');
  assert.equal(resumed.peerConnected, true);
  host.send('permissions:update', { granted: { view: true, control: true } });
  const perms = await tech.next('permissions');
  assert.equal(perms.granted.view, true);
  assert.equal(perms.granted.control, true);

  // Encerrar pelo computador encerra para o técnico.
  host.send('session:end');
  assert.equal((await tech.next('session-ended')).reason, 'host_ended');
  // Segredo do anfitrião nunca no log.
  assert.ok(!JSON.stringify(audit).includes(incoming.hostToken));
  await Promise.all([tech.close(), host.close()]);
  dev.ws.close();
});

test('computador que não assume a sessão no prazo: técnico é avisado', async () => {
  const keys = newDeviceKeys();
  const dev = await registerDevice(keys);
  await dev.next('device-registered');
  const tech = await client();
  tech.send('unattended:connect', { deviceId: keys.deviceId, name: 'Eu', requested: { view: true } });
  await tech.next('join-accepted');
  offset += 6_000;
  assert.equal((await tech.next('session-ended', 4000)).reason, 'host_timeout');
  offset -= 6_000;
  await tech.close();
  dev.ws.close();
});

test('motivo de encerramento: só quem compartilha informa, e só de uma lista fechada', async () => {
  const { host, tech } = await connectedPair();
  tech.send('session:end', { reason: 'revoked' });
  assert.equal((await host.next('session-ended')).reason, 'tech_ended', 'técnico não escolhe o motivo');
  await Promise.all([host.close(), tech.close()]);
  const pair = await connectedPair();
  pair.host.send('session:end', { reason: '<script>' });
  assert.equal((await pair.tech.next('session-ended')).reason, 'host_ended');
  await Promise.all([pair.host.close(), pair.tech.close()]);
  const third = await connectedPair();
  third.host.send('session:end', { reason: 'revoked' });
  assert.equal((await third.tech.next('session-ended')).reason, 'revoked');
  await Promise.all([third.host.close(), third.tech.close()]);
});
