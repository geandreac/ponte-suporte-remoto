// Processo principal do app de computador (Electron).
//
// - A interface é a mesma da versão web, servida por um protocolo próprio e seguro (ponte://app),
//   em janelas isoladas: sem Node na página, sandbox ligado, navegação externa bloqueada.
// - Modo "rede local" (padrão): servidor de sinalização embutido em 127.0.0.1. Enquanto houver um
//   convite/sessão criado aqui, abre também um servidor TLS na rede local e responde a buscas pelo
//   ID (ver lan.mjs). Modo "servidor da organização": conecta via WSS ao endereço configurado.
// - Captura de tela pelo seletor do app, sempre com escolha da pessoa.
// - Controle remoto (input.mjs): só com permissão, só compartilhando uma tela inteira, com aviso
//   sempre visível e atalho global para retomar o controle.
// - Atualização automática (updater.mjs).

import {
  app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, MessageChannelMain, nativeImage,
  nativeTheme, Notification, protocol, safeStorage, screen,
  session, shell, systemPreferences, Tray, utilityProcess, webContents,
} from 'electron';
import electronUpdater from 'electron-updater';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createServer as createHttpsServer } from 'node:https';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, MIME, resolveStaticPath, securityHeaders } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import {
  formatSessionId, normalizeSecret, normalizeSessionId, SECRET_PATTERN, SESSION_ID_PATTERN, validateDataMessage,
} from '../shared/protocol.js';
import { REVOKE_ACCELERATOR } from './input.mjs';
import {
  createResponder, deriveInviteKey, discover, discoverDevice, ensureCertificate, isValidAddress, localAddresses,
} from './lan.mjs';
import { DevicePresence } from './presence.mjs';
import { computeProof, UnattendedStore } from './unattended.mjs';
import { loadSettings, saveSettings, signalingUrlFor, validateSettings } from './settings.mjs';
import { createUpdater, RELEASES_URL, updateMode } from './updater.mjs';

const APP_ORIGIN = 'ponte://app';
const DOCS_URL = 'https://github.com/geandreac/ponte-suporte-remoto#readme';
const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const INPUT_WORKER = fileURLToPath(new URL('./input-worker.mjs', import.meta.url));
const ALLOWED_PERMISSIONS = new Set(['display-capture', 'clipboard-sanitized-write', 'fullscreen']);
const SHORTCUT_LABEL = process.platform === 'darwin' ? '⌘⌥⇧X' : 'Ctrl+Alt+Shift+X';

if (process.env.PONTE_USER_DATA) app.setPath('userData', process.env.PONTE_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: 'ponte', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let settings = null;
let signalingUrl = '';
let loopbackUrl = '';
let unattended = null; // cofre do acesso sem supervisão
let presences = [];
let tray = null;
const unattendedSessions = new Map(); // webContents.id -> { sessionId, techName, techId, authenticated }
const flowWindows = new Set(); // janelas com convite/sessão em andamento
let connectSrc = ["'self'"];
let embedded = null;
const pendingPicks = new Map();
const captureTargets = new Map(); // webContents.id -> área da tela compartilhada (ou null)
const pinned = new Map(); // host -> impressões digitais aceitas (rede local)
let lan = null;
let lanStarting = null;
let inputWorker = null;
let injecting = false;
const posRequests = new Map();
let inputStatus = { available: false, reason: 'module' };
let control = { owner: null };
let overlay = null;
let updater = null;

const isAppUrl = (url) => typeof url === 'string' && (url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`));
const fromApp = (event) => isAppUrl(event.senderFrame?.url);
const appWindows = () => BrowserWindow.getAllWindows().filter((w) => w !== overlay && !w.isDestroyed());
const broadcast = (channel, payload) => {
  for (const w of appWindows()) w.webContents.send(channel, payload);
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = appWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else {
      createWindow();
    }
  });
  app.whenReady().then(start);
}

async function start() {
  const userData = app.getPath('userData');
  settings = await loadSettings(userData);
  // Servidor embutido sempre ativo (só em 127.0.0.1): atende o modo rede local e é por ele que
  // a rede local alcança este computador no acesso sem supervisão.
  embedded = createApp(
    { ...loadConfig({}), host: '127.0.0.1', port: 0, auditLogFile: join(userData, 'audit.log') },
  );
  const { port } = await embedded.listen();
  loopbackUrl = `ws://127.0.0.1:${port}/ws`;
  // wss: para alcançar outro computador na rede local (certificado validado por pinning).
  connectSrc = ["'self'", `ws://127.0.0.1:${port}`, 'wss:'];
  if (settings.mode === 'remote') {
    signalingUrl = signalingUrlFor(settings.serverUrl);
    const ws = new URL(signalingUrl);
    connectSrc.push(`${ws.protocol}//${ws.host}`);
  } else {
    signalingUrl = loopbackUrl;
  }

  inputStatus = await initInput();
  registerProtocol();
  hardenSession();
  registerIpc();
  initUpdater();
  Menu.setApplicationMenu(buildMenu());
  await initUnattended();
  // Iniciado com o computador (opção visível em Ajustes): só o ícone na área de notificação.
  const startHidden = process.argv.includes('--hidden') && unattended.enabled;
  if (!startHidden) createWindow();
  if (process.env.PONTE_TEST === '1') exposeTestHooks();

  app.on('activate', () => {
    if (appWindows().length === 0) createWindow();
  });
}

/* ================= Interface ================= */

function registerProtocol() {
  protocol.handle('ponte', async (request) => {
    const url = new URL(request.url);
    const notFound = () => new Response('Not found', { status: 404 });
    if (url.host !== 'app') return notFound();
    const file = resolveStaticPath(url.pathname);
    const type = file && MIME[extname(file)];
    if (!type) return notFound();
    try {
      const body = await readFile(file);
      return new Response(body, { headers: { 'Content-Type': type, ...securityHeaders({ tls: false, connectSrc }) } });
    } catch {
      return notFound();
    }
  });
}

const secureWebPreferences = () => ({
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: false,
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 380,
    minHeight: 560,
    title: 'Ponte',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121417' : '#f3f4f6',
    webPreferences: secureWebPreferences(),
  });
  const wcId = win.webContents.id;
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  win.webContents.on('destroyed', () => {
    captureTargets.delete(wcId);
    flowWindows.delete(wcId);
    if (control.owner?.id === wcId) stopControl();
    const unattendedSession = unattendedSessions.get(wcId);
    if (unattendedSession) endUnattendedSession(wcId, 'window_closed');
    if (lan) {
      for (const [id, entry] of lan.invites) if (entry.wcId === wcId) lan.invites.delete(id);
      maybeCloseLan();
    }
  });
  // Fechar no meio de uma sessão: confirmação nativa (a página sinaliza via beforeunload).
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Encerrar e fechar', 'Continuar na sessão'],
      defaultId: 1,
      cancelId: 1,
      message: 'Há uma sessão em andamento',
      detail: 'Fechar a janela encerra a sessão para as duas pessoas.',
    });
    if (choice === 0) e.preventDefault();
  });
  win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}

