// Conexão pela rede local, sem servidor na internet.
//
// Quem gera o convite abre, só enquanto o convite/sessão existir:
//   - um servidor de sinalização com TLS (certificado próprio, gerado no 1º uso);
//   - um "respondedor" UDP que atende buscas pelo ID da sessão.
// Quem presta suporte procura o ID na rede (broadcast, ou direto num endereço informado).
//
// Segurança da descoberta: a resposta traz porta e impressão digital do certificado,
// autenticadas por HMAC com uma chave derivada do CÓDIGO do convite (scrypt). O código nunca
// trafega na busca; quem não conhece o código não consegue forjar uma resposta, e quem só
// escuta a rede não consegue descobrir o código (scrypt torna inviável testar ~10^12 códigos
// no prazo do convite). Depois, a conexão TLS é aceita só com aquele certificado (pinning).

import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, X509Certificate } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import selfsigned from 'selfsigned';
import { createRateLimiter } from '../server/rate-limiter.js';
import { SESSION_ID_PATTERN } from '../shared/protocol.js';

export const LAN_PORT = 47800;
const scrypt = promisify(scryptCb);
const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_DATAGRAM = 1024;
const PROTOCOL = 'ponte-lan-v1';

export function deriveInviteKey(sessionId, secret) {
  return scrypt(String(secret), `${PROTOCOL}|${sessionId}`, 32, SCRYPT_OPTIONS);
}

export function proofFor(key, { id, nonce, port, fp }) {
  return createHmac('sha256', key).update(`${PROTOCOL}|${id}|${nonce}|${port}|${fp}`).digest('base64');
}

export function verifyProof(key, fields, mac) {
  const expected = Buffer.from(proofFor(key, fields));
  const given = Buffer.from(String(mac ?? ''));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// Impressão digital no mesmo formato que o Electron usa: base64(SHA-256(DER)).
export function certFingerprint(certPem) {
  return createHash('sha256').update(new X509Certificate(certPem).raw).digest('base64');
}

export async function ensureCertificate(dir) {
  const certPath = join(dir, 'lan-cert.pem');
  const keyPath = join(dir, 'lan-key.pem');
  try {
    const [cert, key] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')]);
    if (new Date(new X509Certificate(cert).validTo).getTime() > Date.now() + 7 * 86_400_000) {
      return { cert, key, fingerprint: certFingerprint(cert) };
    }
  } catch {
    // não existe ou está inválido: gera outro
  }
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Ponte (rede local)' }], {
    days: 825, keySize: 2048, algorithm: 'sha256',
  });
  await mkdir(dir, { recursive: true });
  await writeFile(keyPath, pems.private, { mode: 0o600 });
  await writeFile(certPath, pems.cert, { mode: 0o644 });
  return { cert: pems.cert, key: pems.private, fingerprint: certFingerprint(pems.cert) };
}

const ipToInt = (ip) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

// Endereços IPv4 desta máquina na rede (sem loopback), com o endereço de broadcast de cada uma.
export function localAddresses(interfaces = networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const broadcast = intToIp((ipToInt(a.address) | ~ipToInt(a.netmask)) >>> 0);
      out.push({ address: a.address, broadcast });
    }
  }
  return out;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
export function isValidAddress(value) {
  return typeof value === 'string' && (isIPv4(value) || HOSTNAME.test(value));
}

function parseDatagram(raw) {
  if (raw.length > MAX_DATAGRAM) return null;
  try {
    const msg = JSON.parse(raw.toString('utf8'));
    return msg && msg.v === 1 && typeof msg.t === 'string' ? msg : null;
  } catch {
    return null;
  }
}

// Responde a buscas por convites ativos neste computador. `getKey(id)` devolve a chave do
// convite ou null. IDs desconhecidos não recebem resposta (não revela quais existem).
export function createResponder({ port = LAN_PORT, getKey, servicePort, fingerprint, now = Date.now }) {
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  const limiter = createRateLimiter({ capacity: 20, refillPerSecond: 5, now });
  socket.on('message', (raw, rinfo) => {
    const q = parseDatagram(raw);
    if (!q || q.t !== 'q' || typeof q.id !== 'string' || !SESSION_ID_PATTERN.test(q.id)) return;
    if (typeof q.n !== 'string' || q.n.length < 16 || q.n.length > 64) return;
    if (!limiter.take(rinfo.address)) return;
    const key = getKey(q.id);
    if (!key) return;
    const fields = { id: q.id, nonce: q.n, port: servicePort(), fp: fingerprint };
    const reply = { v: 1, t: 'r', id: q.id, port: fields.port, fp: fingerprint, mac: proofFor(key, fields) };
    socket.send(Buffer.from(JSON.stringify(reply)), rinfo.port, rinfo.address);
  });
  const ready = new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, () => {
      socket.off('error', reject);
      socket.on('error', () => {});
      resolve();
    });
  });
  return { ready, close: () => new Promise((resolve) => socket.close(() => resolve())) };
}

// Procura o convite na rede. Devolve { host, port, fingerprint } ou null.
export async function discover({ sessionId, secret, address, port = LAN_PORT, timeoutMs = 3500 }) {
  const key = await deriveInviteKey(sessionId, secret);
  const nonce = randomBytes(18).toString('base64');
  const socket = createSocket('udp4');
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, resolve);
  });
  socket.setBroadcast(true);
  const targets = address ? [address] : ['255.255.255.255', ...localAddresses().map((a) => a.broadcast)];
  const query = Buffer.from(JSON.stringify({ v: 1, t: 'q', id: sessionId, n: nonce }));

  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(resend);
      socket.close();
      resolve(result);
    };
    socket.on('message', (raw, rinfo) => {
      const r = parseDatagram(raw);
      if (!r || r.t !== 'r' || r.id !== sessionId) return;
      if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535) return;
      if (typeof r.fp !== 'string' || r.fp.length > 64) return;
      if (!verifyProof(key, { id: sessionId, nonce, port: r.port, fp: r.fp }, r.mac)) return;
      finish({ host: rinfo.address, port: r.port, fingerprint: r.fp });
    });
    socket.on('error', () => {});
    const send = () => {
      for (const target of new Set(targets)) socket.send(query, port, target, () => {});
    };
    send();
    const resend = setInterval(send, 700);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}
