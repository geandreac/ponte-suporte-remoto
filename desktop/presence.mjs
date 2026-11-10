// Presença do computador com acesso sem supervisão num servidor de conexão.
// Mantém um WebSocket aberto, prova a posse da chave do computador a cada conexão (assinando o
// desafio do servidor) e repassa os pedidos de sessão recebidos. Reconecta sozinho.

import WebSocket from 'ws';

const BACKOFF_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
const KEEPALIVE_MS = 4 * 60_000;

export class DevicePresence {
  #url;
  #store;
  #name;
  #capabilities;
  #onIncoming;
  #onStatus;
  #ws = null;
  #attempt = 0;
  #stopped = false;
  #retry = null;
  #keepalive = null;
  status = 'offline';

  constructor({ url, store, name, capabilities, onIncoming, onStatus = () => {} }) {
    this.#url = url;
    this.#store = store;
    this.#name = name;
    this.#capabilities = capabilities;
    this.#onIncoming = onIncoming;
    this.#onStatus = onStatus;
  }

  get url() {
    return this.#url;
  }

  #setStatus(status) {
    this.status = status;
    this.#onStatus(status);
  }

  start() {
    this.#stopped = false;
    const ws = new WebSocket(this.#url, { headers: { origin: 'ponte://app' } });
    this.#ws = ws;
    this.#setStatus('connecting');
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'hello' && typeof msg.nonce === 'string') {
        const signature = this.#store.signRegistration(msg.nonce);
        if (!signature) return ws.close();
        ws.send(JSON.stringify({
          type: 'device:register', deviceId: this.#store.deviceId, publicKey: this.#store.publicKey,
          signature, name: this.#name, capabilities: this.#capabilities,
        }));
      } else if (msg.type === 'device-registered') {
        this.#attempt = 0;
        this.#setStatus('online');
        clearInterval(this.#keepalive);
        this.#keepalive = setInterval(() => ws.readyState === 1 && ws.send('{"type":"keepalive"}'), KEEPALIVE_MS);
      } else if (msg.type === 'unattended:incoming') {
        this.#onIncoming({ ...msg, url: this.#url });
      } else if (msg.type === 'error' && msg.code === 'invalid_device') {
        this.#setStatus('rejected');
      }
    });
    ws.on('close', () => {
      clearInterval(this.#keepalive);
      if (this.#ws !== ws || this.#stopped) return;
      this.#setStatus('offline');
      const delay = BACKOFF_MS[Math.min(this.#attempt++, BACKOFF_MS.length - 1)];
      this.#retry = setTimeout(() => this.start(), delay);
    });
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#retry);
    clearInterval(this.#keepalive);
    this.#ws?.close();
    this.#ws = null;
    this.#setStatus('offline');
  }
}