/* ================= Segurança da sessão do navegador ================= */

function hardenSession() {
  const ses = session.defaultSession;
  // Captura sem seletor (getUserMedia de tela) só para a janela de uma sessão sem supervisão já
  // autenticada por senha. Câmera e microfone continuam sempre negados.
  const unattendedVideo = (wc, details) => Boolean(wc && unattendedSessions.get(wc.id)?.authenticated)
    && Array.isArray(details?.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((t) => t === 'video');
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (!isAppUrl(details.requestingUrl)) return callback(false);
    if (permission === 'media') return callback(unattendedVideo(wc, details));
    return callback(ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (!isAppUrl(origin)) return false;
    if (permission === 'media') return Boolean(wc && unattendedSessions.get(wc.id)?.authenticated) && details?.mediaType !== 'audio';
    return ALLOWED_PERMISSIONS.has(permission);
  });

  // Rede local: certificado próprio aceito só se for exatamente o anunciado (e autenticado) na descoberta.
  ses.setCertificateVerifyProc((request, callback) => {
    const accepted = pinned.get(request.hostname);
    if (!accepted) return callback(-3);
    const fingerprint = String(request.certificate?.fingerprint ?? '').replace(/^sha256\//, '');
    return callback(accepted.has(fingerprint) ? 0 : -2);
  });

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    let answered = false;
    const finish = (streams) => {
      if (answered) return;
      answered = true;
      try {
        callback(streams);
      } catch {
        // Recusar ({} sem vídeo) rejeita o getDisplayMedia na página e o Electron também lança aqui.
      }
    };
    const wc = request.frame ? webContents.fromFrame(request.frame) : null;
    if (!wc || !isAppUrl(request.frame.url)) return finish({});
    try {
      // Telas e janelas em chamadas separadas: pedir as duas juntas é instável em alguns ambientes
      // Linux (sem gerenciador de janelas, a lista inteira pode voltar vazia).
      const thumbnailSize = { width: 400, height: 250 };
      const results = await Promise.allSettled(
        ['screen', 'window'].map((type) => desktopCapturer.getSources({ types: [type], thumbnailSize })),
      );
      const sources = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      const requestId = randomUUID();
      pendingPicks.set(requestId, { sources, finish, wc });
      setTimeout(() => {
        if (pendingPicks.delete(requestId)) finish({});
      }, 120_000);
      wc.send('ponte:pick-source', {
        requestId,
        sources: sources.map((s) => ({
          id: s.id,
          name: s.name.slice(0, 120),
          kind: s.id.startsWith('screen:') ? 'screen' : 'window',
          thumbnail: s.thumbnail.toDataURL(),
        })),
      });
    } catch {
      finish({});
    }
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });
}

/* ================= Rede local ================= */

async function ensureLan() {
  if (lan) return lan;
  lanStarting ??= (async () => {
    const cert = await ensureCertificate(app.getPath('userData'));
    // Este servidor só atende a sinalização (WebSocket); qualquer outra requisição recebe 404.
    const server = createHttpsServer({ cert: cert.cert, key: cert.key }, (_req, res) => {
      res.writeHead(404);
      res.end();
    });
    embedded.signaling.attach(server);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', resolve);
    });
    const state = { server, port: server.address().port, fingerprint: cert.fingerprint, invites: new Map(), responder: null };
    state.responder = createResponder({
      getKey: (id) => state.invites.get(id)?.key ?? null,
      getDeviceId: () => (unattended?.enabled ? unattended.deviceId : null),
      servicePort: () => state.port,
      fingerprint: cert.fingerprint,
    });
    try {
      await state.responder.ready;
    } catch (err) {
      server.close();
      throw err;
    }
    lan = state;
    return state;
  })().finally(() => {
    lanStarting = null;
  });
  return lanStarting;
}

