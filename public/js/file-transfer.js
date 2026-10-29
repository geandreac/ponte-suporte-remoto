// Transferência de arquivos pelo canal de dados, com consentimento e verificação.
//
// 1. Quem envia valida tipo/tamanho/assinatura, calcula SHA-256 e manda uma oferta.
// 2. Quem recebe valida a oferta de novo (não confia no outro lado) e decide aceitar ou recusar.
// 3. Só após o aceite os blocos binários são enviados; blocos fora desse estado são descartados.
// 4. No fim, quem recebe confere tamanho, hash e assinatura antes de liberar o download.
// Um envio e um recebimento por vez. Não depende do DOM (testável no Node).

import { validateFileOffer, verifyFileSignature } from '../../shared/file-policy.js';

export const CHUNK_SIZE = 16 * 1024;
const HIGH_WATER = 1024 * 1024;

export class TransferError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const randomId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 20);

export class FileTransfer extends EventTarget {
  #link;
  #can;
  #outgoing = null;
  #incoming = null;

  // `link`: objeto com sendJson, sendBinary e waitForDrain (PeerLink ou um dublê de teste).
  // `can`: função que diz se a permissão de arquivos está concedida neste momento.
  constructor({ link, can }) {
    super();
    this.#link = link;
    this.#can = can;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get busy() {
    return { outgoing: Boolean(this.#outgoing), incoming: Boolean(this.#incoming) };
  }

  async send(file) {
    if (!this.#can()) throw new TransferError('not_permitted');
    if (this.#outgoing) throw new TransferError('busy');
    const check = validateFileOffer({ name: file.name, size: file.size, mime: file.type });
    if (!check.ok) throw new TransferError(check.error);
    const buffer = await file.arrayBuffer();
    if (!verifyFileSignature(check.value.extension, new Uint8Array(buffer))) throw new TransferError('content_mismatch');
    const out = {
      id: randomId(), name: check.value.name, size: buffer.byteLength, buffer, status: 'offered',
    };
    this.#outgoing = out;
    const sha256 = await sha256Hex(buffer);
    this.#link.sendJson({ type: 'file-offer', id: out.id, name: out.name, size: out.size, mime: check.value.mime, sha256 });
    this.#emit('outgoing', { id: out.id, name: out.name, size: out.size, status: 'offered' });
    return out.id;
  }

  async #stream(out) {
    try {
      for (let offset = 0; offset < out.size; offset += CHUNK_SIZE) {
        if (out.status !== 'sending') return;
        if (!this.#can()) return this.#abortOutgoing('permission_revoked', true);
        await this.#link.waitForDrain(HIGH_WATER);
        this.#link.sendBinary(out.buffer.slice(offset, offset + CHUNK_SIZE));
        this.#emit('progress', { id: out.id, direction: 'out', sent: Math.min(offset + CHUNK_SIZE, out.size), size: out.size });
      }
      this.#link.sendJson({ type: 'file-complete', id: out.id });
      this.#outgoing = null;
      this.#emit('outgoing', { id: out.id, name: out.name, size: out.size, status: 'sent' });
    } catch {
      this.#abortOutgoing('channel_closed', false);
    }
  }

  #abortOutgoing(reason, notify) {
    const out = this.#outgoing;
    if (!out) return;
    this.#outgoing = null;
    out.status = 'aborted';
    if (notify) this.#link.sendJson({ type: 'file-cancel', id: out.id });
    this.#emit('outgoing', { id: out.id, name: out.name, size: out.size, status: 'failed', reason });
  }

  #failIncoming(reason, notify) {
    const inc = this.#incoming;
    if (!inc) return;
    this.#incoming = null;
    if (notify) this.#link.sendJson({ type: 'file-cancel', id: inc.id });
    this.#emit('incoming', { id: inc.id, name: inc.name, size: inc.size, status: 'failed', reason });
  }

  accept(id) {
    const inc = this.#incoming;
    if (!inc || inc.id !== id || inc.status !== 'awaiting') return false;
    if (!this.#can()) {
      this.reject(id, 'not_permitted');
      return false;
    }
    inc.status = 'receiving';
    this.#link.sendJson({ type: 'file-response', id, accept: true });
    this.#emit('incoming', { id, name: inc.name, size: inc.size, status: 'receiving' });
    return true;
  }

  reject(id, reason = 'rejected') {
    const inc = this.#incoming;
    if (!inc || inc.id !== id) return;
    this.#incoming = null;
    this.#link.sendJson({ type: 'file-response', id, accept: false, reason });
    this.#emit('incoming', { id, name: inc.name, size: inc.size, status: 'rejected', reason });
  }

  cancelAll(reason = 'cancelled') {
    this.#abortOutgoing(reason, true);
    this.#failIncoming(reason, true);
  }

  // Mensagens JSON já validadas pelo protocolo e autorizadas pela política da sessão.
  async handleMessage(msg) {
    switch (msg.type) {
      case 'file-offer': {
        if (!this.#can()) return this.#link.sendJson({ type: 'file-response', id: msg.id, accept: false, reason: 'not_permitted' });
        if (this.#incoming) return this.#link.sendJson({ type: 'file-response', id: msg.id, accept: false, reason: 'busy' });
        const check = validateFileOffer(msg);
        if (!check.ok) {
          this.#emit('incoming', { id: msg.id, name: msg.name, size: msg.size, status: 'blocked', reason: check.error });
          return this.#link.sendJson({ type: 'file-response', id: msg.id, accept: false, reason: check.error });
        }
        this.#incoming = {
          id: msg.id, name: check.value.name, extension: check.value.extension, mime: check.value.mime,
          size: msg.size, sha256: msg.sha256, status: 'awaiting', chunks: [], received: 0,
        };
        this.#emit('incoming', { id: msg.id, name: check.value.name, size: msg.size, status: 'offered' });
        return;
      }
      case 'file-response': {
        const out = this.#outgoing;
        if (!out || out.id !== msg.id || out.status !== 'offered') return;
        if (!msg.accept) {
          this.#outgoing = null;
          this.#emit('outgoing', { id: out.id, name: out.name, size: out.size, status: 'rejected', reason: msg.reason || 'rejected' });
          return;
        }
        out.status = 'sending';
        this.#emit('outgoing', { id: out.id, name: out.name, size: out.size, status: 'sending' });
        this.#stream(out);
        return;
      }
      case 'file-complete': {
        const inc = this.#incoming;
        if (!inc || inc.id !== msg.id || inc.status !== 'receiving') return;
        this.#incoming = null;
        if (inc.received !== inc.size) return this.#emit('incoming', { id: inc.id, name: inc.name, size: inc.size, status: 'failed', reason: 'integrity' });
        const blob = new Blob(inc.chunks, { type: inc.mime });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const hashOk = (await sha256Hex(bytes)) === inc.sha256;
        if (!hashOk || !verifyFileSignature(inc.extension, bytes)) {
          return this.#emit('incoming', { id: inc.id, name: inc.name, size: inc.size, status: 'failed', reason: hashOk ? 'content_mismatch' : 'integrity' });
        }
        this.#emit('incoming', { id: inc.id, name: inc.name, size: inc.size, status: 'received', blob });
        return;
      }
      case 'file-cancel':
        if (this.#outgoing?.id === msg.id) this.#abortOutgoing('cancelled', false);
        if (this.#incoming?.id === msg.id) this.#failIncoming('cancelled', false);
        return;
      default:
    }
  }

  handleBinary(buffer) {
    const inc = this.#incoming;
    // Bloco sem transferência aceita: o outro lado não respeitou o protocolo. Descarta.
    if (!inc || inc.status !== 'receiving') return;
    if (!this.#can()) return this.#failIncoming('permission_revoked', true);
    if (inc.received + buffer.byteLength > inc.size) return this.#failIncoming('integrity', true);
    inc.chunks.push(buffer);
    inc.received += buffer.byteLength;
    this.#emit('progress', { id: inc.id, direction: 'in', sent: inc.received, size: inc.size });
  }
}
