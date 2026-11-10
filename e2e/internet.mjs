// Acesso sem supervisão PELA INTERNET com o app real: duas instâncias independentes do Ponte
// (como dois computadores) usando um servidor de conexão externo (o papel da Oracle Cloud).
// A busca na rede local do "técnico" usa outra porta, então ela falha e a conexão é obrigada a
// passar pelo servidor. Linux sem monitor:  xvfb-run -a -s "-screen 0 1280x800x24" node e2e/internet.mjs

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
// join remove a barra final: no Windows, "pasta\" escaparia a aspa ao lançar o Electron.
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = join(ROOT, 'e2e/output');
mkdirSync(OUT, { recursive: true });

// Servidor de conexão "na internet".
const server = createApp({ ...loadConfig({}), port: 0, stunUrls: [] }, { auditWrite: () => {} });
const { port } = await server.listen();
const serverUrl = `http://localhost:${port}`;

const dirs = [];
async function launch(label, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), `ponte-${label}-`));
  dirs.push(dir);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ mode: 'remote', serverUrl, autoUpdate: true }));
  const app = await electron.launch({
    executablePath: process.env.PONTE_EXECUTABLE || require('electron'),
    args: [...(process.env.PONTE_EXECUTABLE ? [] : [ROOT]), ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
    env: { ...process.env, PONTE_USER_DATA: dir, PONTE_TEST: '1', ...env },
  });
  const win = await app.firstWindow();
  await win.waitForSelector('#view-host:not([hidden])');
  return { app, win };
}

const text = (page, sel) => page.textContent(sel).then((t) => t.trim());
const steps = [];
const step = async (name, fn) => {
  try {
    await fn();
    steps.push(name);
    console.log(`✓ ${name}`);
  } catch (err) {
    console.log(`✗ ${name}`);
    throw err;
  }
};

let home;
let work;
try {
  home = await launch('casa');
  work = await launch('trabalho', { PONTE_LAN_PORT: '47811' });
  const PASSWORD = 'Casa-Rio#2026!azul';
  let deviceId;

  await step('computador de casa ativa o acesso sem supervisão e fica disponível no servidor da internet', async () => {
    const w = home.win;
    await w.click('.nav-item[data-nav=settings]');
    await w.click('#btn-ua-setup');
    await w.fill('#ua-dlg-name', 'PC de casa');
    await w.fill('#ua-dlg-password', PASSWORD);
    await w.fill('#ua-dlg-password2', PASSWORD);
    await w.check('#ua-dlg-understand');
    await w.click('#btn-ua-dlg-submit');
    await w.waitForSelector('#ua-on:not([hidden])', { timeout: 20000 });
    deviceId = (await text(w, '#ua-device-id')).replace(/\s/g, '');
    await w.waitForFunction(() => document.querySelector('#ua-presence').textContent.includes('Internet: conectado'), null, { timeout: 20000 });
  });

  await step('do "trabalho", a busca local falha e a conexão vai pelo servidor da internet', async () => {
    const w = work.win;
    await w.click('.nav-item[data-nav=tech]');
    await w.click('#tab-mode-unattended');
    await w.fill('#ua-device', deviceId);
    await w.fill('#ua-password', PASSWORD);
    await w.fill('#ua-name', 'Notebook do trabalho');
    const opened = home.app.waitForEvent('window', { timeout: 30000 });
    await w.click('#btn-ua-connect');
    const deviceWin = await opened;
    await w.waitForSelector('#conn-status[data-kind=ok]', { timeout: 30000 });
    await w.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 30000 });
    assert.equal(await w.evaluate(() => window.ponteDesktop.signalingUrl), `ws://localhost:${port}/ws`);
    assert.equal(server.store.size, 1, 'a sessão foi criada no servidor da internet');
    await deviceWin.waitForFunction(() => document.querySelector('#banner-share').textContent.includes('Notebook do trabalho'));
    await w.screenshot({ path: join(OUT, 'internet-01-tecnico.png') });
    await w.click('#btn-end');
    await w.click('#confirm-yes');
    await deviceWin.waitForSelector('#view-ended:not([hidden])', { timeout: 15000 });
  });
  console.log(`\n${steps.length} etapas pela internet OK.`);
} finally {
  for (const inst of [home, work]) {
    if (!inst) continue;
    const proc = inst.app.process();
    await Promise.race([inst.app.close(), new Promise((r) => setTimeout(r, 5000))]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
  await server.close();
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // pasta temporária
    }
  }
}