// Mantém a rede local aberta enquanto houver convite/sessão OU acesso sem supervisão ativado.
function maybeCloseLan() {
  if (lan && lan.invites.size === 0 && !unattended?.enabled) closeLan();
}

function closeLan() {
  const current = lan;
  lan = null;
  if (!current) return;
  current.responder.close();
  current.server.closeAllConnections?.();
  current.server.close();
}

/* ================= Controle remoto ================= */

// A injeção roda num processo separado (input-worker.mjs): no Windows, um clique injetado na
// barra de título de uma janela deste app prende a linha principal num laço modal até o botão
// ser solto; se a injeção rodasse aqui, o "soltar" nunca sairia e o app travaria.
function initInput() {
  if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
    return Promise.resolve({ available: false, reason: 'wayland' });
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (status) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    const worker = utilityProcess.fork(INPUT_WORKER, [], { serviceName: 'Ponte - controle remoto', stdio: 'ignore' });
    worker.on('message', (data) => {
      if (data?.t === 'ready') {
        if (data.ok) {
          inputWorker = worker;
          done({ available: true, reason: '' });
        } else {
          worker.kill();
          done({ available: false, reason: 'module' });
        }
      } else if (data?.t === 'pos') {
        posRequests.get(data.id)?.({ ...data.pos, lastInjectAt: data.lastInjectAt });
        posRequests.delete(data.id);
      }
    });
    worker.on('exit', () => {
      if (inputWorker !== worker) return done({ available: false, reason: 'module' });
      inputWorker = null;
      inputStatus = { available: false, reason: 'module' };
      revokeControl('unavailable');
    });
    setTimeout(() => {
      if (!settled) worker.kill();
      done({ available: false, reason: 'module' });
    }, 10_000);
  });
}

const postInput = (data) => inputWorker?.postMessage(data);

