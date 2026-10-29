import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuditLog, redact } from '../server/audit-log.js';
import { createIceProvider, turnCredential } from '../server/ice.js';
import { createRateLimiter } from '../server/rate-limiter.js';
import { resolveStaticPath } from '../server/app.js';

test('rate limiter bloqueia após a capacidade e recarrega com o tempo', () => {
  let t = 0;
  const rl = createRateLimiter({ capacity: 3, refillPerSecond: 1, now: () => t });
  assert.deepEqual([rl.take('ip'), rl.take('ip'), rl.take('ip'), rl.take('ip')], [true, true, true, false]);
  assert.equal(rl.take('outro-ip'), true);
  t += 1000;
  assert.equal(rl.take('ip'), true);
  assert.equal(rl.take('ip'), false);
});

test('rate limiter não cresce sem limite', () => {
  let t = 0;
  const rl = createRateLimiter({ capacity: 1, refillPerSecond: 0.001, now: () => t, maxKeys: 10 });
  for (let i = 0; i < 100; i++) rl.take(`k${i}`);
  assert.ok(rl.size <= 10);
});

test('log de auditoria mascara segredos, tokens, SDP e conteúdo', () => {
  const lines = [];
  const audit = createAuditLog({ write: (l) => lines.push(l), now: () => 0 });
  audit.log('teste', {
    sessionId: '123456789', secret: 'ABCDEFGH', hostToken: 'tok', nested: { sdp: 'v=0', text: 'mensagem' }, granted: ['view'],
  });
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.sessionId, '123456789');
  assert.equal(entry.secret, '[redacted]');
  assert.equal(entry.hostToken, '[redacted]');
  assert.equal(entry.nested.sdp, '[redacted]');
  assert.equal(entry.nested.text, '[redacted]');
  assert.deepEqual(entry.granted, ['view']);
  assert.ok(!lines[0].includes('ABCDEFGH'));
  assert.deepEqual(redact(['a', { password: 'x' }]), ['a', { password: '[redacted]' }]);
});

test('credenciais TURN temporárias seguem o padrão TURN REST', () => {
  const ice = createIceProvider({ stunUrls: ['stun:s'], turnUrls: ['turn:t'], turnSecret: 'segredo', turnTtlSec: 60, now: () => 1_000_000 });
  const [stun, turn] = ice.forParticipant('123-host');
  assert.deepEqual(stun, { urls: ['stun:s'] });
  assert.equal(turn.username, '1060:123-host');
  assert.equal(turn.credential, turnCredential('segredo', '1060:123-host'));
  assert.ok(!JSON.stringify(turn).includes('segredo'));
  assert.equal(createIceProvider({ stunUrls: [] }).forParticipant('x').length, 0);
});

test('arquivos estáticos não escapam das pastas públicas', () => {
  assert.match(resolveStaticPath('/'), /public[\\/]index\.html$/);
  assert.match(resolveStaticPath('/shared/protocol.js'), /shared[\\/]protocol\.js$/);
  assert.equal(resolveStaticPath('/../server/config.js'), null);
  assert.equal(resolveStaticPath('/%2e%2e/package.json'), null);
  assert.equal(resolveStaticPath('/shared/../../package.json'), null);
  assert.equal(resolveStaticPath('/%E0%A4%A'), null);
});
