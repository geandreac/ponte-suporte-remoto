import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_FILE_SIZE, sanitizeFileName, validateFileOffer, verifyFileSignature,
} from '../shared/file-policy.js';
import { isActiveState, nextState } from '../shared/session-machine.js';
import { computeVerificationCode, extractFingerprints } from '../shared/verification.js';

test('máquina de estados: caminho feliz do técnico', () => {
  let s = 'idle';
  for (const ev of ['tech_join', 'pending', 'accepted', 'connected', 'connection_lost', 'connected', 'end', 'reset']) {
    s = nextState(s, ev);
    assert.ok(s, `transição ${ev} recusada`);
  }
  assert.equal(s, 'idle');
});

test('máquina de estados recusa transições inválidas', () => {
  assert.equal(nextState('ended', 'connected'), null);
  assert.equal(nextState('idle', 'connected'), null);
  assert.equal(nextState('waiting', 'accepted'), null);
  assert.equal(nextState('awaiting_approval', 'rejected'), 'ended');
  assert.equal(nextState('reconnecting', 'fail'), 'failed');
  assert.equal(isActiveState('reconnecting'), true);
});

test('política de arquivos: tipos, tamanho e MIME', () => {
  assert.equal(validateFileOffer({ name: 'log.txt', size: 10, mime: 'text/plain' }).ok, true);
  assert.equal(validateFileOffer({ name: 'erro.log', size: 10, mime: '' }).ok, true);
  assert.equal(validateFileOffer({ name: 'setup.exe', size: 10, mime: '' }).error, 'type_not_allowed');
  assert.equal(validateFileOffer({ name: 'foto.png.exe', size: 10, mime: '' }).error, 'type_not_allowed');
  assert.equal(validateFileOffer({ name: 'semextensao', size: 10, mime: '' }).error, 'type_not_allowed');
  assert.equal(validateFileOffer({ name: 'a.txt', size: 0, mime: '' }).error, 'empty_file');
  assert.equal(validateFileOffer({ name: 'a.pdf', size: MAX_FILE_SIZE + 1, mime: '' }).error, 'too_large');
  assert.equal(validateFileOffer({ name: 'a.pdf', size: 10, mime: 'application/x-msdownload' }).error, 'mime_mismatch');
  assert.equal(validateFileOffer({ name: 'a.PDF', size: 10, mime: 'application/pdf' }).value.extension, 'pdf');
});

test('nome de arquivo seguro', () => {
  assert.equal(sanitizeFileName('../../etc/passwd.txt'), 'passwd.txt');
  assert.equal(sanitizeFileName('C:\\Users\\x\\rel<a>.txt'), 'rel_a_.txt');
  assert.equal(sanitizeFileName('fatura\u202Etxt.pdf'), 'faturatxt.pdf');
  assert.equal(sanitizeFileName('...'), '');
  const long = sanitizeFileName(`${'a'.repeat(300)}.pdf`);
  assert.equal(long.length, 255);
  assert.ok(long.endsWith('.pdf'));
});

test('assinatura do conteúdo precisa bater com a extensão', () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.equal(verifyFileSignature('pdf', enc('%PDF-1.7 ...')), true);
  assert.equal(verifyFileSignature('pdf', enc('MZ executável')), false);
  assert.equal(verifyFileSignature('png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])), true);
  assert.equal(verifyFileSignature('txt', enc('olá mundo')), true);
  assert.equal(verifyFileSignature('txt', new Uint8Array([0x4d, 0x5a, 0x00, 0x01])), false);
  assert.equal(verifyFileSignature('exe', enc('x')), false);
});

const sdpWith = (fp) => `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${fp}\r\na=setup:actpass\r\n`;
const FP_A = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const FP_B = '11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF';
const FP_M = '99:99:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF';

test('código de verificação é igual nos dois lados e muda com intermediário', async () => {
  assert.deepEqual(extractFingerprints(sdpWith(FP_A)), [`sha-256 ${FP_A}`]);
  const hostView = await computeVerificationCode(sdpWith(FP_A), sdpWith(FP_B));
  const techView = await computeVerificationCode(sdpWith(FP_B), sdpWith(FP_A));
  assert.match(hostView, /^\d{4} \d{4}$/);
  assert.equal(hostView, techView);
  // Um intermediário negocia certificados diferentes com cada lado: os códigos divergem.
  const mitmHost = await computeVerificationCode(sdpWith(FP_A), sdpWith(FP_M));
  const mitmTech = await computeVerificationCode(sdpWith(FP_M), sdpWith(FP_B));
  assert.notEqual(mitmHost, mitmTech);
  assert.equal(await computeVerificationCode('v=0', sdpWith(FP_A)), null);
});
