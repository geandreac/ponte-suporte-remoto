const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const int = (v, fallback) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function loadConfig(env = process.env) {
  return {
    // Por padrão escuta só na máquina local. Expor na rede é uma decisão explícita (HOST=0.0.0.0 + TLS/proxy).
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 8080),
    tlsCertFile: env.TLS_CERT_FILE || '',
    tlsKeyFile: env.TLS_KEY_FILE || '',
    trustProxy: env.TRUST_PROXY === '1',
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    stunUrls: list(env.STUN_URLS ?? 'stun:stun.l.google.com:19302'),
    turnUrls: list(env.TURN_URLS),
    turnSecret: env.TURN_SECRET || '',
    turnTtlSec: int(env.TURN_TTL_SECONDS, 3600),
    iceTransportPolicy: env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all',
    inviteTtlMs: int(env.INVITE_TTL_SECONDS, 600) * 1000,
    joinRequestTtlMs: int(env.JOIN_REQUEST_TTL_SECONDS, 120) * 1000,
    graceMs: int(env.RECONNECT_GRACE_SECONDS, 30) * 1000,
    maxSessionMs: int(env.MAX_SESSION_MINUTES, 240) * 60_000,
    maxFailedAttempts: int(env.MAX_FAILED_ATTEMPTS, 5),
    auditLogFile: env.AUDIT_LOG_FILE || '',
  };
}
