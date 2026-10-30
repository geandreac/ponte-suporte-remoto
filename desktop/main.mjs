// Processo principal do app de computador (Electron).
//
// - A interface é a mesma da versão web, servida por um protocolo próprio e seguro (ponte://app),
//   em janelas isoladas: sem Node na página, sandbox ligado, navegação externa bloqueada.
// - Modo "neste computador": sobe o servidor de sinalização embutido só em 127.0.0.1
//   (para testes com duas janelas). Modo "servidor da organização": conecta via WSS.
// - A captura de tela passa pelo seletor do app (ou do sistema, no macOS), sempre com escolha da pessoa.

import {
  app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeTheme, protocol, session, shell, webContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, MIME, resolveStaticPath, securityHeaders } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { loadSettings, saveSettings, signalingUrlFor, validateSettings } from './settings.mjs';

const APP_ORIGIN = 'ponte://app';
const DOCS_URL = 'https://github.com/geandreac/ponte-suporte-remoto#readme';
const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const ALLOWED_PERMISSIONS = new Set(['display-capture', 'clipboard-sanitized-write', 'fullscreen']);

if (process.env.PONTE_USER_DATA) app.setPath('userData', process.env.PONTE_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: 'ponte', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let settings = null;
let signalingUrl = '';
let connectSrc = ["'self'"];
let embedded = null;
const pendingPicks = new Map();

const isAppUrl = (url) => typeof url === 'string' && (url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`));
const fromApp = (event) => isAppUrl(event.senderFrame?.url);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
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
  } else {
    embedded = createApp(
      { ...loadConfig({}), host: '127.0.0.1', port: 0, auditLogFile: join(userData, 'audit.log') },
    );
    const { port } = await embedded.listen();
    signalingUrl = `ws://127.0.0.1:${port}/ws`;
  }
  const ws = new URL(signalingUrl);
  connectSrc = ["'self'", `${ws.protocol}//${ws.host}`];

  registerProtocol();
  hardenSession();
  registerIpc();
  Menu.setApplicationMenu(buildMenu());
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

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

function hardenSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(isAppUrl(details.requestingUrl) && ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => isAppUrl(origin) && ALLOWED_PERMISSIONS.has(permission));

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
  }, { useSystemPicker: process.platform === 'darwin' });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });
}

function registerIpc() {
  ipcMain.on('ponte:signaling-url', (event) => {
    event.returnValue = fromApp(event) ? signalingUrl : '';
  });
  ipcMain.handle('ponte:get-settings', (event) => (fromApp(event) ? { ...settings, version: app.getVersion() } : null));
  ipcMain.handle('ponte:save-settings', async (event, input) => {
    if (!fromApp(event)) return { ok: false, error: 'Origem não permitida.' };
    const result = validateSettings(input);
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
    pick.finish(source ? { video: source } : {});
    return true;
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 380,
    minHeight: 560,
    title: 'Ponte',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121417' : '#f3f4f6',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
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

function navigate(key) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
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
      submenu: [{ label: 'Documentação', click: () => shell.openExternal(DOCS_URL) }],
    },
  ];
  return Menu.buildFromTemplate(template);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  embedded?.close();
});
