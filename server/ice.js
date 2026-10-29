// Servidores ICE entregues apenas a participantes autenticados.
// TURN usa credenciais temporárias no padrão "TURN REST API" (compatível com coturn
// `use-auth-secret` + `static-auth-secret`): usuário = "<expira>:<rótulo>",
// senha = base64(HMAC-SHA1(segredo, usuário)). O segredo nunca sai do servidor.

import { createHmac } from 'node:crypto';

export function turnCredential(secret, username) {
  return createHmac('sha1', secret).update(username).digest('base64');
}

export function createIceProvider({ stunUrls = [], turnUrls = [], turnSecret = '', turnTtlSec = 3600, now = Date.now } = {}) {
  return {
    hasTurn: turnUrls.length > 0 && Boolean(turnSecret),
    forParticipant(label) {
      const servers = [];
      if (stunUrls.length) servers.push({ urls: stunUrls });
      if (turnUrls.length && turnSecret) {
        const expiry = Math.floor(now() / 1000) + turnTtlSec;
        const username = `${expiry}:${label}`;
        servers.push({ urls: turnUrls, username, credential: turnCredential(turnSecret, username) });
      }
      return servers;
    },
  };
}