// Windows/Linux injetam em pixels físicos; o Electron informa as telas em pontos lógicos.
function toPhysical(bounds) {
  if (process.platform === 'darwin') return bounds;
  const tl = screen.dipToScreenPoint({ x: bounds.x, y: bounds.y });
  const br = screen.dipToScreenPoint({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
  return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
}

function setInjecting(target, enabled) {
  if (target !== undefined) postInput({ t: 'target', bounds: target ? toPhysical(target) : null });
  injecting = enabled;
  postInput({ t: 'enabled', value: enabled });
}

function targetForSource(source) {
  if (!source?.id?.startsWith('screen:')) return null;
  const displays = screen.getAllDisplays();
  const match = displays.find((d) => String(d.id) === String(source.display_id));
  if (match) return match.bounds;
  if (displays.length === 1) return displays[0].bounds;
  // "Tela inteira" que junta vários monitores (X11): usa a área total.
  const xs = displays.map((d) => d.bounds);
  const x = Math.min(...xs.map((b) => b.x));
  const y = Math.min(...xs.map((b) => b.y));
  return {
    x, y,
    width: Math.max(...xs.map((b) => b.x + b.width)) - x,
    height: Math.max(...xs.map((b) => b.y + b.height)) - y,
  };
}

function setCaptureTarget(wc, bounds) {
  captureTargets.set(wc.id, bounds);
  // Sem tela inteira (ex.: passou a compartilhar uma janela), o injetor ignora os eventos.
  if (control.owner === wc) postInput({ t: 'target', bounds: bounds ? toPhysical(bounds) : null });
  wc.send('ponte:capture-target', { controllable: Boolean(bounds) && inputStatus.available });
}

// Aviso compacto, sempre por cima, no canto inferior direito da tela controlada (fora das barras
// de título e abas). A pessoa pode arrastá-lo; a posição escolhida vale até o app fechar.
const OVERLAY_SIZE = { width: 330, height: 40 };
let overlayMoved = false;
let overlayInTaskbar = false;

// Selo vermelho desenhado na hora (sem arquivo de imagem) para o botão da barra de tarefas.
function redDot(size = 16) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const i = (y * size + x) * 4;
      const inner = d <= c - 1.5;
      const ring = d <= c;
      // BGRA: vermelho com borda branca para aparecer em barras claras e escuras.
      buf[i] = inner ? 0x1f : 0xff;
      buf[i + 1] = inner ? 0x32 : 0xff;
      buf[i + 2] = inner ? 0xc4 : 0xff;
      buf[i + 3] = ring ? 0xff : 0;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// Minimizado, o aviso vira um botão na barra de tarefas ("Controle remoto ativo").
// Restaurado, volta a ser só o aviso flutuante (sem botão na barra).
function setOverlayInTaskbar(value) {
  if (!overlay || overlay.isDestroyed()) return;
  overlayInTaskbar = value;
  overlay.setSkipTaskbar(!value);
  if (process.platform === 'win32') overlay.setOverlayIcon(value ? redDot() : null, value ? 'Controle remoto ativo' : '');
}

function overlayPosition(target) {
  const { workArea } = screen.getDisplayMatching(target);
  return {
    x: Math.round(workArea.x + workArea.width - OVERLAY_SIZE.width - 16),
    y: Math.round(workArea.y + workArea.height - OVERLAY_SIZE.height - 16),
  };
}

function showOverlay(peerName, target) {
  if (!overlay || overlay.isDestroyed()) {
    overlay = new BrowserWindow({
      ...OVERLAY_SIZE, frame: false, resizable: false, movable: true, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, title: 'Ponte — controle remoto ativo',
      backgroundColor: '#c4321f', webPreferences: secureWebPreferences(),
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    overlay.on('moved', () => { overlayMoved = true; });
    overlay.on('restore', () => setOverlayInTaskbar(false));
    overlay.on('page-title-updated', (e) => e.preventDefault());
    overlay.loadURL(`${APP_ORIGIN}/overlay.html`);
  }
  if (!overlayMoved) {
    const { x, y } = overlayPosition(target);
    overlay.setPosition(x, y);
  }
  overlay.setTitle(`● Controle remoto ativo — ${peerName || 'alguém'} está controlando`);
  const reveal = () => {
    overlay?.webContents.send('ponte:overlay', { peerName, shortcut: SHORTCUT_LABEL });
    overlay?.showInactive(); // sem roubar o foco de quem está usando o computador
  };
  if (overlay.webContents.isLoading()) overlay.webContents.once('did-finish-load', reveal);
  else reveal();
}

function stopControl() {
  setInjecting(undefined, false);
  if (globalShortcut.isRegistered(REVOKE_ACCELERATOR)) globalShortcut.unregister(REVOKE_ACCELERATOR);
  if (overlay && !overlay.isDestroyed()) {
    // Próximo controle começa com o aviso visível de novo (não escondido na barra).
    if (overlay.isMinimized()) overlay.restore();
    setOverlayInTaskbar(false);
    overlay.hide();
  }
  control = { owner: null };
}

function revokeControl(reason) {
  const { owner } = control;
  stopControl();
  if (owner && !owner.isDestroyed()) owner.send('ponte:control-revoked', { reason });
}

function startControl(wc, peerName) {
  if (!inputStatus.available) return 'unavailable';
  if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
    systemPreferences.isTrustedAccessibilityClient(true); // abre o pedido de permissão do macOS
    return 'accessibility';
  }
  const target = captureTargets.get(wc.id);
  if (!target) return 'no_target';
  if (control.owner && control.owner !== wc) revokeControl('replaced');
  control = { owner: wc };
  setInjecting(target, true);
  // Canal direto janela -> processo de injeção (não passa pela linha principal; ver initInput).
  const { port1, port2 } = new MessageChannelMain();
  inputWorker.postMessage({ t: 'port' }, [port2]);
  wc.postMessage('ponte:input-port', null, [port1]);
  if (!globalShortcut.isRegistered(REVOKE_ACCELERATOR)) {
    globalShortcut.register(REVOKE_ACCELERATOR, () => revokeControl('shortcut'));
  }
  showOverlay(String(peerName).slice(0, 64), target);
  return 'ok';
}

/* ================= Atualização ================= */

function initUpdater() {
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = null;
  const mode = updateMode({ isPackaged: app.isPackaged, platform: process.platform, env: process.env });
  updater = createUpdater({
    autoUpdater,
    mode,
    isEnabled: () => settings.autoUpdate,
    onStatus: (status) => broadcast('ponte:update-status', status),
  });
  updater.start();
}

// "Há alguém usando este computador agora?": janelas com convite/sessão, controle ativo ou acesso sem
// supervisão autenticado. Sessões órfãs do servidor embutido (ninguém conectado, aguardando o prazo
// de reconexão) não contam: elas não dão acesso a nada.
const hasActiveSessions = () => Boolean(control.owner) || flowWindows.size > 0
  || [...unattendedSessions.values()].some((s) => s.authenticated);

/* ================= IPC ================= */

function registerIpc() {
  ipcMain.on('ponte:signaling-url', (event) => {
    event.returnValue = fromApp(event) ? signalingUrl : '';
  });
  ipcMain.handle('ponte:get-settings', (event) => (fromApp(event) ? {
    ...settings,
    version: app.getVersion(),
    input: inputStatus,
    shortcut: SHORTCUT_LABEL,
    update: updater.status,
  } : null));
  ipcMain.handle('ponte:save-settings', async (event, input) => {
    if (!fromApp(event)) return { ok: false, error: 'Origem não permitida.' };
    const result = validateSettings({ ...input, autoUpdate: settings.autoUpdate });
    if (!result.ok) return result;
    await saveSettings(app.getPath('userData'), result.value);
    // Trocar de servidor exige reiniciar (encerra sessões e o servidor embutido de forma limpa).
    setImmediate(() => {
      app.relaunch();
      app.exit(0);
    });
    return { ok: true };
  });
  ipcMain.handle('ponte:open-docs', (event) => (fromApp(event) ? shell.openExternal(DOCS_URL) : undefined));
  ipcMain.handle('ponte:choose-source', (event, requestId, sourceId) => {
    const pick = pendingPicks.get(requestId);
    if (!pick || pick.wc !== event.sender) return false;
    pendingPicks.delete(requestId);
    const source = sourceId ? pick.sources.find((s) => s.id === sourceId) : null;
    if (source) setCaptureTarget(pick.wc, targetForSource(source));
    pick.finish(source ? { video: source } : {});
    return true;
  });

  // Rede local — quem gera o convite.
  ipcMain.handle('ponte:lan-host-start', async (event, rawId, rawSecret) => {
    if (!fromApp(event) || settings.mode !== 'local') return { ok: false, error: 'not_available' };
    const sessionId = normalizeSessionId(rawId);
    const secret = normalizeSecret(rawSecret);
    if (!SESSION_ID_PATTERN.test(sessionId) || !SECRET_PATTERN.test(secret)) return { ok: false, error: 'invalid' };
    try {
      await ensureLan();
    } catch {
      return { ok: false, error: 'lan_unavailable' };
    }
    lan.invites.set(sessionId, { key: await deriveInviteKey(sessionId, secret), wcId: event.sender.id });
    return { ok: true, addresses: localAddresses().map((a) => a.address) };
  });
  ipcMain.handle('ponte:lan-invite-used', (event, sessionId) => {
    const entry = fromApp(event) ? lan?.invites.get(String(sessionId)) : null;
    if (entry) entry.key = null; // convite usado: deixa de responder a buscas
  });
  ipcMain.handle('ponte:lan-host-stop', (event, sessionId) => {
    if (!fromApp(event) || !lan) return;
    lan.invites.delete(String(sessionId));
    maybeCloseLan();
  });
  ipcMain.on('ponte:flow', (event, active) => {
    if (!fromApp(event)) return;
    if (active === true) flowWindows.add(event.sender.id);
    else flowWindows.delete(event.sender.id);
  });
  registerUnattendedIpc();

  // Rede local — quem presta suporte.
  ipcMain.handle('ponte:lan-discover', async (event, rawId, rawSecret, rawAddress) => {
    if (!fromApp(event) || settings.mode !== 'local') return { ok: false, error: 'not_available' };
    const sessionId = normalizeSessionId(rawId);
    const secret = normalizeSecret(rawSecret);
    const address = typeof rawAddress === 'string' ? rawAddress.trim() : '';
    if (!SESSION_ID_PATTERN.test(sessionId) || !SECRET_PATTERN.test(secret)) return { ok: false, error: 'invalid_credentials' };
    if (address && !isValidAddress(address)) return { ok: false, error: 'invalid_address' };
    // Convite criado em outra janela deste mesmo computador.
    if (!address && embedded.store.get(sessionId)) return { ok: true, url: signalingUrl };
    const found = await discover({ sessionId, secret, address: address || undefined });
    if (!found) return { ok: false, error: 'not_found' };
    const accepted = pinned.get(found.host) ?? new Set();
    accepted.add(found.fingerprint);
    pinned.set(found.host, accepted);
    return { ok: true, url: `wss://${found.host}:${found.port}/ws` };
  });

  // Controle remoto.
  ipcMain.handle('ponte:control-state', (event, active, peerName) => {
    if (!fromApp(event)) return 'denied';
    if (active) return startControl(event.sender, peerName ?? '');
    if (control.owner === event.sender) stopControl();
    return 'ok';
  });
  ipcMain.on('ponte:overlay-revoke', (event) => {
    if (overlay && event.sender === overlay.webContents) revokeControl('overlay');
  });
  ipcMain.on('ponte:overlay-minimize', (event) => {
    if (!overlay || event.sender !== overlay.webContents || !control.owner) return;
    setOverlayInTaskbar(true); // antes de minimizar: sem isso a janela sumiria sem botão
    overlay.minimize();
  });

  // Atualizações.
  ipcMain.handle('ponte:update-check', (event) => (fromApp(event) ? updater.check({ manual: true }) : false));
  ipcMain.handle('ponte:update-download', (event) => (fromApp(event) ? updater.download() : false));
  ipcMain.handle('ponte:update-install', (event) => {
    if (!fromApp(event)) return { ok: false };
    if (hasActiveSessions()) return { ok: false, error: 'session_active' };
    return { ok: updater.installNow() };
  });
  ipcMain.handle('ponte:open-releases', (event) => (fromApp(event) ? shell.openExternal(RELEASES_URL) : undefined));
  ipcMain.handle('ponte:set-auto-update', async (event, enabled) => {
    if (!fromApp(event)) return false;
    settings = { ...settings, autoUpdate: enabled === true };
    await saveSettings(app.getPath('userData'), settings);
    if (settings.autoUpdate) updater.check();
    return settings.autoUpdate;
  });
}


/* ================= Acesso sem supervisão ================= */

const SAFE_STORAGE_OK = () => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // No Linux sem chaveiro, o "basic_text" usa uma chave fixa: não conta como cofre.
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
  } catch {
    return false;
  }
};

async function initUnattended() {
  const vault = SAFE_STORAGE_OK();
  unattended = new UnattendedStore({
    dir: app.getPath('userData'),
    protection: vault ? 'system' : 'file',
    protect: (text) => (vault ? `s:${safeStorage.encryptString(text).toString('base64')}` : `p:${text}`),
    unprotect: (text) => {
      if (text.startsWith('s:')) return safeStorage.decryptString(Buffer.from(text.slice(2), 'base64'));
      if (text.startsWith('p:')) return text.slice(2);
      throw new Error('formato');
    },
  });
  await unattended.load();
  if (unattended.enabled) await activateUnattended();
}

async function activateUnattended() {
  try {
    await ensureLan();
  } catch {
    // rede local indisponível (porta ocupada/firewall): segue só pelo servidor
  }
  stopPresences();
  const urls = [loopbackUrl, ...(settings.mode === 'remote' ? [signalingUrl] : [])];
  const name = unattended.summary.deviceName || hostname();
  presences = urls.map((url) => {
    const presence = new DevicePresence({
      url,
      store: unattended,
      name,
      capabilities: { screenCapture: true, inputInjection: inputStatus.available },
      onIncoming: onUnattendedIncoming,
      onStatus: () => broadcastUnattended(),
    });
    presence.start();
    return presence;
  });
  ensureTray();
  broadcastUnattended();
}

function stopPresences() {
  for (const p of presences) p.stop();
  presences = [];
}

function deactivateUnattended() {
  stopPresences();
  for (const wcId of unattendedSessions.keys()) endUnattendedSession(wcId, 'disabled', true);
  tray?.destroy();
  tray = null;
  maybeCloseLan();
  broadcastUnattended();
}

function dotImage(size, [r, g, b]) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const i = (y * size + x) * 4;
      const inner = d <= c * 0.35;
      buf[i] = inner ? 0xff : b;
      buf[i + 1] = inner ? 0xff : g;
      buf[i + 2] = inner ? 0xff : r;
      buf[i + 3] = d <= c ? 0xff : 0;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function showMainWindow() {
  const [win] = appWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }
  return createWindow();
}

