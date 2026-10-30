// Conexão WebSocket com o servidor de sinalização, com reconexão automática.
// Quando há sessão em andamento, a primeira mensagem após reconectar é o pedido de retomada.
//
// Servidores gratuitos (ex.: Render) "dormem" sem tráfego e levam até ~1 minuto para acordar:
// - enquanto conectado, envia um sinal leve periódico (keepalive) para o servidor não dormir;
// - no primeiro contato, se o servidor não responder, continua tentando por até 75 s
//   (estado "waking") em vez de falhar na hora.

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 10000, 10000];
const OPEN = 1;

export class SignalingClient extends EventTarget {
  #url;
  #ws = null;
  #resume = null;
  #attempt = 0;
  #closedByUser = false;
  #retryTimer = null;
  #keepaliveTimer = null;
  #options;
  status = 'offline';

  constructor(url, options = {}) {
    super();
    this.#url = url;
    this.#options = {
      keepaliveMs: 4 * 60_000,
      wakeTimeoutMs: 75_000,
      wakeRetryMs: 3_000,
      createSocket: (u) => new WebSocket(u),
      ...options,
    };
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.#emit('status', status);
  }

  connect() {
    this.#closedByUser = false;
    clearTimeout(this.#retryTimer);
    return new Promise((resolve, reject) => {
      const ws = this.#options.createSocket(this.#url);
      this.#ws = ws;
      this.#setStatus(this.#attempt ? 'reconnecting' : 'connecting');
      let opened = false;

      ws.addEventListener('open', () => {
        opened = true;
        this.#attempt = 0;
        if (this.#resume) this.send('session:resume', this.#resume);
        this.#setStatus('online');
        clearInterval(this.#keepaliveTimer);
        this.#keepaliveTimer = setInterval(() => this.send('keepalive'), this.#options.keepaliveMs);
        resolve();
      });

      // Falhas de conexão chegam também como 'close', que é onde são tratadas.
      ws.addEventListener('error', () => {});

      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg && typeof msg.type === 'string') this.#emit('message', msg);
      });

      ws.addEventListener('close', () => {
        if (this.#ws !== ws) return;
        this.#ws = null;
        clearInterval(this.#keepaliveTimer);
        if (!opened) reject(new Error('signaling_unreachable'));
        if (this.#closedByUser) return this.#setStatus('offline');
        // Sem sessão não há o que retomar: só reconecta quando for necessário de novo.
        if (!this.#resume) return this.#setStatus('offline');
        this.#scheduleRetry();
      });
    });
  }

  #scheduleRetry() {
    if (this.#attempt >= BACKOFF_MS.length) {
      this.#setStatus('offline');
      this.#emit('gave-up');
      return;
    }
    this.#setStatus('reconnecting');
    const delay = BACKOFF_MS[this.#attempt++];
    this.#retryTimer = setTimeout(() => this.connect().catch(() => {}), delay);
  }

  async ensureConnected() {
    if (this.#ws?.readyState === OPEN) return;
    this.#attempt = 0;
    const deadline = Date.now() + this.#options.wakeTimeoutMs;
    for (;;) {
      try {
        await this.connect();
        return;
      } catch (err) {
        if (this.#closedByUser || Date.now() + this.#options.wakeRetryMs > deadline) {
          this.#setStatus('offline');
          throw err;
        }
        // Servidor provavelmente em repouso: avisa e tenta de novo.
        this.#setStatus('waking');
        await new Promise((resolve) => { this.#retryTimer = setTimeout(resolve, this.#options.wakeRetryMs); });
        if (this.#closedByUser) throw err;
      }
    }
  }

  send(type, data = {}) {
    if (this.#ws?.readyState !== OPEN) return false;
    this.#ws.send(JSON.stringify({ type, ...data }));
    return true;
  }

  setResume(resume) {
    this.#resume = resume;
  }

  clearResume() {
    this.#resume = null;
  }

  close() {
    this.#closedByUser = true;
    this.#resume = null;
    clearTimeout(this.#retryTimer);
    clearInterval(this.#keepaliveTimer);
    this.#ws?.close();
    this.#ws = null;
    this.#setStatus('offline');
  }
}
