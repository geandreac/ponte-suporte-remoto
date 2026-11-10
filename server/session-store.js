// Estado das sessões no servidor de sinalização (em memória).
// Não conhece WebSocket: recebe comandos e devolve resultados, o que facilita os testes
// (o relógio é injetável).

import {
  emptyPermissions, mergeRequested, normalizeCapabilities, normalizePermissions, resolveGrant,
} from '../shared/permissions.js';
import { hashValue, randomSecret, randomSessionId, randomToken, safeEqualHash } from './crypto-utils.js';

export const END_REASONS = Object.freeze({
  HOST_ENDED: 'host_ended',
  TECH_ENDED: 'tech_ended',
  INVITE_EXPIRED: 'invite_expired',
  TOO_MANY_ATTEMPTS: 'too_many_attempts',
  HOST_TIMEOUT: 'host_timeout',
  TECH_TIMEOUT: 'tech_timeout',
  MAX_DURATION: 'max_duration',
});

export class SessionStore {
  #sessions = new Map();

  constructor(options = {}) {
    this.now = options.now ?? Date.now;
    this.inviteTtlMs = options.inviteTtlMs ?? 10 * 60_000;
    this.joinRequestTtlMs = options.joinRequestTtlMs ?? 2 * 60_000;
    this.maxFailedAttempts = options.maxFailedAttempts ?? 5;
    this.graceMs = options.graceMs ?? 30_000;
    this.maxSessionMs = options.maxSessionMs ?? 4 * 60 * 60_000;
    this.maxSessions = options.maxSessions ?? 1_000;
  }

  get size() {
    return this.#sessions.size;
  }

  get(id) {
    return this.#sessions.get(id) ?? null;
  }