// Indicador permanente (não oculto): ícone na área de notificação enquanto o recurso estiver ativo.
function ensureTray() {
  const id = formatSessionId(unattended.deviceId ?? '');
  const menu = Menu.buildFromTemplate([
    { label: `Acesso sem supervisão ATIVADO — ID ${id}`, enabled: false },
    { type: 'separator' },
    { label: 'Abrir o Ponte', click: () => showMainWindow() },
    { label: 'Ajustes do acesso sem supervisão', click: () => { showMainWindow(); navigate('ajustes'); } },
    { type: 'separator' },
    {
      label: 'Desativar acesso sem supervisão…',
      click: async () => {
        const { response } = await dialog.showMessageBox({
          type: 'warning', buttons: ['Desativar', 'Cancelar'], defaultId: 0, cancelId: 1,
          message: 'Desativar o acesso sem supervisão?',
          detail: 'Ninguém mais conseguirá entrar neste computador sem aprovação. Sessões em andamento serão encerradas.',
        });
        if (response === 0) {
          await unattended.disable();
          deactivateUnattended();
        }
      },
    },
  ]);
  try {
    tray ??= new Tray(dotImage(32, [0x0a, 0x74, 0x69]));
    tray.setToolTip(`Ponte — acesso sem supervisão ativado (ID ${id})`);
    tray.setContextMenu(menu);
    tray.removeAllListeners('click');
    tray.on('click', () => showMainWindow());
  } catch {
    tray = null; // sem área de notificação neste sistema: o indicador fica no app
  }
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch {
    // notificações indisponíveis: o evento continua no log e no aviso do app
  }
}

