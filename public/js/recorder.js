// Gravação local da tela recebida (só no dispositivo de quem presta suporte).
// O arquivo nunca é enviado ao servidor.

const CANDIDATE_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
const MAX_BYTES = 1024 * 1024 * 1024;

export class SessionRecorder {
  #recorder = null;
  #chunks = [];
  #bytes = 0;
  #mimeType = '';
  #stopping = null;

  static isSupported() {
    return typeof MediaRecorder !== 'undefined' && CANDIDATE_TYPES.some((t) => MediaRecorder.isTypeSupported(t));
  }

  get active() {
    return this.#recorder?.state === 'recording' && !this.#stopping;
  }

  start(stream, { onLimit } = {}) {
    if (this.active) return;
    this.#mimeType = CANDIDATE_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    this.#chunks = [];
    this.#bytes = 0;
    this.#recorder = new MediaRecorder(stream, this.#mimeType ? { mimeType: this.#mimeType } : undefined);
    this.#recorder.addEventListener('dataavailable', (e) => {
      if (!e.data.size) return;
      this.#chunks.push(e.data);
      this.#bytes += e.data.size;
      if (this.#bytes > MAX_BYTES) onLimit?.();
    });
    this.#recorder.start(1000);
  }

  // Com vídeo vindo do WebRTC, o codificador pode demorar a entregar o primeiro bloco.
  // Parar antes disso gera um arquivo vazio; então, se nada chegou ainda, pede os dados e espera um pouco.
  async #waitForFirstChunk(timeoutMs) {
    const rec = this.#recorder;
    if (this.#bytes > 0 || rec?.state !== 'recording') return;
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        rec.removeEventListener('dataavailable', onData);
        resolve();
      };
      const onData = (e) => { if (e.data.size) done(); };
      const timer = setTimeout(done, timeoutMs);
      rec.addEventListener('dataavailable', onData);
      rec.requestData();
    });
  }

  // Idempotente: chamadas repetidas durante a parada recebem o mesmo resultado.
  stop() {
    this.#stopping ??= this.#stop().finally(() => { this.#stopping = null; });
    return this.#stopping;
  }

  async #stop() {
    const rec = this.#recorder;
    if (!rec || rec.state === 'inactive') return null;
    await this.#waitForFirstChunk(2000);
    if (rec.state === 'inactive') return null;
    return new Promise((resolve) => {
      rec.addEventListener('stop', () => {
        const blob = this.#chunks.length ? new Blob(this.#chunks, { type: this.#mimeType || 'video/webm' }) : null;
        this.#chunks = [];
        this.#recorder = null;
        resolve(blob);
      }, { once: true });
      rec.stop();
    });
  }

  get extension() {
    return this.#mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  }
}
