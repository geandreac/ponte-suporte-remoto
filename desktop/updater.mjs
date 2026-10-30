// Atualização automática a partir das Releases do GitHub (electron-updater).
//
// - Windows (instalador) e Linux (AppImage): baixa em segundo plano e instala ao fechar o app,
//   ou na hora, se a pessoa pedir. A integridade é conferida pelo SHA-512 publicado na Release.
// - macOS, Windows portátil e .deb: só avisa e abre a página de download (o macOS não aceita
//   instalar sozinho um app sem assinatura; os outros formatos não suportam autoatualização).
// - Nunca reinicia sozinho: a pessoa decide, e a interface não oferece isso durante uma sessão.

export const RELEASES_URL = 'https://github.com/geandreac/ponte-suporte-remoto/releases/latest';
const FIRST_CHECK_MS = 15_000;
const INTERVAL_MS = 6 * 60 * 60_000;

export function updateMode({ isPackaged, platform, env = {} }) {
  if (!isPackaged) return 'unsupported';
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_DIR ? 'notify' : 'auto';
  if (platform === 'linux') return env.APPIMAGE ? 'auto' : 'notify';
  if (platform === 'darwin') return 'notify';
  return 'unsupported';
}

export function createUpdater({ autoUpdater, mode, isEnabled, onStatus, setTimer = setTimeout, setRepeat = setInterval }) {
  let status = { state: mode === 'unsupported' ? 'unsupported' : 'idle', mode };
  const emit = (patch) => {
    status = { ...status, ...patch, mode };
    onStatus(status);
  };

  if (mode !== 'unsupported') {
    autoUpdater.autoInstallOnAppQuit = mode === 'auto';
    autoUpdater.allowPrerelease = false;
    autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => emit({ state: 'up-to-date', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info) => emit({
      state: autoUpdater.autoDownload ? 'downloading' : 'available', version: info?.version ?? '', percent: 0,
    }));
    autoUpdater.on('download-progress', (p) => emit({ state: 'downloading', percent: Math.round(p?.percent ?? 0) }));
    autoUpdater.on('update-downloaded', (info) => emit({ state: 'ready', version: info?.version ?? status.version }));
    autoUpdater.on('error', () => emit({ state: 'error' }));
  }

  // Busca manual baixa mesmo com a atualização automática desligada (a pessoa pediu).
  const check = ({ manual = false } = {}) => {
    if (mode === 'unsupported' || status.state === 'downloading' || status.state === 'ready') return false;
    autoUpdater.autoDownload = mode === 'auto' && (manual || isEnabled());
    Promise.resolve(autoUpdater.checkForUpdates()).catch(() => emit({ state: 'error' }));
    return true;
  };

  return {
    get status() {
      return status;
    },
    check,
    start() {
      if (mode === 'unsupported') return;
      setTimer(() => { if (isEnabled()) check(); }, FIRST_CHECK_MS);
      setRepeat(() => { if (isEnabled()) check(); }, INTERVAL_MS);
    },
    // Atualização encontrada com o download automático desligado: baixa quando a pessoa pede.
    download() {
      if (mode !== 'auto' || status.state !== 'available') return false;
      emit({ state: 'downloading', percent: 0 });
      Promise.resolve(autoUpdater.downloadUpdate()).catch(() => emit({ state: 'error' }));
      return true;
    },
    installNow() {
      if (mode !== 'auto' || status.state !== 'ready') return false;
      autoUpdater.quitAndInstall(false, true);
      return true;
    },
  };
}
