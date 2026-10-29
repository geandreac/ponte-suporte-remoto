// Conexão WebSocket com o servidor de sinalização, com reconexão automática.
// Quando há sessão em andamento, a primeira mensagem após reconectar é o pedido de retomada.

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 8000, 8000];

export class SignalingClient extends EventTarget {
  #url;
  #ws = null;
  #resume = null;
  #attempt = 0;
  #closedByUser = false;
  #retryTimer = null;
  status = 'offline';

  constructor(url) {
    super();
    this.#url = url;
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
      const ws = new WebSocket(this.#url);
      this.#ws = ws;
      this.#setStatus(this.#attempt ? 'reconnecting' : 'connecting');
      let opened = false;

      ws.addEventListener('open', () => {
        opened = true;
        this.#attempt = 0;
        if (this.#resume) this.send('session:resume', this.#resume);
        this.#setStatus('online');
        resolve();
      });

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
    if (this.#ws?.readyState === WebSocket.OPEN) return;
    this.#attempt = 0;
    await this.connect();
  }

  send(type, data = {}) {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false;
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
    this.#ws?.close();
    this.#ws = null;
    this.#setStatus('offline');
  }
}