async function unattendedStatus() {
  return {
    ...unattended.summary,
    presences: presences.map((p) => ({ internet: p.url !== loopbackUrl, status: p.status })),
    lan: Boolean(lan),
    remoteConfigured: settings.mode === 'remote',
    activeSessions: [...unattendedSessions.values()].filter((s) => s.authenticated).map(({ techName, techId }) => ({ techName, techId })),
    autostart: autostartStatus(),
    log: (await unattended.readLog(30)).map(({ ts, event, techName, reason }) => ({ ts, event, techName, reason })),
  };
}

function broadcastUnattended() {
  unattendedStatus().then((status) => broadcast('ponte:unattended-changed', status)).catch(() => {});
}

function autostartStatus() {
  if (process.platform === 'linux') return { supported: false, enabled: false };
  return { supported: true, enabled: app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin };
}

function onUnattendedIncoming(info) {
  if (!unattended?.enabled) return;
  const win = createWindow();
  const wcId = win.webContents.id;
  unattendedSessions.set(wcId, { sessionId: info.sessionId, techName: String(info.techName ?? '').slice(0, 64), techId: null, authenticated: false });
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('ponte:unattended-incoming', {
      sessionId: info.sessionId, hostToken: info.hostToken, techName: info.techName, requested: info.requested, url: info.url,
    });
  });
  unattended.log('session_requested', { techName: info.techName, via: info.url === loopbackUrl ? 'rede local' : 'internet' });
}

function endUnattendedSession(wcId, reason, tellWindow = false) {
  const s = unattendedSessions.get(wcId);
  if (!s) return;
  unattendedSessions.delete(wcId);
  if (tellWindow) webContents.fromId(wcId)?.send('ponte:unattended-revoked', { reason });
  if (s.authenticated) {
    notify('Acesso sem supervisão encerrado', `A sessão de ${s.techName || 'alguém'} terminou.`);
    unattended.log('session_ended', { techName: s.techName, techId: s.techId, reason });
  }
  broadcastUnattended();
}

async function getTechId() {
  const file = join(app.getPath('userData'), 'tech-id.txt');
  try {
    const id = (await readFile(file, 'utf8')).trim();
    if (/^[A-Za-z0-9_-]{16,64}$/.test(id)) return id;
  } catch {
    // ainda não existe
  }
  const id = randomBytes(18).toString('base64url');
  await writeFile(file, id, { mode: 0o600 });
  return id;
}