  createSession({ hostName = '', capabilities } = {}) {
    if (this.#sessions.size >= this.maxSessions) return { ok: false, error: 'server_busy' };
    let id;
    do id = randomSessionId(); while (this.#sessions.has(id));
    const secret = randomSecret();
    const hostToken = randomToken();
    const t = this.now();
    const session = {
      id,
      hostName,
      capabilities: normalizeCapabilities(capabilities),
      status: 'waiting', // waiting -> pending -> active -> ended
      createdAt: t,
      inviteExpiresAt: t + this.inviteTtlMs,
      secretHash: hashValue(secret),
      hostTokenHash: hashValue(hostToken),
      techTokenHash: null,
      failedAttempts: 0,
      pendingRequest: null,
      techName: null,
      requested: emptyPermissions(),
      granted: emptyPermissions(),
      connectedAt: null,
      disconnectedAt: { host: null, tech: null },
      endReason: null,
    };
    this.#sessions.set(id, session);
    return { ok: true, session, secret, hostToken };
  }

  // Sessão sem supervisão: não há convite nem aprovação humana. A sessão nasce ativa, SEM
  // nenhuma permissão; quem libera é o computador, depois de verificar a senha (no próprio
  // computador, nunca aqui). O anfitrião ainda precisa se conectar com o token dentro do prazo.
  createUnattendedSession({ deviceName = '', capabilities, techName, requested }) {
    if (this.#sessions.size >= this.maxSessions) return { ok: false, error: 'server_busy' };
    let id;
    do id = randomSessionId(); while (this.#sessions.has(id));
    const hostToken = randomToken();
    const techToken = randomToken();
    const t = this.now();
    const session = {
      id,
      hostName: deviceName,
      capabilities: normalizeCapabilities(capabilities),
      status: 'active',
      unattended: true,
      createdAt: t,
      inviteExpiresAt: t,
      secretHash: null,
      hostTokenHash: hashValue(hostToken),
      techTokenHash: hashValue(techToken),
      failedAttempts: 0,
      pendingRequest: null,
      techName,
      requested: normalizePermissions(requested),
      granted: emptyPermissions(),
      connectedAt: t,
      disconnectedAt: { host: t, tech: null },
      endReason: null,
    };
    this.#sessions.set(id, session);
    return { ok: true, session, hostToken, techToken };
  }

  requestJoin({ sessionId, secret, name, requested }) {
    const s = this.#sessions.get(sessionId);
    const t = this.now();
    // Sessão inexistente, expirada ou já usada respondem igual a senha errada (não revela quais IDs existem).
    if (!s || !s.secretHash || t >= s.inviteExpiresAt) return { ok: false, error: 'invalid_credentials' };
    if (!safeEqualHash(hashValue(secret), s.secretHash)) {
      s.failedAttempts += 1;
      if (s.failedAttempts >= this.maxFailedAttempts) {
        this.#end(s, END_REASONS.TOO_MANY_ATTEMPTS);
        return { ok: false, error: 'invalid_credentials', locked: true, session: s };
      }
      return { ok: false, error: 'invalid_credentials' };
    }
    if (s.status !== 'waiting') return { ok: false, error: 'session_busy' };
    const request = {
      id: randomToken(12),
      name,
      requested: normalizePermissions(requested),
      createdAt: t,
      expiresAt: t + this.joinRequestTtlMs,
    };
    s.pendingRequest = request;
    s.status = 'pending';
    return { ok: true, session: s, request };
  }

  cancelRequest(sessionId, requestId) {
    const s = this.#sessions.get(sessionId);
    if (!s || s.status !== 'pending' || s.pendingRequest?.id !== requestId) return { ok: false };
    s.pendingRequest = null;
    s.status = 'waiting';
    return { ok: true, session: s };
  }

  respond({ sessionId, requestId, accept, granted }) {
    const s = this.#sessions.get(sessionId);
    if (!s || s.status !== 'pending' || s.pendingRequest?.id !== requestId) {
      return { ok: false, error: 'no_pending_request' };
    }
    const request = s.pendingRequest;
    s.pendingRequest = null;
    if (!accept) {
      s.status = 'waiting';
      return { ok: true, accepted: false, session: s, request };
    }
    const techToken = randomToken();
    s.status = 'active';
    s.secretHash = null; // convite de uso único
    s.techTokenHash = hashValue(techToken);
    s.techName = request.name;
    s.requested = request.requested;
    s.granted = resolveGrant({ requested: request.requested, granted, capabilities: s.capabilities });
    s.connectedAt = this.now();
    return { ok: true, accepted: true, session: s, request, techToken };
  }

  updatePermissions(sessionId, granted) {
    const s = this.#sessions.get(sessionId);
    if (!s || s.status !== 'active') return { ok: false, error: 'not_active' };
    s.granted = resolveGrant({ requested: s.requested, granted, capabilities: s.capabilities });
    return { ok: true, session: s, granted: s.granted };
  }

  requestPermissions(sessionId, requested) {
    const s = this.#sessions.get(sessionId);
    if (!s || s.status !== 'active') return { ok: false, error: 'not_active' };
    s.requested = mergeRequested(s.requested, requested);
    return { ok: true, session: s, requested: s.requested };
  }

  authenticate(sessionId, token) {
    const s = this.#sessions.get(sessionId);
    if (!s || typeof token !== 'string') return null;
    const h = hashValue(token);
    if (safeEqualHash(h, s.hostTokenHash)) return { session: s, role: 'host' };
    if (s.techTokenHash && safeEqualHash(h, s.techTokenHash)) return { session: s, role: 'tech' };
    return null;
  }

  markDisconnected(sessionId, role) {
    const s = this.#sessions.get(sessionId);
    if (s) s.disconnectedAt[role] = this.now();
  }

  markConnected(sessionId, role) {
    const s = this.#sessions.get(sessionId);
    if (s) s.disconnectedAt[role] = null;
  }

  end(sessionId, reason) {
    const s = this.#sessions.get(sessionId);
    if (!s) return { ok: false };
    this.#end(s, reason);
    return { ok: true, session: s };
  }

  #end(s, reason) {
    s.status = 'ended';
    s.endReason = reason;
    s.secretHash = null;
    s.hostTokenHash = null;
    s.techTokenHash = null;
    s.pendingRequest = null;
    this.#sessions.delete(s.id);
  }

  // Aplica prazos. Devolve eventos para a camada de rede notificar os participantes.
  sweep() {
    const t = this.now();
    const events = [];
    for (const s of [...this.#sessions.values()]) {
      if (s.status === 'pending' && t >= s.pendingRequest.expiresAt) {
        events.push({ type: 'request_expired', session: s, request: s.pendingRequest });
        s.pendingRequest = null;
        s.status = 'waiting';
      }
      let reason = null;
      if (s.status === 'waiting' && t >= s.inviteExpiresAt) reason = END_REASONS.INVITE_EXPIRED;
      else if (s.status === 'active' && t - s.connectedAt >= this.maxSessionMs) reason = END_REASONS.MAX_DURATION;
      else if (s.disconnectedAt.host !== null && t - s.disconnectedAt.host >= this.graceMs) reason = END_REASONS.HOST_TIMEOUT;
      else if (s.disconnectedAt.tech !== null && t - s.disconnectedAt.tech >= this.graceMs) reason = END_REASONS.TECH_TIMEOUT;
      if (reason) {
        this.#end(s, reason);
        events.push({ type: 'ended', session: s, reason });
      }
    }
    return events;
  }
}
