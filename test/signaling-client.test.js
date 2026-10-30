import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { SignalingClient } from '../public/js/signaling-client.js';

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const clientFor = (port, options = {}) => new SignalingClient(`ws://127.0.0.1:${port}/ws`, {
  createSocket: (u) => new WebSocket(u, { headers: { origin: `http://127.0.0.1:${port}` } }),
  ...options,
});

test('servidor "acordando": o cliente espera e conecta quando ele sobe', async () => {
  const port = await freePort();
  const client = clientFor(port, { wakeRetryMs: 200, wakeTimeoutMs: 8000 });
  const statuses = [];
  client.addEventListener('status', (e) => statuses.push(e.detail));
  const connecting = client.ensureConnected();
  await sleep(800); // servidor ainda dormindo
  const app = createApp({ ...loadConfig({}), port }, { auditWrite: () => {} });
  await app.listen();
  try {
    await connecting;
    assert.ok(statuses.includes('waking'), `estados: ${statuses}`);
    assert.equal(statuses.at(-1), 'online');
  } finally {
    client.close();
    await app.close();
  }
});

test('servidor que não acorda no prazo: falha com estado desconectado', async () => {
  const port = await freePort();
  const client = clientFor(port, { wakeRetryMs: 100, wakeTimeoutMs: 600 });
  await assert.rejects(client.ensureConnected());
  assert.equal(client.status, 'offline');
});

test('sinal periódico (keepalive) enquanto conectado, aceito pelo servidor', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.once('listening', resolve));
  const { port } = wss.address();
  const received = [];
  wss.on('connection', (ws) => ws.on('message', (raw) => received.push(JSON.parse(raw.toString()).type)));
  const client = clientFor(port, { keepaliveMs: 100 });
  await client.ensureConnected();
  await sleep(450);
  client.close();
  await new Promise((resolve) => wss.close(resolve));
  assert.ok(received.filter((t) => t === 'keepalive').length >= 3, `recebidos: ${received}`);
});
