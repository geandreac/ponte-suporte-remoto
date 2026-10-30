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
  app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeTheme, protocol, screen,
  session, shell, systemPreferences, webContents,
} from 'electron';
import electronUpdater from 'electron-updater';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, MIME, resolveStaticPath, securityHeaders } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import {
  normalizeSecret, normalizeSessionId, SECRET_PATTERN, SESSION_ID_PATTERN,
} from '../shared/protocol.js';
import { createInjector, REVOKE_ACCELERATOR } from './input.mjs';
import {
  createResponder, deriveInviteKey, discover, ensureCertificate, isValidAddress, localAddresses,
} from './lan.mjs';
import { loadSettings, saveSettings, signalingUrlFor, validateSettings } from './settings.mjs';
import { createUpdater, RELEASES_URL, updateMode } from './updater.mjs';

const APP_ORIGIN = 'ponte://app';
const DOCS_URL = 'https://github.com/geandreac/ponte-suporte-remoto#readme';
const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const ALLOWED_PERMISSIONS = new Set(['display-capture', 'clipboard-sanitized-write', 'fullscreen']);
const SHORTCUT_LABEL = process.platform === 'darwin' ? '⌘⌥⇧X' : 'Ctrl+Alt+Shift+X';

if (process.env.PONTE_USER_DATA) app.setPath('userData', process.env.PONTE_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: 'ponte', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let settings = null;
let signalingUrl = '';
let connectSrc = ["'self'"];
let embedded = null;
const pendingPicks = new Map();
const captureTargets = new Map(); // webContents.id -> área da tela compartilhada (ou null)
const pinned = new Map(); // host -> impressões digitais aceitas (rede local)
let lan = null;
let lanStarting = null;
let robot = null;
let injector = null;
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
  if (settings.mode === 'remote') {
    signalingUrl = signalingUrlFor(settings.serverUrl);
    const ws = new URL(signalingUrl);
    connectSrc = ["'self'", `${ws.protocol}//${ws.host}`];
  } else {
    embedded = createApp(
      { ...loadConfig({}), host: '127.0.0.1', port: 0, auditLogFile: join(userData, 'audit.log') },
    );
    const { port } = await embedded.listen();
    signalingUrl = `ws://127.0.0.1:${port}/ws`;
    // wss: para alcançar o computador de quem gerou o convite na rede local (certificado validado por pinning).
    connectSrc = ["'self'", `ws://127.0.0.1:${port}`, 'wss:'];
  }

  inputStatus = initInput();
  registerProtocol();
  hardenSession();
  registerIpc();
  initUpdater();
  Menu.setApplicationMenu(buildMenu());
  createWindow();
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
    if (control.owner?.id === wcId) stopControl();
    if (lan) {
      for (const [id, entry] of lan.invites) if (entry.wcId === wcId) lan.invites.delete(id);
      if (lan.invites.size === 0) closeLan();
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
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(isAppUrl(details.requestingUrl) && ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => isAppUrl(origin) && ALLOWED_PERMISSIONS.has(permission));

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

function closeLan() {
  const current = lan;
  lan = null;
  if (!current) return;
  current.responder.close();
  current.server.closeAllConnections?.();
  current.server.close();
}

/* ================= Controle remoto ================= */

function initInput() {
  if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
    return { available: false, reason: 'wayland' };
  }
  try {
    robot = createRequire(import.meta.url)('@jitsi/robotjs');
    robot.setMouseDelay(0);
    robot.setKeyboardDelay(0);
    injector = createInjector({
      robot,
      // Windows/Linux trabalham em pixels físicos; o Electron informa a tela em pontos lógicos.
      toScreenPoint: (p) => (process.platform === 'darwin' ? p : screen.dipToScreenPoint(p)),
    });
    return { available: true, reason: '' };
  } catch {
    return { available: false, reason: 'module' };
  }
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
  if (control.owner === wc) injector.setTarget(bounds);
  wc.send('ponte:capture-target', { controllable: Boolean(bounds) && inputStatus.available });
}

function showOverlay(peerName, target) {
  const width = 600;
  if (!overlay || overlay.isDestroyed()) {
    overlay = new BrowserWindow({
      width, height: 56, frame: false, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, title: 'Ponte — controle remoto',
      backgroundColor: '#c4321f', webPreferences: secureWebPreferences(),
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    overlay.loadURL(`${APP_ORIGIN}/overlay.html`);
  }
  overlay.setPosition(Math.round(target.x + (target.width - width) / 2), Math.round(target.y + 12));
  const reveal = () => {
    overlay?.webContents.send('ponte:overlay', { peerName, shortcut: SHORTCUT_LABEL });
    overlay?.showInactive();
  };
  if (overlay.webContents.isLoading()) overlay.webContents.once('did-finish-load', reveal);
  else reveal();
}

function stopControl() {
  injector?.setEnabled(false);
  if (globalShortcut.isRegistered(REVOKE_ACCELERATOR)) globalShortcut.unregister(REVOKE_ACCELERATOR);
  if (overlay && !overlay.isDestroyed()) overlay.hide();
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
  injector.setTarget(target);
  injector.setEnabled(true);
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

const hasActiveSessions = () => Boolean(control.owner) || (embedded?.store.size ?? 0) > 0;

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
    if (lan.invites.size === 0) closeLan();
  });

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
  ipcMain.on('ponte:input', (event, msg) => {
    if (control.owner && event.sender === control.owner) injector.handle(msg);
  });
  ipcMain.on('ponte:overlay-revoke', (event) => {
    if (overlay && event.sender === overlay.webContents) revokeControl('overlay');
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

/* ================= Testes automatizados ================= */

function exposeTestHooks() {
  globalThis.__ponteTest = {
    mousePos: () => robot?.getMousePos() ?? null,
    controlActive: () => Boolean(injector?.active),
    lanPort: () => lan?.port ?? null,
    overlayVisible: () => Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible()),
    revokeViaShortcut: () => revokeControl('shortcut'),
    shortcutRegistered: () => globalShortcut.isRegistered(REVOKE_ACCELERATOR),
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
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  stopControl();
  globalShortcut.unregisterAll();
  closeLan();
  embedded?.close();
});
