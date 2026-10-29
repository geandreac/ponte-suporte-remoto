import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { CHUNK_SIZE, FileTransfer } from '../public/js/file-transfer.js';
import { validateDataMessage } from '../shared/protocol.js';

// Dois lados ligados por uma fila ordenada, como um RTCDataChannel ordenado e confiável.
function pair({ canA = () => true, canB = () => true } = {}) {
  const queue = [];
  const sides = {};
  const deliver = async () => {
    while (queue.length) {
      const { to, kind, data } = queue.shift();
      if (kind === 'json') {
        const v = validateDataMessage(JSON.parse(JSON.stringify(data)));
        if (v.ok) await sides[to].handleMessage(v.value);
      } else {
        sides[to].handleBinary(data);
      }
    }
  };
  const makeLink = (to) => ({
    sendJson: (data) => { queue.push({ to, kind: 'json', data }); },
    sendBinary: (data) => { queue.push({ to, kind: 'bin', data }); },
    waitForDrain: () => deliver(),
  });
  sides.a = new FileTransfer({ link: makeLink('b'), can: canA });
  sides.b = new FileTransfer({ link: makeLink('a'), can: canB });
  const events = { a: [], b: [] };
  for (const s of ['a', 'b']) {
    for (const t of ['incoming', 'outgoing']) sides[s].addEventListener(t, (e) => events[s].push({ t, ...e.detail }));
  }
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await deliver();
      await tick();
    }
  };
  return { ...sides, events, flush, queue };
}

const textFile = (content, name = 'log.txt', type = 'text/plain') => new File([content], name, { type });

test('arquivo só é enviado depois que quem recebe aceita, e chega íntegro', async () => {
  const p = pair();
  const content = 'linha de log\n'.repeat(5000); // > 1 bloco
  assert.ok(content.length > CHUNK_SIZE);
  const id = await p.a.send(textFile(content));
  await p.flush();
  const offered = p.events.b.find((e) => e.status === 'offered');
  assert.equal(offered.name, 'log.txt');
  // Nenhum bloco binário antes do aceite.
  assert.ok(!p.events.b.some((e) => e.status === 'received'));
  p.b.accept(id);
  await p.flush();
  const received = p.events.b.find((e) => e.status === 'received');
  assert.ok(received, 'arquivo deveria chegar');
  assert.equal(await received.blob.text(), content);
  assert.equal(received.blob.type, 'text/plain');
  assert.ok(p.events.a.some((e) => e.status === 'sent'));
});

test('recusa não transfere nada', async () => {
  const p = pair();
  const id = await p.a.send(textFile('oi'));
  await p.flush();
  p.b.reject(id);
  await p.flush();
  assert.equal(p.events.a.at(-1).status, 'rejected');
  assert.ok(!p.events.b.some((e) => e.status === 'received'));
});

test('sem permissão o envio é recusado nos dois lados', async () => {
  const p = pair({ canA: () => false });
  await assert.rejects(p.a.send(textFile('x')), { code: 'not_permitted' });
  const q = pair({ canB: () => false });
  await q.a.send(textFile('x'));
  await q.flush();
  assert.equal(q.events.a.at(-1).status, 'rejected');
  assert.equal(q.events.a.at(-1).reason, 'not_permitted');
});

test('tipos proibidos e conteúdo disfarçado são barrados no envio', async () => {
  const p = pair();
  await assert.rejects(p.a.send(textFile('MZ', 'programa.exe', '')), { code: 'type_not_allowed' });
  await assert.rejects(p.a.send(new File([new Uint8Array([0x4d, 0x5a, 0, 0])], 'nota.txt')), { code: 'content_mismatch' });
  await assert.rejects(p.a.send(new File(['%PDF-1'], 'doc.pdf', { type: 'application/x-msdownload' })), { code: 'mime_mismatch' });
});

test('quem recebe revalida a oferta (não confia no outro lado)', async () => {
  const p = pair();
  await p.b.handleMessage({ type: 'file-offer', id: 'evil', name: 'virus.exe', size: 10, mime: '', sha256: '0'.repeat(64) });
  const blocked = p.events.b.find((e) => e.status === 'blocked');
  assert.equal(blocked.reason, 'type_not_allowed');
  await p.b.handleMessage({ type: 'file-offer', id: 'big', name: 'a.txt', size: 26 * 1024 * 1024, mime: '', sha256: '0'.repeat(64) });
  assert.equal(p.events.b.at(-1).reason, 'too_large');
  // Respostas de recusa voltam para o remetente.
  assert.ok(p.queue.every((m) => m.data.accept === false));
});

test('blocos binários sem aceite são descartados', async () => {
  const p = pair();
  p.b.handleBinary(new ArrayBuffer(100));
  await p.b.handleMessage({ type: 'file-offer', id: 'f1', name: 'a.txt', size: 3, mime: '', sha256: '0'.repeat(64) });
  p.b.handleBinary(new TextEncoder().encode('abc').buffer); // ainda aguardando aceite
  p.b.accept('f1');
  await p.b.handleMessage({ type: 'file-complete', id: 'f1' });
  assert.equal(p.events.b.at(-1).status, 'failed');
  assert.equal(p.events.b.at(-1).reason, 'integrity');
});

test('hash divergente é detectado', async () => {
  const p = pair();
  await p.b.handleMessage({ type: 'file-offer', id: 'f2', name: 'a.txt', size: 3, mime: 'text/plain', sha256: 'a'.repeat(64) });
  p.b.accept('f2');
  p.b.handleBinary(new TextEncoder().encode('abc').buffer);
  await p.b.handleMessage({ type: 'file-complete', id: 'f2' });
  assert.equal(p.events.b.at(-1).reason, 'integrity');
});

test('dados além do tamanho anunciado abortam a transferência', async () => {
  const p = pair();
  await p.b.handleMessage({ type: 'file-offer', id: 'f3', name: 'a.txt', size: 2, mime: '', sha256: 'a'.repeat(64) });
  p.b.accept('f3');
  p.b.handleBinary(new TextEncoder().encode('abc').buffer);
  assert.equal(p.events.b.at(-1).status, 'failed');
  assert.ok(p.queue.some((m) => m.data.type === 'file-cancel'));
});

test('revogar a permissão no meio interrompe o envio', async () => {
  let allowed = true;
  const p = pair({ canA: () => allowed });
  const id = await p.a.send(textFile('x'.repeat(CHUNK_SIZE * 4)));
  await p.flush();
  p.b.accept(id);
  allowed = false;
  await p.flush();
  assert.equal(p.events.a.at(-1).status, 'failed');
  assert.equal(p.events.a.at(-1).reason, 'permission_revoked');
  assert.ok(!p.events.b.some((e) => e.status === 'received'));
});

test('uma transferência por vez em cada direção', async () => {
  const p = pair();
  await p.a.send(textFile('1'));
  await assert.rejects(p.a.send(textFile('2')), { code: 'busy' });
});
