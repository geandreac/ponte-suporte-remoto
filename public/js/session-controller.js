// Lógica de sessão, sem acesso ao DOM. A interface escuta os eventos emitidos aqui.
//
// Regra central: quem compartilha a tela (HostController) é a autoridade sobre as permissões.
// Os dados vão direto de navegador a navegador, então o servidor não consegue impedir uma
// mensagem; quem impede é o lado do anfitrião, que descarta tudo o que não foi liberado e
// para de enviar vídeo assim que a permissão é revogada.

import { FileTransfer } from './file-transfer.js';
import { addHistory } from './history.js';
import { PeerLink } from './peer-link.js';
import { SessionRecorder } from './recorder.js';
import {
  authorizeIncoming, diffPermissions, emptyPermissions, listGranted, PERMISSION_LABELS, resolveGrant,
} from '../../shared/permissions.js';
import { validateDataMessage } from '../../shared/protocol.js';
import { isActiveState, isTerminalState, nextState } from '../../shared/session-machine.js';

const RECONNECT_DEADLINE_MS = 30_000;
const RESTART_INTERVAL_MS = 5_000;
const FAILURE_REASONS = new Set(['connection_failed', 'session_lost', 'signaling_lost']);

export function canCaptureScreen() {
  return Boolean(globalThis.isSecureContext && navigator.mediaDevices?.getDisplayMedia);
}

const labels = (list) => list.map((p) => PERMISSION_LABELS[p]).join(', ');

class SessionController extends EventTarget {
  state = 'idle';
  sessionId = null;
  peerName = '';
  granted = emptyPermissions();
  requested = emptyPermissions();
  capabilities = { screenCapture: false, inputInjection: false };
  link = null;
  files = null;
  startedAt = null;
  endReason = null;
  verificationCode = null;
  route = 'unknown';
  peerOnline = true;
  #iceServers = [];
  #iceTransportPolicy = 'all';
  #deadline = null;

