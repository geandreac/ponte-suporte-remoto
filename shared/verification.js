// Código de verificação da conexão.
//
// O WebRTC cifra mídia e dados ponta a ponta (DTLS-SRTP) com certificados cujas impressões
// digitais trafegam no SDP. Quem controla o servidor de sinalização poderia trocar o SDP e
// se colocar no meio. Os dois lados calculam este código a partir das impressões digitais
// que realmente negociaram; se os códigos ditos por telefone forem iguais, não há
// intermediário. É uma checagem leve, não um protocolo formal de SAS com compromisso (ZRTP).

export function extractFingerprints(sdp) {
  if (typeof sdp !== 'string') return [];
  const found = [...sdp.matchAll(/^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/gm)]
    .map((m) => `${m[1].toLowerCase()} ${m[2].toUpperCase()}`);
  return [...new Set(found)].sort();
}

export async function computeVerificationCode(sdpA, sdpB, subtle = globalThis.crypto?.subtle) {
  const a = extractFingerprints(sdpA);
  const b = extractFingerprints(sdpB);
  if (!a.length || !b.length || !subtle) return null;
  // Ordena os dois lados para que ambos os pares cheguem ao mesmo valor.
  const input = [a.join(','), b.join(',')].sort().join('|');
  const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(input)));
  const n = new DataView(digest.buffer).getUint32(0) % 100_000_000;
  const code = String(n).padStart(8, '0');
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}
