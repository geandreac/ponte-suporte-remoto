// Verificação, no servidor, do registro de computadores (ver shared/device-identity.js).

import { createHash, createPublicKey, verify } from 'node:crypto';
import { deviceIdFromDigest, registrationPayload } from '../shared/device-identity.js';

export function deviceIdForPublicKey(publicKeyBase64) {
  return deviceIdFromDigest(createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest());
}

// true só se: a chave é Ed25519 válida, o ID corresponde a ela e a assinatura cobre o desafio.
export function verifyRegistration({ deviceId, publicKey, signature, nonce }) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    if (deviceIdForPublicKey(publicKey) !== deviceId) return false;
    return verify(null, Buffer.from(registrationPayload(nonce, deviceId)), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