  constructor({ role, signaling }) {
    super();
    this.role = role;
    this.signaling = signaling;
    this._onSignalingMessage = (e) => this._handleSignaling(e.detail);
    this._onSignalingGaveUp = () => {
      if (!isTerminalState(this.state) && this.state !== 'idle') this._teardown('signaling_lost');
    };
    signaling.addEventListener('message', this._onSignalingMessage);
    signaling.addEventListener('gave-up', this._onSignalingGaveUp);
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _transition(event) {
    const next = nextState(this.state, event);
    if (!next) return false;
    this._setState(next);
    return true;
  }

  _setState(next) {
    const prev = this.state;
    this.state = next;
    this._emit('state', { state: next, prev });
  }

  _log(text, kind = 'info') {
    this._emit('log', { text, kind, at: Date.now() });
  }

  can(permission) {
    return this.granted[permission] === true;
  }

  _setIce({ iceServers, iceTransportPolicy }) {
    this.#iceServers = Array.isArray(iceServers) ? iceServers : [];
    this.#iceTransportPolicy = iceTransportPolicy === 'relay' ? 'relay' : 'all';
  }

  _createLink() {
    const link = new PeerLink({
      role: this.role === 'host' ? 'host' : 'viewer',
      iceServers: this.#iceServers,
      iceTransportPolicy: this.#iceTransportPolicy,
      sendSignal: (payload) => this.signaling.send('signal', { payload }),
    });
    this.link = link;
    this.files = new FileTransfer({ link, can: () => this.can('files') });
    for (const type of ['incoming', 'outgoing', 'progress']) {
      this.files.addEventListener(type, (e) => this._emit(`file-${type}`, e.detail));
    }
    link.addEventListener('state', (e) => this._onLinkState(e.detail));
    link.addEventListener('message', (e) => this._onData(e.detail));
    link.addEventListener('binary', (e) => this.files.handleBinary(e.detail));
    link.addEventListener('channel-open', () => this._onChannelOpen());
    return link;
  }

  async _onLinkState(linkState) {
    if (isTerminalState(this.state)) return;
    if (linkState === 'connected') {
      clearTimeout(this.#deadline);
      this.#deadline = null;
      this._transition('connected');
      this.verificationCode = await this.link.verificationCode();
      this.route = await this.link.connectionRoute();
      this._emit('verification', { code: this.verificationCode, route: this.route });
    } else if (linkState === 'disconnected' || linkState === 'failed') {
      if (this._transition('connection_lost')) this._log('Conexão instável. Tentando reconectar…', 'warn');
      this.#deadline ??= setTimeout(() => this._failConnection(), RECONNECT_DEADLINE_MS);
      this._onConnectionLost(linkState);
    }
  }

  _onConnectionLost() {}

  _onChannelOpen() {}

  _failConnection() {
    this.signaling.send('session:end');
    this._teardown('connection_failed');
  }

  _onData(raw) {
    const result = validateDataMessage(raw);
    if (!result.ok) return;
    const msg = result.value;
    const auth = authorizeIncoming(this.role === 'host' ? 'host' : 'viewer', msg.type, this.granted);
    if (!auth.allowed) {
      if (auth.permission) this._log(`Bloqueado: "${PERMISSION_LABELS[auth.permission]}" não está liberado.`, 'warn');
      return;
    }
    if (msg.type === 'chat') this._emit('chat', { from: 'peer', text: msg.text, at: Date.now() });
    else if (msg.type.startsWith('file-')) this.files.handleMessage(msg);
    else this._handleData(msg);
  }

  _handleData() {}

  sendChat(text) {
    const clean = String(text).trim();
    if (!clean) return false;
    if (!this.can('chat') || !this.link?.channelOpen) return false;
    this.link.sendJson({ type: 'chat', id: crypto.randomUUID().replaceAll('-', ''), text: clean.slice(0, 2000) });
    this._emit('chat', { from: 'me', text: clean.slice(0, 2000), at: Date.now() });
    return true;
  }

  sendFile(file) {
    if (!this.link?.channelOpen) return Promise.reject(Object.assign(new Error('channel_closed'), { code: 'channel_closed' }));
    return this.files.send(file);
  }

  // Aplica um novo conjunto de permissões. Subclasses complementam com os efeitos colaterais.
  _applyPermissions(next, requested) {
    const diff = diffPermissions(this.granted, next);
    this.granted = { ...next };
    if (requested) this.requested = { ...requested };
    if (diff.granted.length) this._log(`Permissão concedida: ${labels(diff.granted)}.`);
    if (diff.revoked.length) this._log(`Permissão revogada: ${labels(diff.revoked)}.`, 'warn');
    if (!next.files) this.files?.cancelAll('permission_revoked');
    this._emit('permissions', { granted: this.granted, requested: this.requested, diff });
    return diff;
  }

  _handleSignaling(msg) {
    switch (msg.type) {
      case 'signal':
        this.link?.handleSignal(msg.payload).catch(() => this._log('Falha ao negociar a conexão.', 'error'));
        break;
      case 'permissions':
        this._applyPermissions(msg.granted, msg.requested);
        break;
      case 'peer-status':
        this.peerOnline = msg.status === 'connected';
        this._emit('peer-status', { online: this.peerOnline });
        this._log(this.peerOnline ? 'A outra pessoa voltou a se conectar.' : 'A outra pessoa perdeu a conexão com o servidor. Aguardando até 30 s…', this.peerOnline ? 'info' : 'warn');
        if (this.peerOnline) this._onPeerBack();
        break;
      case 'resumed':
        this._setIce(msg);
        this._onResumed(msg);
        break;
      case 'resume-failed':
        this._teardown('session_lost');
        break;
      case 'session-ended':
        this._teardown(msg.reason);
        break;
      case 'error':
        this._onServerError(msg.code);
        break;
      default:
    }
  }

  _onPeerBack() {}

  _onResumed() {}

  _onServerError(code) {
    this._emit('notice', { code });
  }

  end(reason) {
    if (isTerminalState(this.state) || this.state === 'idle') return;
    this.signaling.send('session:end');
    this._teardown(reason ?? (this.role === 'host' ? 'host_ended' : 'tech_ended'));
  }

  _teardown(reason) {
    if (isTerminalState(this.state) || this.state === 'idle') return;
    clearTimeout(this.#deadline);
    this.#deadline = null;
    this.endReason = reason;
    this.files?.cancelAll('channel_closed');
    this._cleanupMedia();
    this.link?.close();
    this.link = null;
    this.signaling.clearResume();
    if (this.startedAt) {
      addHistory({
        role: this.role,
        peerName: this.peerName,
        startedAt: this.startedAt,
        endedAt: Date.now(),
        endReason: reason,
        permissions: listGranted(this.granted),
      });
    }
    const failure = FAILURE_REASONS.has(reason);
    if (!this._transition(failure ? 'fail' : 'end')) this._setState(failure ? 'failed' : 'ended');
    this._emit('ended', { reason });
  }

  _cleanupMedia() {}

  dispose() {
    this.signaling.removeEventListener('message', this._onSignalingMessage);
    this.signaling.removeEventListener('gave-up', this._onSignalingGaveUp);
  }
}

export class HostController extends SessionController {
  capture = null;
  paused = false;
  pendingRequest = null;
  peerRecording = false;
  invite = null;
  controllable = false; // a tela compartilhada é uma tela inteira que o app consegue controlar
  controlActive = false;
  #restartTimer = null;
  #controlSync = Promise.resolve();

  // `platform`: integração com o app de computador (controle remoto). Ausente na versão web.
  constructor({ signaling, platform = null }) {
    super({ role: 'host', signaling });
    this.platform = platform;
    this.capabilities = { screenCapture: canCaptureScreen(), inputInjection: Boolean(platform?.inputInjection) };
  }

  async start(name) {
    if (!this._transition('host_create')) return;
    try {
      await this.signaling.ensureConnected();
    } catch {
      this._transition('error');
      this._emit('notice', { code: 'signaling_unreachable' });
      return;
    }
    this.signaling.send('host:create', { name, capabilities: this.capabilities });
  }

  _handleSignaling(msg) {
    switch (msg.type) {
      case 'session-created':
        if (this.state !== 'creating') return;
        this.sessionId = msg.sessionId;
        this.invite = { sessionId: msg.sessionId, secret: msg.secret, expiresAt: msg.inviteExpiresAt };
        this._setIce(msg);
        this.signaling.setResume({ sessionId: msg.sessionId, token: msg.hostToken });
        this._transition('created');
        this._emit('invite', this.invite);
        break;
      case 'join-request':
        this.pendingRequest = msg;
        this._emit('join-request', msg);
        break;
      case 'join-request-expired':
      case 'join-request-cancelled':
        if (this.pendingRequest?.requestId === msg.requestId) {
          this.pendingRequest = null;
          this._emit('join-request-closed', { reason: msg.type === 'join-request-expired' ? 'expired' : 'cancelled' });
        }
        break;
      case 'peer-joined':
        this._onPeerJoined(msg);
        break;
      case 'permissions-request':
        this.requested = { ...msg.requested };
        this._emit('permissions-request', { asked: msg.asked, requested: msg.requested });
        break;
      default:
        super._handleSignaling(msg);
    }
  }

  _onServerError(code) {
    if (this.state === 'creating') this._transition('error');
    if (code === 'no_pending_request' && this.state === 'waiting') {
      // O pedido expirou enquanto a pessoa decidia: não deixa a captura de tela aberta à toa.
      this._stopCapture();
      this.pendingRequest = null;
      this._emit('join-request-closed', { reason: 'expired' });
    }
    super._onServerError(code);
  }

  // Aprovação. Se "ver a tela" foi concedido, o navegador pede para escolher o que compartilhar
  // antes de liberar a entrada; se a pessoa cancelar, a aprovação não acontece.
  async approve(granted) {
    const req = this.pendingRequest;
    if (!req) return;
    const effective = resolveGrant({ requested: req.requested, granted, capabilities: this.capabilities });
    if (effective.view && !this.capture) await this._startCapture();
    if (this.pendingRequest !== req) {
      this._stopCapture();
      return;
    }
    this.pendingRequest = null;
    this.requested = { ...req.requested };
    this.granted = effective;
    this.peerName = req.name;
    this.signaling.send('host:respond', { requestId: req.requestId, accept: true, granted: effective });
  }

  reject() {
    const req = this.pendingRequest;
    if (!req) return;
    this.pendingRequest = null;
    this.signaling.send('host:respond', { requestId: req.requestId, accept: false });
    this._log(`Pedido de ${req.name} recusado.`);
  }

  async _onPeerJoined(msg) {
    if (!this._transition('peer_joined')) return;
    this.peerName = msg.name;
    this.startedAt = Date.now();
    this.granted = { ...msg.granted };
    this.requested = { ...msg.requested };
    this._log(`${msg.name} entrou na sessão. Permissões: ${labels(listGranted(this.granted)) || 'nenhuma'}.`);
    this._emit('permissions', { granted: this.granted, requested: this.requested, diff: { granted: [], revoked: [] } });
    const link = this._createLink();
    await this._applyVideo();
    await link.makeOffer();
  }

  async _startCapture() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false,
    });
    const [track] = stream.getVideoTracks();
    track.addEventListener('ended', () => this._onCaptureEnded(stream));
    this.capture = stream;
    this._emit('capture', { stream });
  }

