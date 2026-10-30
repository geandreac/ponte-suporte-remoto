import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatSecret, formatSessionId, sanitizeName, validateClientMessage, validateDataMessage,
} from '../shared/protocol.js';

test('sanitizeName remove controles, caracteres de direção e limita tamanho', () => {
  assert.equal(sanitizeName('  Ana‮  Souza\n'), 'Ana Souza');
  assert.equal(sanitizeName('x'.repeat(200)).length, 64);
  assert.equal(sanitizeName(42), '');
});

test('tech:join normaliza ID e código e exige nome e ao menos uma permissão', () => {
  const r = validateClientMessage({ type: 'tech:join', sessionId: '123 456-789', secret: 'abcd-efgh', name: 'Téc', requested: { chat: true } });
  assert.equal(r.ok, true);
  assert.equal(r.value.sessionId, '123456789');
  assert.equal(r.value.secret, 'ABCDEFGH');
  assert.equal(validateClientMessage({ type: 'tech:join', sessionId: '123456789', secret: 'ABCDEFGH', name: ' ', requested: { chat: true } }).error, 'invalid_name');
  assert.equal(validateClientMessage({ type: 'tech:join', sessionId: '123456789', secret: 'ABCDEFGH', name: 'a', requested: {} }).error, 'no_permissions_requested');
  // Caracteres ambíguos (0, O, 1, I, L) não fazem parte do alfabeto.
  assert.equal(validateClientMessage({ type: 'tech:join', sessionId: '123456789', secret: 'ABCDEFG0', name: 'a', requested: { chat: true } }).error, 'invalid_credentials');
});

test('sinalização rejeita SDP gigante e tipos desconhecidos', () => {
  assert.equal(validateClientMessage({ type: 'signal', payload: { kind: 'offer', sdp: 'x'.repeat(40_000) } }).ok, false);
  assert.equal(validateClientMessage({ type: 'signal', payload: { kind: 'hack' } }).ok, false);
  assert.equal(validateClientMessage({ type: 'admin:list' }).error, 'unknown_type');
  assert.equal(validateClientMessage(null).ok, false);
  const ice = validateClientMessage({ type: 'signal', payload: { kind: 'ice', candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0, extra: 'x' } } });
  assert.deepEqual(ice.value.payload.candidate, { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 });
});

test('mensagens de dados: chat, arquivos e entrada', () => {
  assert.equal(validateDataMessage({ type: 'chat', id: 'a1', text: '  oi ' }).value.text, 'oi');
  assert.equal(validateDataMessage({ type: 'chat', id: 'a1', text: 'x'.repeat(2001) }).ok, false);
  assert.equal(validateDataMessage({ type: 'chat', id: 'a b', text: 'oi' }).ok, false);
  assert.equal(validateDataMessage({ type: 'file-offer', id: 'f', name: 'a.txt', size: 3, mime: '', sha256: 'z' }).ok, false);
  assert.equal(validateDataMessage({ type: 'input', kind: 'pointermove', x: 1.5, y: 0 }).ok, false);
  assert.equal(validateDataMessage({ type: 'input', kind: 'pointerdown', x: 0.5, y: 0.5, button: 0 }).ok, true);
  assert.equal(validateDataMessage({ type: 'input', kind: 'keydown', code: 'KeyA', key: 'a' }).ok, true);
});

test('formatação para exibição', () => {
  assert.equal(formatSessionId('123456789'), '123 456 789');
  assert.equal(formatSecret('ABCDEFGH'), 'ABCD-EFGH');
});

test('coordenadas do controle remoto descontam as faixas pretas do vídeo', async () => {
  const { contentRect, normalizePoint } = await import('../public/js/remote-input.js');
  // Vídeo 1920x1080 num quadro 1000x800: imagem de 1000x562,5 centralizada na vertical.
  const r = contentRect({ left: 0, top: 0, width: 1000, height: 800 }, 1920, 1080);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
  near(r.width, 1000);
  near(r.top, (800 - 562.5) / 2);
  const mid = normalizePoint(r, 500, 400);
  near(mid.x, 0.5);
  near(mid.y, 0.5);
  assert.equal(normalizePoint(r, 500, 50), null, 'faixa preta não gera clique');
  assert.deepEqual(normalizePoint(r, 1200, 50, { clamp: true }), { x: 1, y: 0 });
  assert.equal(contentRect({ left: 0, top: 0, width: 10, height: 10 }, 0, 0), null);
});

test('share-state informa se o controle está ativo', () => {
  assert.equal(validateDataMessage({ type: 'share-state', paused: false, controlActive: true }).value.controlActive, true);
  assert.equal(validateDataMessage({ type: 'share-state', paused: false, controlActive: 'sim' }).value.controlActive, false);
});
