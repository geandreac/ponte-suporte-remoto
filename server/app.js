import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuditLog } from './audit-log.js';
import { createIceProvider } from './ice.js';
import { SessionStore } from './session-store.js';
import { attachSignaling } from './signaling.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOUNTS = [
  { prefix: '/shared/', dir: join(ROOT, 'shared') },
  { prefix: '/', dir: join(ROOT, 'public') },
];

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

export function securityHeaders({ tls, connectSrc = ["'self'"] }) {
  const headers = {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      `connect-src ${connectSrc.join(' ')}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'display-capture=(self), camera=(), microphone=(), geolocation=(), payment=()',
    'X-Frame-Options': 'DENY',
  };
  if (tls) headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}

export function resolveStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (decoded === '/') decoded = '/index.html';
  for (const { prefix, dir } of MOUNTS) {
    if (!decoded.startsWith(prefix)) continue;
    const full = normalize(join(dir, decoded.slice(prefix.length)));
    return full.startsWith(dir + sep) ? full : null;
  }
  return null;
}

function createRequestHandler({ tls }) {
  const baseHeaders = securityHeaders({ tls });
  return async (req, res) => {
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, { ...baseHeaders, ...headers });
      res.end(body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname === '/healthz') return reply(200, 'ok', { 'Content-Type': 'text/plain' });
    const file = resolveStaticPath(pathname);
    const type = file && MIME[extname(file)];
    if (!type) return reply(404, 'Not Found', { 'Content-Type': 'text/plain' });
    try {
      const body = await readFile(file);
      reply(200, req.method === 'HEAD' ? undefined : body, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    } catch {
      reply(404, 'Not Found', { 'Content-Type': 'text/plain' });
    }
  };
}

export function createApp(config, { now = Date.now, auditWrite } = {}) {
  const tls = Boolean(config.tlsCertFile && config.tlsKeyFile);
  const handler = createRequestHandler({ tls });
  const server = tls
    ? createHttpsServer({ cert: readFileSync(config.tlsCertFile), key: readFileSync(config.tlsKeyFile) }, handler)
    : createHttpServer(handler);

  const store = new SessionStore({
    now,
    inviteTtlMs: config.inviteTtlMs,
    joinRequestTtlMs: config.joinRequestTtlMs,
    graceMs: config.graceMs,
    maxSessionMs: config.maxSessionMs,
    maxFailedAttempts: config.maxFailedAttempts,
  });
  const audit = createAuditLog({ write: auditWrite, file: config.auditLogFile, now });
  const ice = createIceProvider({ ...config, now });
  const signaling = attachSignaling({ server, store, ice, audit, config, now });

  return {
    server,
    store,
    signaling,
    tls,
    ice,
    listen() {
      return new Promise((resolve) => server.listen(config.port, config.host, () => resolve(server.address())));
    },
    close() {
      signaling.close();
      audit.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