function registerUnattendedIpc() {
  const deny = { ok: false, error: 'denied' };
  const busy = { ok: false, error: 'session_active' };
  const sessionOf = (event) => (fromApp(event) ? unattendedSessions.get(event.sender.id) : null);

  // ----- Proprietário (no próprio computador) -----
  ipcMain.handle('ponte:unattended-status', async (event) => (fromApp(event) ? unattendedStatus() : null));
  ipcMain.handle('ponte:unattended-enable', async (event, input) => {
    if (!fromApp(event)) return deny;
    if (input?.confirm !== true) return { ok: false, error: 'not_confirmed' };
    // Ninguém consegue ativar controlando o computador remotamente: só sem sessões em andamento.
    if (hasActiveSessions()) return busy;
    const result = await unattended.enable({
      password: String(input.password ?? ''), deviceName: String(input.deviceName ?? ''), permissions: input.permissions,
    });
    if (!result.ok) return result;
    await activateUnattended();
    return { ok: true, status: await unattendedStatus() };
  });
  ipcMain.handle('ponte:unattended-change-password', async (event, password) => {
    if (!fromApp(event)) return deny;
    if (hasActiveSessions()) return busy;
    const result = await unattended.changePassword(String(password ?? ''));
    if (result.ok) broadcastUnattended();
    return result.ok ? { ok: true, status: await unattendedStatus() } : result;
  });
  ipcMain.handle('ponte:unattended-update', async (event, input) => {
    if (!fromApp(event)) return deny;
    // Restringir (bloquear novos dispositivos) vale sempre; ampliar acesso só sem sessões.
    const restrictOnly = input?.allowNewDevices === false && input.permissions === undefined;
    if (!restrictOnly && hasActiveSessions()) return busy;
    const result = await unattended.update({
      allowNewDevices: typeof input?.allowNewDevices === 'boolean' ? input.allowNewDevices : undefined,
      permissions: input?.permissions,
    });
    broadcastUnattended();
    return result.ok ? { ok: true, status: await unattendedStatus() } : result;
  });
  ipcMain.handle('ponte:unattended-revoke', async (event, techId) => {
    if (!fromApp(event)) return deny;
    const result = await unattended.revokeDevice(String(techId ?? ''));
    // Revogar encerra na hora a sessão desse dispositivo, se houver.
    for (const [wcId, s] of unattendedSessions) if (s.techId === techId) endUnattendedSession(wcId, 'revoked', true);
    broadcastUnattended();
    return result.ok ? { ok: true, status: await unattendedStatus() } : result;
  });
  ipcMain.handle('ponte:unattended-disable', async (event) => {
    if (!fromApp(event)) return deny;
    await unattended.disable();
    deactivateUnattended();
    return { ok: true, status: await unattendedStatus() };
  });
  ipcMain.handle('ponte:unattended-unlock', async (event) => {
    if (!fromApp(event)) return deny;
    if (hasActiveSessions()) return busy;
    const result = await unattended.unlock();
    return result.ok ? { ok: true, status: await unattendedStatus() } : result;
  });
  ipcMain.handle('ponte:autostart', (event, enabled) => {
    if (!fromApp(event) || process.platform === 'linux') return autostartStatus();
    app.setLoginItemSettings({ openAtLogin: enabled === true, args: ['--hidden'] });
    return autostartStatus();
  });

  // ----- Janela que atende uma sessão sem supervisão -----
  ipcMain.handle('ponte:unattended-challenge', (event) => {
    const s = sessionOf(event);
    if (!s || s.authenticated) return null;
    return unattended.createChallenge();
  });
  ipcMain.handle('ponte:unattended-verify', async (event, input) => {
    const s = sessionOf(event);
    if (!s || s.authenticated) return { ok: false, error: 'denied', retryAfter: 0 };
    const result = await unattended.verify({
      challengeId: String(input?.challengeId ?? ''),
      mac: String(input?.mac ?? ''),
      techId: String(input?.techId ?? '').slice(0, 64),
      techName: s.techName,
      binding: String(input?.binding ?? ''),
    });
    if (result.ok) {
      s.authenticated = true;
      s.techId = String(input.techId);
      notify('Acesso sem supervisão iniciado', `${s.techName || 'Alguém'} entrou neste computador com a senha de acesso.`);
      broadcastUnattended();
    }
    return result;
  });
  ipcMain.handle('ponte:unattended-capture', async (event) => {
    const s = sessionOf(event);
    if (!s?.authenticated) return null;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const primary = String(screen.getPrimaryDisplay().id);
    const source = sources.find((src) => String(src.display_id) === primary) ?? sources[0];
    if (!source) return null;
    setCaptureTarget(event.sender, targetForSource(source));
    return { sourceId: source.id };
  });
  ipcMain.handle('ponte:unattended-ended', (event, reason) => {
    if (fromApp(event)) endUnattendedSession(event.sender.id, String(reason ?? 'ended'));
  });

  // ----- Quem conecta a um computador sem supervisão -----
  ipcMain.handle('ponte:unattended-locate', async (event, rawId, rawAddress) => {
    if (!fromApp(event)) return deny;
    const deviceId = normalizeSessionId(rawId);
    const address = typeof rawAddress === 'string' ? rawAddress.trim() : '';
    if (!SESSION_ID_PATTERN.test(deviceId)) return { ok: false, error: 'invalid_device' };
    if (address && !isValidAddress(address)) return { ok: false, error: 'invalid_address' };
    // Este próprio computador (testes com duas janelas).
    if (!address && unattended.enabled && unattended.deviceId === deviceId) return { ok: true, url: loopbackUrl, via: 'local' };
    const found = await discoverDevice({ deviceId, address: address || undefined, timeoutMs: address ? 2500 : 1500 });
    if (found) {
      const accepted = pinned.get(found.host) ?? new Set();
      accepted.add(found.fingerprint);
      pinned.set(found.host, accepted);
      return { ok: true, url: `wss://${found.host}:${found.port}/ws`, via: 'lan' };
    }
    if (settings.mode === 'remote') return { ok: true, url: signalingUrl, via: 'internet' };
    return { ok: false, error: 'not_found' };
  });
  ipcMain.handle('ponte:unattended-proof', async (event, challenge, binding, password) => {
    if (!fromApp(event)) return null;
    const checked = validateDataMessage({ ...challenge, type: 'auth-challenge' });
    if (!checked.ok || typeof binding !== 'string' || binding.length > 2000) return null;
    if (typeof password !== 'string' || !password || password.length > 128) return null;
    const techId = await getTechId();
    // A senha é usada só aqui, para derivar a prova; não é guardada nem registrada.
    const mac = await computeProof(password, checked.value, { techId, binding });
    return { mac, techId };
  });
}

