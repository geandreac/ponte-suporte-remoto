// Servidor de sinalização WebSocket. Ele só intermedeia o convite, o consentimento e a troca
// de SDP/ICE entre os dois participantes já pareados. Tela, chat e arquivos trafegam
// direto entre os navegadores (WebRTC), cifrados ponta a ponta — nunca passam por aqui.

import { WebSocket, WebSocketServer } from 'ws';
import { listGranted } from '../shared/permissions.js';
import { validateClientMessage } from '../shared/protocol.js';
import { END_REASONS } from './session-store.js';
import { createRateLimiter } from './rate-limiter.js';

const MAX_PAYLOAD = 64 * 1024;
const HEARTBEAT_MS = 15_000;
const SWEEP_MS = 1_000;

// Limites por IP. `join` é o mais importante: junto com o bloqueio por sessão,
// torna inviável adivinhar o código de acesso por força bruta.
export const DEFAULT_RATE_LIMITS = Object.freeze({
  upgrade: { capacity: 30, refillPerSecond: 0.5 },
  create: { capacity: 5, refillPerSecond: 1 / 60 },
  join: { capacity: 10, refillPerSecond: 1 / 30 },
  resume: { capacity: 20, refillPerSecond: 0.2 },
});

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function isOriginAllowed(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (allowedOrigins.length) return allowedOrigins.includes(origin);
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function attachSignaling({ server, store, ice, audit, config, now = Date.now }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const rooms = new Map(); // sessionId -> { host, tech, pending }
  const conns = new Set();

  const limitSpec = { ...DEFAULT_RATE_LIMITS, ...config.rateLimits };
  const limits = Object.fromEntries(
    Object.entries(limitSpec).map(([name, spec]) => [name, createRateLimiter({ ...spec, now })]),
  );

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const ip = clientIp(req, config.trustProxy);
    const reject = (status) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (pathname !== '/ws') return reject('404 Not Found');
    if (!isOriginAllowed(req, config.allowedOrigins)) {
      audit.log('ws_rejected_origin', { ip });
      return reject('403 Forbidden');
    }
    if (!limits.upgrade.take(ip)) return reject('429 Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, ip));
  });

  const send = (conn, type, data = {}) => {
    if (conn?.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify({ type, ...data }));
  };
  const sendError = (conn, code) => send(conn, 'error', { code });
  const iceFor = (sessionId, role) => ({
    iceServers: ice.forParticipant(`${sessionId}-${role}`),
    iceTransportPolicy: config.iceTransportPolicy,
  });

  const detach = (conn) => {
    conn.role = null;
    conn.sessionId = null;
    conn.requestId = null;
  };

  function closeRoom(sessionId, reason) {
    const room = rooms.get(sessionId);
    if (!room) return;
    rooms.delete(sessionId);
    for (const conn of [room.host, room.tech, room.pending]) {
      if (!conn) continue;
      if (conn === room.pending) send(conn, 'join-rejected', { reason });
      else send(conn, 'session-ended', { reason });
      detach(conn);
    }
    audit.log('session_ended', { sessionId, reason });
  }

  const handlers = {
    'host:create'(conn, msg) {
      if (conn.role) return sendError(conn, 'already_in_session');
      if (!limits.create.take(conn.ip)) return sendError(conn, 'rate_limited');
      const result = store.createSession({ hostName: msg.name, capabilities: msg.capabilities });
      if (!result.ok) return sendError(conn, result.error);
      const { session, secret, hostToken } = result;
      conn.role = 'host';
      conn.sessionId = session.id;
      rooms.set(session.id, { host: conn, tech: null, pending: null });
      send(conn, 'session-created', {
        sessionId: session.id,
        secret,
        hostToken,
        inviteExpiresAt: session.inviteExpiresAt,
        ...iceFor(session.id, 'host'),
      });
      audit.log('session_created', { sessionId: session.id, ip: conn.ip, capabilities: session.capabilities });
    },

    'tech:join'(conn, msg) {
      if (conn.role) return sendError(conn, 'already_in_session');
      if (!limits.join.take(conn.ip)) {
        audit.log('join_rate_limited', { ip: conn.ip });
        return sendError(conn, 'rate_limited');
      }
      const result = store.requestJoin(msg);
      if (!result.ok) {
        audit.log('join_failed', { sessionId: msg.sessionId, ip: conn.ip, error: result.error });
        if (result.locked) closeRoom(msg.sessionId, END_REASONS.TOO_MANY_ATTEMPTS);
        return sendError(conn, result.error);
      }
      const { session, request } = result;
      const room = rooms.get(session.id);
      conn.role = 'pending';
      conn.sessionId = session.id;
      conn.requestId = request.id;
      room.pending = conn;
      send(room.host, 'join-request', {
        requestId: request.id, name: request.name, requested: request.requested, expiresAt: request.expiresAt,
      });
      send(conn, 'join-pending', { expiresAt: request.expiresAt, hostName: session.hostName });
      audit.log('join_requested', { sessionId: session.id, ip: conn.ip, requested: listGranted(request.requested) });
    },

    'host:respond'(conn, msg) {
      if (conn.role !== 'host') return sendError(conn, 'not_allowed');
      const result = store.respond({ sessionId: conn.sessionId, ...msg });
      if (!result.ok) return sendError(conn, result.error);
      const room = rooms.get(conn.sessionId);
      const tech = room.pending;
      room.pending = null;
      if (!result.accepted) {
        send(tech, 'join-rejected', { reason: 'declined' });
        if (tech) detach(tech);
        audit.log('join_rejected', { sessionId: conn.sessionId });
        return;
      }
      const { session, techToken } = result;
      if (!tech) {
        // O solicitante caiu enquanto o anfitrião decidia: encerra para não deixar sessão órfã.
        store.end(session.id, END_REASONS.TECH_TIMEOUT);
        return closeRoom(session.id, END_REASONS.TECH_TIMEOUT);
      }
      tech.role = 'tech';
      tech.requestId = null;
      room.tech = tech;
      send(tech, 'join-accepted', {
        sessionId: session.id,
        token: techToken,
        hostName: session.hostName,
        granted: session.granted,
        requested: session.requested,
        capabilities: session.capabilities,
        ...iceFor(session.id, 'tech'),
      });
      send(conn, 'peer-joined', { name: session.techName, granted: session.granted, requested: session.requested });
      audit.log('join_accepted', { sessionId: session.id, granted: listGranted(session.granted) });
    },

    signal(conn, msg) {
      if (conn.role !== 'host' && conn.role !== 'tech') return sendError(conn, 'not_allowed');
      const room = rooms.get(conn.sessionId);
      const peer = conn.role === 'host' ? room?.tech : room?.host;
      if (!peer) return sendError(conn, 'peer_unavailable');
      send(peer, 'signal', { payload: msg.payload });
    },

    'permissions:update'(conn, msg) {
      if (conn.role !== 'host') return sendError(conn, 'not_allowed');
      const result = store.updatePermissions(conn.sessionId, msg.granted);
      if (!result.ok) return sendError(conn, result.error);
      const room = rooms.get(conn.sessionId);
      for (const c of [room.host, room.tech]) send(c, 'permissions', { granted: result.granted, requested: result.session.requested });
      audit.log('permissions_changed', { sessionId: conn.sessionId, granted: listGranted(result.granted) });
    },

    'permissions:request'(conn, msg) {
      if (conn.role !== 'tech') return sendError(conn, 'not_allowed');
      const result = store.requestPermissions(conn.sessionId, msg.requested);
      if (!result.ok) return sendError(conn, result.error);
      const room = rooms.get(conn.sessionId);
      send(room.host, 'permissions-request', { requested: result.requested, asked: msg.requested });
      audit.log('permissions_requested', { sessionId: conn.sessionId, asked: listGranted(msg.requested) });
    },

    'session:end'(conn) {
      if (conn.role === 'pending') {
        const room = rooms.get(conn.sessionId);
        if (store.cancelRequest(conn.sessionId, conn.requestId).ok && room) {
          room.pending = null;
          send(room.host, 'join-request-cancelled', { requestId: conn.requestId });
        }
        detach(conn);
        return;
      }
      if (conn.role !== 'host' && conn.role !== 'tech') return sendError(conn, 'not_allowed');
      const reason = conn.role === 'host' ? END_REASONS.HOST_ENDED : END_REASONS.TECH_ENDED;
      const { sessionId } = conn;
      store.end(sessionId, reason);
      closeRoom(sessionId, reason);
    },

    'session:resume'(conn, msg) {
      if (conn.role) return sendError(conn, 'already_in_session');
      if (!limits.resume.take(conn.ip)) return sendError(conn, 'rate_limited');
      const auth = store.authenticate(msg.sessionId, msg.token);
      const room = rooms.get(msg.sessionId);
      if (!auth || !room) {
        audit.log('resume_failed', { sessionId: msg.sessionId, ip: conn.ip });
        return send(conn, 'resume-failed', { reason: 'invalid_session' });
      }
      const { session, role } = auth;
      const previous = room[role];
      if (previous && previous !== conn) {
        detach(previous);
        previous.ws.close(4000, 'replaced');
      }
      conn.role = role;
      conn.sessionId = session.id;
      room[role] = conn;
      store.markConnected(session.id, role);
      const peer = role === 'host' ? room.tech : room.host;
      send(conn, 'resumed', {
        role,
        status: session.status,
        granted: session.granted,
        requested: session.requested,
        peerConnected: Boolean(peer),
        ...iceFor(session.id, role),
      });
      send(peer, 'peer-status', { status: 'connected' });
      audit.log('session_resumed', { sessionId: session.id, role, ip: conn.ip });
    },
  };

  wss.on('connection', (ws, req, ip) => {
    const conn = {
      ws, ip, role: null, sessionId: null, requestId: null, alive: true,
      limiter: createRateLimiter({ capacity: 200, refillPerSecond: 50, now }),
    };
    conns.add(conn);
    ws.on('pong', () => { conn.alive = true; });

    ws.on('message', (raw, isBinary) => {
      if (isBinary || !conn.limiter.take('msg')) return sendError(conn, 'rate_limited');
      let parsed;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return sendError(conn, 'invalid_message');
      }
      const result = validateClientMessage(parsed);
      if (!result.ok) return sendError(conn, result.error);
      handlers[result.value.type](conn, result.value);
    });

    ws.on('close', () => {
      conns.delete(conn);
      const { role, sessionId } = conn;
      const room = sessionId ? rooms.get(sessionId) : null;
      if (!room) return;
      if (role === 'pending') {
        if (store.cancelRequest(sessionId, conn.requestId).ok) {
          room.pending = null;
          send(room.host, 'join-request-cancelled', { requestId: conn.requestId });
        }
      } else if ((role === 'host' || role === 'tech') && room[role] === conn) {
        room[role] = null;
        store.markDisconnected(sessionId, role);
        send(role === 'host' ? room.tech : room.host, 'peer-status', { status: 'disconnected' });
      }
    });

    send(conn, 'hello', { version: 1 });
  });

  // Detecta conexões mortas (rede caiu sem fechar o socket) para acionar o prazo de reconexão.
  const heartbeat = setInterval(() => {
    for (const conn of conns) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }, HEARTBEAT_MS);

  const sweeper = setInterval(() => {
    for (const ev of store.sweep()) {
      if (ev.type === 'request_expired') {
        const room = rooms.get(ev.session.id);
        if (!room) continue;
        send(room.host, 'join-request-expired', { requestId: ev.request.id });
        if (room.pending) {
          send(room.pending, 'join-rejected', { reason: 'request_expired' });
          detach(room.pending);
          room.pending = null;
        }
      } else if (ev.type === 'ended') {
        closeRoom(ev.session.id, ev.reason);
      }
    }
    for (const l of Object.values(limits)) l.prune();
  }, SWEEP_MS);

  return {
    wss,
    close() {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
