// Gravação local da tela recebida (só no dispositivo de quem presta suporte).
// O arquivo nunca é enviado ao servidor.

const CANDIDATE_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
const MAX_BYTES = 1024 * 1024 * 1024;

export class SessionRecorder {
  #recorder = null;
  #chunks = [];
  #bytes = 0;
  #mimeType = '';

  static isSupported() {
    return typeof MediaRecorder !== 'undefined' && CANDIDATE_TYPES.some((t) => MediaRecorder.isTypeSupported(t));
  }

  get active() {
    return this.#recorder?.state === 'recording';
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

  stop() {
    const rec = this.#recorder;
    if (!rec || rec.state === 'inactive') return Promise.resolve(null);
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
