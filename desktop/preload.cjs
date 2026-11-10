// Ponte entre a interface (isolada, sem Node) e o processo principal.
// Expõe somente o necessário, com argumentos convertidos para tipos simples.

const { contextBridge, ipcRenderer } = require('electron');

const signalingUrl = ipcRenderer.sendSync('ponte:signaling-url');

// Canal direto para o processo de controle remoto, entregue pelo processo principal quando o
// controle é ligado. Os eventos não passam pela linha principal (ver desktop/input-worker.mjs).
let inputPort = null;
ipcRenderer.on('ponte:input-port', (event) => {
  inputPort?.close();
  [inputPort] = event.ports;
});
const listen = (channel) => (callback) => {
  ipcRenderer.on(channel, (_event, payload) => callback(payload));
};

contextBridge.exposeInMainWorld('ponteDesktop', {
  signalingUrl,
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('ponte:get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('ponte:save-settings', {
    mode: String(s?.mode ?? 'local'),
    serverUrl: String(s?.serverUrl ?? ''),
  }),
  openDocs: () => ipcRenderer.invoke('ponte:open-docs'),
  onSourceRequest: listen('ponte:pick-source'),
  chooseSource: (requestId, sourceId) => ipcRenderer.invoke('ponte:choose-source', String(requestId), sourceId ? String(sourceId) : null),
  onNavigate: (callback) => {
    ipcRenderer.on('ponte:navigate', (_event, key) => callback(String(key)));
  },

  // Rede local
  lanHostStart: (sessionId, secret) => ipcRenderer.invoke('ponte:lan-host-start', String(sessionId), String(secret)),
  lanInviteUsed: (sessionId) => ipcRenderer.invoke('ponte:lan-invite-used', String(sessionId)),
  lanHostStop: (sessionId) => ipcRenderer.invoke('ponte:lan-host-stop', String(sessionId)),
  lanDiscover: (sessionId, secret, address) => ipcRenderer.invoke('ponte:lan-discover', String(sessionId), String(secret), String(address ?? '')),

  // Controle remoto
  setControlActive: (active, peerName) => ipcRenderer.invoke('ponte:control-state', active === true, String(peerName ?? '')),
  injectInput: (msg) => inputPort?.postMessage(msg),
  onCaptureTarget: listen('ponte:capture-target'),
  onControlRevoked: listen('ponte:control-revoked'),
  onOverlay: listen('ponte:overlay'),
  revokeFromOverlay: () => ipcRenderer.send('ponte:overlay-revoke'),
  minimizeOverlay: () => ipcRenderer.send('ponte:overlay-minimize'),

  // Atualizações
  onUpdateStatus: listen('ponte:update-status'),
  checkForUpdates: () => ipcRenderer.invoke('ponte:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('ponte:update-download'),
  installUpdate: () => ipcRenderer.invoke('ponte:update-install'),
  openReleases: () => ipcRenderer.invoke('ponte:open-releases'),
  setAutoUpdate: (enabled) => ipcRenderer.invoke('ponte:set-auto-update', enabled === true),
  reportFlow: (active) => ipcRenderer.send('ponte:flow', active === true),

  // Acesso sem supervisão — proprietário
  unattendedStatus: () => ipcRenderer.invoke('ponte:unattended-status'),
  unattendedEnable: (input) => ipcRenderer.invoke('ponte:unattended-enable', {
    confirm: input?.confirm === true,
    password: String(input?.password ?? ''),
    deviceName: String(input?.deviceName ?? ''),
    permissions: Object.fromEntries(['view', 'control', 'files', 'chat', 'record'].map((p) => [p, input?.permissions?.[p] === true])),
  }),
  unattendedChangePassword: (password) => ipcRenderer.invoke('ponte:unattended-change-password', String(password ?? '')),
  unattendedUpdate: (input) => ipcRenderer.invoke('ponte:unattended-update', {
    ...(typeof input?.allowNewDevices === 'boolean' ? { allowNewDevices: input.allowNewDevices } : {}),
    ...(input?.permissions ? {
      permissions: Object.fromEntries(['view', 'control', 'files', 'chat', 'record'].map((p) => [p, input.permissions[p] === true])),
    } : {}),
  }),
  unattendedRevoke: (techId) => ipcRenderer.invoke('ponte:unattended-revoke', String(techId ?? '')),
  unattendedDisable: () => ipcRenderer.invoke('ponte:unattended-disable'),
  unattendedUnlock: () => ipcRenderer.invoke('ponte:unattended-unlock'),
  setAutostart: (enabled) => ipcRenderer.invoke('ponte:autostart', enabled === true),
  onUnattendedChanged: listen('ponte:unattended-changed'),

  // Acesso sem supervisão — janela que atende a sessão
  onUnattendedIncoming: listen('ponte:unattended-incoming'),
  onUnattendedRevoked: listen('ponte:unattended-revoked'),
  unattendedChallenge: () => ipcRenderer.invoke('ponte:unattended-challenge'),
  unattendedVerify: (input) => ipcRenderer.invoke('ponte:unattended-verify', {
    challengeId: String(input?.challengeId ?? ''), mac: String(input?.mac ?? ''),
    techId: String(input?.techId ?? ''), binding: String(input?.binding ?? ''),
  }),
  unattendedCapture: () => ipcRenderer.invoke('ponte:unattended-capture'),
  unattendedEnded: (reason) => ipcRenderer.invoke('ponte:unattended-ended', String(reason ?? '')),

  // Acesso sem supervisão — quem conecta
  unattendedLocate: (deviceId, address) => ipcRenderer.invoke('ponte:unattended-locate', String(deviceId ?? ''), String(address ?? '')),
  unattendedProof: (challenge, binding, password) => ipcRenderer.invoke('ponte:unattended-proof', {
    id: String(challenge?.id ?? ''), salt: String(challenge?.salt ?? ''), N: Number(challenge?.N), r: Number(challenge?.r),
    p: Number(challenge?.p), nonce: String(challenge?.nonce ?? ''), deviceId: String(challenge?.deviceId ?? ''),
  }, String(binding ?? ''), String(password ?? '')),
});
