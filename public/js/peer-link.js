// Conexão WebRTC entre os dois participantes.
// - Quem compartilha ("host") sempre faz a oferta; quem presta suporte ("viewer") só responde.
//   Isso elimina colisões de negociação.
// - O vídeo usa um transceiver "sendonly" criado desde o início: pausar, retomar ou trocar a
//   tela é só `replaceTrack`, sem renegociar.
// - Chat, avisos e arquivos usam um único canal de dados ordenado e confiável.

import { computeVerificationCode, fingerprintBinding } from '../../shared/verification.js';
import { LIMITS } from '../../shared/protocol.js';

const MAX_QUEUED_CANDIDATES = 200;

export class PeerLink extends EventTarget {
  #role;
  #pc;
  #channel = null;
  #sendSignal;
  #videoSender = null;
  #queuedCandidates = [];
  #closed = false;

  constructor({ role, iceServers = [], iceTransportPolicy = 'all', sendSignal }) {
    super();
    this.#role = role;
    this.#sendSignal = sendSignal;
    this.#pc = new RTCPeerConnection({ iceServers, iceTransportPolicy, bundlePolicy: 'max-bundle' });

    this.#pc.addEventListener('icecandidate', (e) => {
      this.#sendSignal({ kind: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null });
    });
    this.#pc.addEventListener('connectionstatechange', () => this.#emit('state', this.#pc.connectionState));

    if (role === 'host') {
      this.#videoSender = this.#pc.addTransceiver('video', { direction: 'sendonly' }).sender;
      this.#setupChannel(this.#pc.createDataChannel('session', { ordered: true }));
    } else {
      this.#pc.addEventListener('track', (e) => {
        this.#emit('track', { stream: e.streams[0] ?? new MediaStream([e.track]), track: e.track });
      });
      this.#pc.addEventListener('datachannel', (e) => {
        if (e.channel.label === 'session' && !this.#channel) this.#setupChannel(e.channel);
        else e.channel.close();
      });
    }
  }

  get state() {
    return this.#pc.connectionState;
  }

  get channelOpen() {
    return this.#channel?.readyState === 'open';
  }

  get bufferedAmount() {
    return this.#channel?.bufferedAmount ?? 0;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #setupChannel(channel) {
    this.#channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.addEventListener('open', () => this.#emit('channel-open'));
    channel.addEventListener('close', () => this.#emit('channel-close'));
    channel.addEventListener('message', (e) => {
      if (typeof e.data === 'string') {
        if (e.data.length > LIMITS.dataMessage) return;
        try {
          this.#emit('message', JSON.parse(e.data));
        } catch {
          // mensagem malformada: descartada
        }
      } else {
        this.#emit('binary', e.data);
      }
    });
  }

  async makeOffer({ iceRestart = false } = {}) {
    if (this.#role !== 'host' || this.#closed) return;
    if (this.#pc.signalingState === 'have-local-offer') {
      await this.#pc.setLocalDescription({ type: 'rollback' });
    }
    const offer = await this.#pc.createOffer({ iceRestart });
    await this.#pc.setLocalDescription(offer);
    this.#sendSignal({ kind: 'offer', sdp: this.#pc.localDescription.sdp });
  }

  restart() {
    return this.makeOffer({ iceRestart: true });
  }

  async handleSignal(payload) {
    if (this.#closed) return;
    const pc = this.#pc;
    if (payload.kind === 'offer' && this.#role === 'viewer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      await this.#flushCandidates();
      await pc.setLocalDescription(await pc.createAnswer());
      this.#sendSignal({ kind: 'answer', sdp: pc.localDescription.sdp });
    } else if (payload.kind === 'answer' && this.#role === 'host') {
      if (pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
      await this.#flushCandidates();
    } else if (payload.kind === 'ice') {
      if (!pc.remoteDescription) {
        if (this.#queuedCandidates.length < MAX_QUEUED_CANDIDATES) this.#queuedCandidates.push(payload.candidate);
        return;
      }
      await this.#addCandidate(payload.candidate);
    }
  }

  async #flushCandidates() {
    const queued = this.#queuedCandidates;
    this.#queuedCandidates = [];
    for (const c of queued) await this.#addCandidate(c);
  }

  async #addCandidate(candidate) {
    try {
      await this.#pc.addIceCandidate(candidate ?? undefined);
    } catch {
      // candidato inválido ou de uma negociação anterior: ignorado
    }
  }

  async setVideoTrack(track) {
    if (!this.#videoSender || this.#closed) return;
    if (track && 'contentHint' in track) track.contentHint = 'detail';
    await this.#videoSender.replaceTrack(track ?? null);
  }

  sendJson(obj) {
    if (!this.channelOpen) return false;
    this.#channel.send(JSON.stringify(obj));
    return true;
  }

  sendBinary(buffer) {
    if (!this.channelOpen) return false;
    this.#channel.send(buffer);
    return true;
  }

  // Controle de fluxo para arquivos grandes: espera o buffer do canal esvaziar.
  waitForDrain(highWater) {
    if (!this.channelOpen) return Promise.reject(new Error('channel_closed'));
    if (this.#channel.bufferedAmount <= highWater) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ch = this.#channel;
      const done = () => {
        ch.removeEventListener('bufferedamountlow', done);
        ch.removeEventListener('close', fail);
        resolve();
      };
      const fail = () => {
        ch.removeEventListener('bufferedamountlow', done);
        reject(new Error('channel_closed'));
      };
      ch.addEventListener('bufferedamountlow', done);
      ch.addEventListener('close', fail, { once: true });
    });
  }

  fingerprintBinding() {
    return fingerprintBinding(this.#pc.localDescription?.sdp, this.#pc.remoteDescription?.sdp);
  }

  verificationCode() {
    return computeVerificationCode(this.#pc.localDescription?.sdp, this.#pc.remoteDescription?.sdp);
  }

  async connectionRoute() {
    // Informa se a conexão é direta ou passa por um relay TURN (útil para diagnóstico).
    try {
      const stats = await this.#pc.getStats();
      for (const report of stats.values()) {
        if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') {
          const local = stats.get(report.localCandidateId);
          return local?.candidateType === 'relay' ? 'relay' : 'direct';
        }
      }
    } catch {
      // estatísticas indisponíveis
    }
    return 'unknown';
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#channel?.close();
    this.#pc.close();
  }
}
