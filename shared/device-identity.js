// Identidade de computadores com acesso sem supervisão.
//
// Cada computador gera um par de chaves Ed25519 na ativação. O ID exibido (9 dígitos) é derivado
// da chave pública, então só quem tem a chave privada consegue se registrar com aquele ID.
// O registro prova a posse da chave assinando um desafio único enviado pelo servidor.

export const DEVICE_SIGNATURE_PREFIX = 'ponte-device-v1';

// sha256(chave pública DER) -> número de 9 dígitos (100000000–999999999).
export function deviceIdFromDigest(digest) {
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const n = view.getBigUint64(0) % 900_000_000n;
  return String(n + 100_000_000n);
}

export function registrationPayload(nonce, deviceId) {
  return `${DEVICE_SIGNATURE_PREFIX}|${nonce}|${deviceId}`;
}
