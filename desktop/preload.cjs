// Ponte entre a interface (isolada, sem Node) e o processo principal.
// Expõe somente o necessário, com argumentos convertidos para tipos simples.

const { contextBridge, ipcRenderer } = require('electron');

const signalingUrl = ipcRenderer.sendSync('ponte:signaling-url');

contextBridge.exposeInMainWorld('ponteDesktop', {
  signalingUrl,
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('ponte:get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('ponte:save-settings', {
    mode: String(s?.mode ?? 'local'),
    serverUrl: String(s?.serverUrl ?? ''),
  }),
  openDocs: () => ipcRenderer.invoke('ponte:open-docs'),
  onSourceRequest: (callback) => {
    ipcRenderer.on('ponte:pick-source', (_event, payload) => callback(payload));
  },
  chooseSource: (requestId, sourceId) => ipcRenderer.invoke('ponte:choose-source', String(requestId), sourceId ? String(sourceId) : null),
  onNavigate: (callback) => {
    ipcRenderer.on('ponte:navigate', (_event, key) => callback(String(key)));
  },
});