  _stopCapture() {
    if (!this.capture) return;
    for (const t of this.capture.getTracks()) t.stop();
    this.capture = null;
    this._emit('capture', { stream: null });
  }

  async _onCaptureEnded(stream) {
    if (this.capture !== stream) return;
    this.capture = null;
    this._emit('capture', { stream: null });
    this._log('O compartilhamento foi interrompido pelo navegador.', 'warn');
    await this._applyVideo();
  }

  get sharing() {
    return Boolean(this.capture && this.can('view') && !this.paused && isActiveState(this.state));
  }

  async _applyVideo() {
    const track = this.capture && this.can('view') && !this.paused ? this.capture.getVideoTracks()[0] : null;
    await this.link?.setVideoTrack(track);
    this._sendShareState();
    this._emit('share', { sharing: this.sharing, paused: this.paused, captureActive: Boolean(this.capture) });
    this._syncControl();
  }

  _sendShareState() {
    this.link?.sendJson({
      type: 'share-state', paused: !this.sharing, captureActive: Boolean(this.capture), controlActive: this.controlActive,
    });
  }

  // O controle só fica ativo com tudo verdadeiro ao mesmo tempo: permissão concedida, tela
  // inteira sendo enviada (não pausada) e sessão conectada. Qualquer mudança reavalia.
  _syncControl() {
    this.#controlSync = this.#controlSync.then(async () => {
      if (!this.platform) return;
      const want = this.can('control') && this.sharing && this.controllable && isActiveState(this.state);
      if (want === this.controlActive) return;
      if (want) {
        const result = await this.platform.setControlActive(true, this.peerName);
        if (result !== 'ok') {
          this._emit('notice', { code: `control_${result}` });
          return;
        }
        this.controlActive = true;
        this._log(`${this.peerName} pode controlar seu teclado e mouse.`, 'warn');
      } else {
        this.controlActive = false;
        await this.platform.setControlActive(false);
        this._log('Controle remoto desativado.');
      }
      this._sendShareState();
      this._emit('control', { active: this.controlActive });
    });
    return this.#controlSync;
  }

  // Avisos vindos do app de computador.
  setCaptureControllable(controllable) {
    this.controllable = controllable;
    this._syncControl();
  }

  onControlRevoked() {
    if (!this.can('control')) return;
    this._log('Você retomou o controle do computador.');
    this.setPermissions({ ...this.granted, control: false });
  }

  _onChannelOpen() {
    this._sendShareState();
  }

  async setPaused(paused) {
    this.paused = paused;
    this._log(paused ? 'Você pausou o compartilhamento.' : 'Você retomou o compartilhamento.');
    await this._applyVideo();
  }

  async shareAgain() {
    await this._startCapture();
    this.paused = false;
    await this._applyVideo();
  }

  // Altera permissões a partir da interface. Revogações valem na hora, antes de qualquer
  // confirmação do servidor; concessões de vídeo pedem a escolha da tela primeiro.
  async setPermissions(desired) {
    const next = resolveGrant({ requested: this.requested, granted: desired, capabilities: this.capabilities });
    if (next.view && !this.capture) await this._startCapture();
    this._applyPermissions(next);
    this.signaling.send('permissions:update', { granted: next });
  }

  revokeAll() {
    return this.setPermissions(emptyPermissions());
  }

  _applyPermissions(next, requested) {
    const diff = super._applyPermissions(next, requested);
    if (!next.view) this._stopCapture();
    if (!next.record && this.peerRecording) {
      this.peerRecording = false;
      this._emit('recording', { active: false });
    }
    this._applyVideo();
    return diff;
  }

  _handleData(msg) {
    if (msg.type === 'input') {
      if (this.controlActive) this.platform.injectInput(msg);
      return;
    }
    if (msg.type !== 'recording-state') return;
    if (msg.active && !this.can('record')) {
      // O cliente oficial nunca faz isso; se acontecer, o outro lado foi modificado.
      this._log('O técnico tentou gravar sem permissão. Sessão encerrada por segurança.', 'error');
      this.end('policy_violation');
      return;
    }
    this.peerRecording = msg.active;
    this._log(msg.active ? 'O técnico começou a gravar a sessão.' : 'O técnico parou de gravar.', msg.active ? 'warn' : 'info');
    this._emit('recording', { active: msg.active });
  }

  _onConnectionLost(linkState) {
    if (this.#restartTimer) return;
    const attempt = () => {
      if (!this.link || this.state !== 'reconnecting') {
        clearInterval(this.#restartTimer);
        this.#restartTimer = null;
        return;
      }
      this.link.restart().catch(() => {});
    };
    if (linkState === 'failed') attempt();
    this.#restartTimer = setInterval(attempt, RESTART_INTERVAL_MS);
  }

  _onLinkState(linkState) {
    if (linkState === 'connected') {
      clearInterval(this.#restartTimer);
      this.#restartTimer = null;
    }
    return super._onLinkState(linkState);
  }

  _onPeerBack() {
    if (this.link && this.link.state !== 'connected') this.link.restart().catch(() => {});
  }

  _onResumed(msg) {
    if (msg.peerConnected) this._onPeerBack();
  }

  _cleanupMedia() {
    clearInterval(this.#restartTimer);
    this.#restartTimer = null;
    if (this.controlActive || this.platform) {
      this.controlActive = false;
      this.platform?.setControlActive(false);
    }
    this._stopCapture();
    this.pendingRequest = null;
    this.peerRecording = false;
  }
}

export class ViewerController extends SessionController {
  remoteStream = null;
  hostPaused = true;
  hostControlActive = false;
  hostName = '';
  recorder = new SessionRecorder();

  constructor({ signaling }) {
    super({ role: 'viewer', signaling });
  }

  get recording() {
    return this.recorder.active;
  }

  async join({ sessionId, secret, name, requested }) {
    if (!this._transition('tech_join')) return;
    this.myName = name;
    try {
      await this.signaling.ensureConnected();
    } catch {
      this._transition('error');
      this._emit('notice', { code: 'signaling_unreachable' });
      return;
    }
    this.signaling.send('tech:join', { sessionId, secret, name, requested });
  }

  cancelJoin() {
    if (this.state !== 'awaiting_approval' && this.state !== 'joining') return;
    this.signaling.send('session:end');
    if (this.state === 'joining') this._transition('error');
    else this._teardown('cancelled');
  }

  _handleSignaling(msg) {
    switch (msg.type) {
      case 'join-pending':
        this.hostName = msg.hostName;
        if (this._transition('pending')) this._emit('pending', msg);
        // Desistiu antes da confirmação chegar: retira o pedido no servidor.
        else this.signaling.send('session:end');
        break;
      case 'join-rejected':
        if (this.state === 'awaiting_approval') this._teardown(msg.reason === 'declined' ? 'declined' : msg.reason);
        break;
      case 'join-accepted':
        this._onAccepted(msg);
        break;
      default:
        super._handleSignaling(msg);
    }
  }

  _onServerError(code) {
    if (this.state === 'joining') {
      this._transition('error');
      this._emit('join-error', { code });
      return;
    }
    super._onServerError(code);
  }

  _onAccepted(msg) {
    if (!this._transition('accepted')) return;
    this.sessionId = msg.sessionId;
    this.peerName = msg.hostName || 'Pessoa atendida';
    this.capabilities = { ...msg.capabilities };
    this.granted = { ...msg.granted };
    this.requested = { ...msg.requested };
    this.startedAt = Date.now();
    this._setIce(msg);
    this.signaling.setResume({ sessionId: msg.sessionId, token: msg.token });
    const link = this._createLink();
    link.addEventListener('track', (e) => {
      this.remoteStream = e.detail.stream;
      this._emit('stream', { stream: this.remoteStream });
    });
    this._log(`Conexão aprovada. Permissões: ${labels(listGranted(this.granted)) || 'nenhuma'}.`);
    this._emit('permissions', { granted: this.granted, requested: this.requested, diff: { granted: [], revoked: [] } });
  }

  _handleData(msg) {
    if (msg.type !== 'share-state') return;
    this.hostPaused = msg.paused;
    this.hostControlActive = msg.controlActive;
    this._emit('share', { paused: msg.paused, captureActive: msg.captureActive, controlActive: msg.controlActive });
  }

  get canControl() {
    return this.can('control') && this.hostControlActive && !this.hostPaused;
  }

  // Envia um evento de teclado/mouse. O lado de quem compartilha valida e decide de novo.
  sendInput(msg) {
    if (!this.canControl || !this.link?.channelOpen) return false;
    return this.link.sendJson({ type: 'input', ...msg });
  }

  _applyPermissions(next, requested) {
    const diff = super._applyPermissions(next, requested);
    if (!next.record && this.recording) this.stopRecording();
    return diff;
  }

  requestPermissions(requested) {
    this.signaling.send('permissions:request', { requested });
    this._log(`Você pediu: ${labels(listGranted(requested))}. Aguardando a outra pessoa.`);
  }

  startRecording() {
    if (!this.can('record')) throw Object.assign(new Error('not_permitted'), { code: 'not_permitted' });
    if (!this.remoteStream || !this.link?.channelOpen) throw Object.assign(new Error('no_stream'), { code: 'no_stream' });
    // Avisa antes de começar: a outra pessoa precisa ver o indicador de gravação.
    this.link.sendJson({ type: 'recording-state', active: true });
    this.recorder.start(this.remoteStream, { onLimit: () => this.stopRecording() });
    this._log('Gravação iniciada. O arquivo fica só neste dispositivo.', 'warn');
    this._emit('recording', { active: true });
  }

  async stopRecording() {
    if (!this.recording) return;
    const blob = await this.recorder.stop();
    this.link?.sendJson({ type: 'recording-state', active: false });
    this._log('Gravação encerrada.');
    this._emit('recording', { active: false, blob, extension: this.recorder.extension });
  }

  _cleanupMedia() {
    if (this.recording) this.stopRecording();
    this.remoteStream = null;
  }
}
