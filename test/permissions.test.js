import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authorizeIncoming, diffPermissions, emptyPermissions, mergeRequested, normalizePermissions, resolveGrant,
} from '../shared/permissions.js';

const caps = { screenCapture: true, inputInjection: false };

test('tudo começa negado (menor privilégio)', () => {
  assert.deepEqual(emptyPermissions(), { view: false, control: false, files: false, chat: false, record: false });
});

test('normalizePermissions só aceita true literal e chaves conhecidas', () => {
  const n = normalizePermissions({ view: 'yes', chat: true, files: 1, admin: true, __proto__: { record: true } });
  assert.deepEqual(n, { view: false, control: false, files: false, chat: true, record: false });
  assert.deepEqual(normalizePermissions(null), emptyPermissions());
  assert.deepEqual(normalizePermissions([true]), emptyPermissions());
});

test('não é possível conceder o que não foi pedido', () => {
  const g = resolveGrant({ requested: { view: true }, granted: { view: true, chat: true, files: true }, capabilities: caps });
  assert.equal(g.view, true);
  assert.equal(g.chat, false);
  assert.equal(g.files, false);
});

test('pedido não concedido continua negado', () => {
  const g = resolveGrant({ requested: { view: true, chat: true }, granted: { chat: true }, capabilities: caps });
  assert.deepEqual(g, { ...emptyPermissions(), chat: true });
});

test('controle remoto exige capacidade de injeção de entrada', () => {
  const req = { view: true, control: true };
  assert.equal(resolveGrant({ requested: req, granted: req, capabilities: caps }).control, false);
  assert.equal(resolveGrant({ requested: req, granted: req, capabilities: { screenCapture: true, inputInjection: true } }).control, true);
});

test('gravar e controlar dependem de ver a tela', () => {
  const all = { view: false, control: true, record: true, chat: true };
  const g = resolveGrant({ requested: all, granted: all, capabilities: { screenCapture: true, inputInjection: true } });
  assert.equal(g.record, false);
  assert.equal(g.control, false);
  assert.equal(g.chat, true);
});

test('sem captura de tela não há visualização nem gravação', () => {
  const req = { view: true, record: true, chat: true };
  const g = resolveGrant({ requested: req, granted: req, capabilities: { screenCapture: false } });
  assert.deepEqual(g, { ...emptyPermissions(), chat: true });
});

test('diffPermissions e mergeRequested', () => {
  assert.deepEqual(diffPermissions({ view: true, chat: true }, { view: true, files: true }), { granted: ['files'], revoked: ['chat'] });
  assert.deepEqual(mergeRequested({ view: true }, { chat: true }), { ...emptyPermissions(), view: true, chat: true });
});

test('authorizeIncoming aplica permissões no lado de quem compartilha', () => {
  const granted = { ...emptyPermissions(), view: true };
  assert.deepEqual(authorizeIncoming('host', 'chat', granted), { allowed: false, reason: 'not_permitted', permission: 'chat' });
  assert.equal(authorizeIncoming('host', 'chat', { ...granted, chat: true }).allowed, true);
  assert.equal(authorizeIncoming('host', 'input', granted).allowed, false);
  assert.equal(authorizeIncoming('host', 'file-offer', granted).allowed, false);
  assert.equal(authorizeIncoming('host', 'file-cancel', granted).allowed, true);
  assert.equal(authorizeIncoming('host', 'recording-state', granted).allowed, true);
  // O técnico não pode mandar "share-state" (só quem compartilha controla a pausa).
  assert.equal(authorizeIncoming('host', 'share-state', granted).allowed, false);
  assert.equal(authorizeIncoming('viewer', 'share-state', granted).allowed, true);
  assert.equal(authorizeIncoming('viewer', 'input', granted).allowed, false);
  assert.equal(authorizeIncoming('intruso', 'chat', granted).allowed, false);
});