/* ================= Testes automatizados ================= */

function exposeTestHooks() {
  globalThis.__ponteTest = {
    mousePos: () => new Promise((resolve) => {
      const id = randomUUID();
      posRequests.set(id, resolve);
      postInput({ t: 'pos', id });
    }),
    controlActive: () => injecting && Boolean(control.owner),
    lanPort: () => lan?.port ?? null,
    overlayVisible: () => Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible()),
    overlayBounds: () => (overlay && !overlay.isDestroyed() ? overlay.getBounds() : null),
    overlayInTaskbar: () => overlayInTaskbar,
    minimizeOverlay: () => overlay?.webContents.executeJavaScript("document.getElementById('minimize').click()"),
    revokeViaShortcut: () => revokeControl('shortcut'),
    shortcutRegistered: () => globalShortcut.isRegistered(REVOKE_ACCELERATOR),
    unattendedSummary: () => unattended.summary,
    hasActiveSessions: () => hasActiveSessions(),
    unattendedSessions: () => [...unattendedSessions.values()],
    presenceStatus: () => presences.map((p) => p.status),
    readUnattendedFile: () => readFile(join(app.getPath('userData'), 'unattended.json'), 'utf8'),
    readSecurityLog: () => readFile(join(app.getPath('userData'), 'security-log.jsonl'), 'utf8').catch(() => ''),
  };
}

/* ================= Menus ================= */

function navigate(key) {
  const win = BrowserWindow.getFocusedWindow() ?? appWindows()[0];
  win?.webContents.send('ponte:navigate', key);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const settingsItem = { label: isMac ? 'Ajustes…' : 'Ajustes', accelerator: 'CmdOrCtrl+,', click: () => navigate('ajustes') };
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: `Sobre o ${app.name}` },
        { type: 'separator' },
        settingsItem,
        { type: 'separator' },
        { role: 'hide', label: `Ocultar ${app.name}` },
        { role: 'hideOthers', label: 'Ocultar outros' },
        { role: 'unhide', label: 'Mostrar tudo' },
        { type: 'separator' },
        { role: 'quit', label: `Sair do ${app.name}` },
      ],
    }] : []),
    {
      label: 'Arquivo',
      submenu: [
        { label: 'Nova janela', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { type: 'separator' },
        ...(isMac ? [] : [settingsItem, { type: 'separator' }]),
        { role: 'close', label: 'Fechar janela' },
        ...(isMac ? [] : [{ role: 'quit', label: 'Sair' }]),
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' },
        { role: 'redo', label: 'Refazer' },
        { type: 'separator' },
        { role: 'cut', label: 'Recortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar tudo' },
      ],
    },
    {
      label: 'Visualizar',
      submenu: [
        { role: 'zoomIn', label: 'Aumentar' },
        { role: 'zoomOut', label: 'Diminuir' },
        { role: 'resetZoom', label: 'Tamanho real' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tela cheia' },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools', label: 'Ferramentas de desenvolvimento' }]),
      ],
    },
    {
      label: 'Janela',
      submenu: [
        { role: 'minimize', label: 'Minimizar' },
        ...(isMac ? [{ role: 'zoom', label: 'Zoom' }, { type: 'separator' }, { role: 'front', label: 'Trazer tudo para a frente' }] : []),
      ],
    },
    {
      label: 'Ajuda',
      submenu: [
        { label: 'Procurar atualizações', click: () => { navigate('ajustes'); updater.check({ manual: true }); } },
        { label: 'Documentação', click: () => shell.openExternal(DOCS_URL) },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

app.on('window-all-closed', () => {
  // Com o acesso sem supervisão ativado, o app continua no ícone da área de notificação.
  if (process.platform !== 'darwin' && !unattended?.enabled) app.quit();
});

app.on('will-quit', () => {
  stopPresences();
  tray?.destroy();
  stopControl();
  inputWorker?.kill();
  globalShortcut.unregisterAll();
  closeLan();
  embedded?.close();
});
