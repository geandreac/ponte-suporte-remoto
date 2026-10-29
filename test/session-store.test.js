import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionStore } from '../server/session-store.js';

function setup(options = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const store = new SessionStore({ now: clock.now, ...options });
  const created = store.createSession({ hostName: 'Maria', capabilities: { screenCapture: true } });
  return { store, clock, ...created };
}

const join = (store, session, secret, extra = {}) => store.requestJoin({
  sessionId: session.id, secret, name: 'Técnico', requested: { view: true, chat: true }, ...extra,
});

test('cria sessão com ID de 9 dígitos e não guarda segredos em claro', () => {
  const { session, secret, hostToken } = setup();
  assert.match(session.id, /^\d{9}$/);
  assert.match(secret, /^[2-9A-HJKMNP-Z]{8}$/);
  const serialized = JSON.stringify(session);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes(hostToken));
});

test('fluxo completo: pedido -> aprovação com permissões reduzidas', () => {
  const { store, session, secret } = setup();
  const req = join(store, session, secret);
  assert.equal(req.ok, true);
  assert.equal(session.status, 'pending');
  const res = store.respond({ sessionId: session.id, requestId: req.request.id, accept: true, granted: { view: true, files: true } });
  assert.equal(res.accepted, true);
  assert.deepEqual(res.session.granted, { view: true, control: false, files: false, chat: false, record: false });
  assert.equal(store.authenticate(session.id, res.techToken).role, 'tech');
});

test('convite é de uso único', () => {
  const { store, session, secret } = setup();
  const req = join(store, session, secret);
  store.respond({ sessionId: session.id, requestId: req.request.id, accept: true, granted: { view: true } });
  assert.equal(join(store, session, secret).error, 'invalid_credentials');
});

test('recusa devolve a sessão para "aguardando" sem emitir token', () => {
  const { store, session, secret } = setup();
  const req = join(store, session, secret);
  const res = store.respond({ sessionId: session.id, requestId: req.request.id, accept: false });
  assert.equal(res.accepted, false);
  assert.equal(res.techToken, undefined);
  assert.equal(session.status, 'waiting');
});

test('só um pedido pendente por vez', () => {
  const { store, session, secret } = setup();
  join(store, session, secret);
  assert.equal(join(store, session, secret).error, 'session_busy');
});

test('resposta com requestId errado é recusada', () => {
  const { store, session, secret } = setup();
  join(store, session, secret);
  assert.equal(store.respond({ sessionId: session.id, requestId: 'outro', accept: true }).error, 'no_pending_request');
});

test('código errado conta tentativas e bloqueia a sessão no limite', () => {
  const { store, session, secret } = setup({ maxFailedAttempts: 3 });
  assert.equal(join(store, session, 'ZZZZZZZZ').error, 'invalid_credentials');
  assert.equal(join(store, session, 'ZZZZZZZZ').locked, undefined);
  const third = join(store, session, 'ZZZZZZZZ');
  assert.equal(third.locked, true);
  assert.equal(store.get(session.id), null);
  // Nem o código certo funciona depois do bloqueio, e a resposta não revela o motivo.
  assert.equal(join(store, session, secret).error, 'invalid_credentials');
});

test('sessão inexistente responde igual a código errado (sem enumeração)', () => {
  const { store } = setup();
  assert.equal(store.requestJoin({ sessionId: '000000000', secret: 'ABCDEFGH', name: 'x', requested: { chat: true } }).error, 'invalid_credentials');
});

test('convite expira', () => {
  const { store, session, secret, clock } = setup({ inviteTtlMs: 60_000 });
  clock.advance(60_000);
  assert.equal(join(store, session, secret).error, 'invalid_credentials');
  const events = store.sweep();
  assert.deepEqual(events.map((e) => [e.type, e.reason]), [['ended', 'invite_expired']]);
  assert.equal(store.size, 0);
});

test('pedido de entrada sem resposta expira e libera a sessão', () => {
  const { store, session, secret, clock } = setup({ joinRequestTtlMs: 10_000 });
  join(store, session, secret);
  clock.advance(10_000);
  const events = store.sweep();
  assert.equal(events[0].type, 'request_expired');
  assert.equal(session.status, 'waiting');
  assert.equal(join(store, session, secret).ok, true);
});

test('queda sem reconexão dentro do prazo encerra a sessão', () => {
  const { store, session, secret, clock } = setup({ graceMs: 5_000 });
  const req = join(store, session, secret);
  store.respond({ sessionId: session.id, requestId: req.request.id, accept: true, granted: { view: true } });
  store.markDisconnected(session.id, 'tech');
  clock.advance(4_000);
  assert.equal(store.sweep().length, 0);
  store.markConnected(session.id, 'tech');
  clock.advance(10_000);
  assert.equal(store.sweep().length, 0);
  store.markDisconnected(session.id, 'host');
  clock.advance(5_000);
  assert.deepEqual(store.sweep().map((e) => e.reason), ['host_timeout']);
});

test('duração máxima da sessão', () => {
  const { store, session, secret, clock } = setup({ maxSessionMs: 1_000 });
  const req = join(store, session, secret);
  store.respond({ sessionId: session.id, requestId: req.request.id, accept: true, granted: { view: true } });
  clock.advance(1_000);
  assert.deepEqual(store.sweep().map((e) => e.reason), ['max_duration']);
});

test('encerramento invalida tokens imediatamente', () => {
  const { store, session, hostToken } = setup();
  assert.equal(store.authenticate(session.id, hostToken).role, 'host');
  store.end(session.id, 'host_ended');
  assert.equal(store.authenticate(session.id, hostToken), null);
});

test('atualização de permissões respeita o que foi pedido; pedido extra amplia o teto', () => {
  const { store, session, secret } = setup();
  const req = join(store, session, secret);
  store.respond({ sessionId: session.id, requestId: req.request.id, accept: true, granted: {} });
  assert.equal(store.updatePermissions(session.id, { files: true }).granted.files, false);
  store.requestPermissions(session.id, { files: true });
  assert.equal(store.updatePermissions(session.id, { files: true }).granted.files, true);
  assert.equal(store.updatePermissions(session.id, {}).granted.files, false);
});
