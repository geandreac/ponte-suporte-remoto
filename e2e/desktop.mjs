// Teste do app de computador (Electron) com Playwright.
// No Linux sem monitor, rode com Xvfb (tela de 24 bits):
//   xvfb-run -a -s "-screen 0 1280x800x24" npm run test:desktop
// Capturas de tela ficam em e2e/output/desktop-*.png

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'e2e/output');
mkdirSync(OUT, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'ponte-desktop-'));

// PONTE_EXECUTABLE testa o executável empacotado (ex.: dist/linux-unpacked/ponte) em vez do código-fonte.
const packaged = process.env.PONTE_EXECUTABLE;
const noSandbox = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
const app = await electron.launch({
  executablePath: packaged || require('electron'),
  args: packaged ? noSandbox : [ROOT, ...noSandbox],
  env: { ...process.env, PONTE_USER_DATA: userData },
});

const steps = [];
async function step(name, fn) {
  try {
    await fn();
    steps.push(name);
    console.log(`✓ ${name}`);
  } catch (err) {
    console.log(`✗ ${name}`);
    throw err;
  }
}
const text = (page, sel) => page.textContent(sel).then((t) => t.trim());

try {
  const host = await app.firstWindow();
  await host.waitForSelector('#view-host:not([hidden])');
  const errors = [];
  host.on('pageerror', (e) => errors.push(e.message));

  await step('janela abre com a interface local, servidor embutido e menus em português', async () => {
    assert.equal(await host.title(), 'Ponte · Suporte remoto');
    assert.match(host.url(), /^ponte:\/\/app\/index\.html/);
    assert.match(await host.evaluate(() => window.ponteDesktop.signalingUrl), /^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
    const menus = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((i) => i.label));
    for (const label of ['Arquivo', 'Editar', 'Visualizar', 'Janela', 'Ajuda']) assert.ok(menus.includes(label), `menu ${label}`);
    assert.equal(await host.isVisible('.nav-item[data-nav=settings]'), true);
    await host.screenshot({ path: join(OUT, 'desktop-01-inicio.png') });
  });

  await step('isolamento: página sem Node, sem janelas novas e com CSP', async () => {
    const probe = await host.evaluate(() => ({
      require: typeof require, process: typeof process, open: window.open('https://example.com') === null,
      bridge: Object.keys(window.ponteDesktop).sort().join(','),
    }));
    assert.equal(probe.require, 'undefined');
    assert.equal(probe.process, 'undefined');
    assert.equal(probe.open, true);
    assert.equal(probe.bridge, 'chooseSource,getSettings,onNavigate,onSourceRequest,openDocs,platform,saveSettings,signalingUrl');
    const csp = await host.evaluate(async () => (await fetch('index.html')).headers.get('content-security-policy'));
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src 'self' ws:\/\/127\.0\.0\.1:\d+/);
  });

  await step('Ajustes valida o endereço do servidor (exige HTTPS)', async () => {
    await host.click('.nav-item[data-nav=settings]');
    await host.waitForSelector('#view-settings:not([hidden])');
    assert.equal(await host.isChecked('#mode-local'), true);
    assert.match(await text(host, '#app-version'), /^\d+\.\d+\.\d+/);
    await host.check('#mode-remote');
    await host.fill('#server-url', 'http://suporte.exemplo.com');
    await host.click('#form-settings button[type=submit]');
    await host.waitForFunction(() => document.querySelector('#err-server').textContent.includes('HTTPS'));
    await host.screenshot({ path: join(OUT, 'desktop-02-ajustes.png') });
    await host.check('#mode-local');
    await host.click('.nav-item[data-nav=host]');
  });

  let tech;
  await step('menu Arquivo › Nova janela abre a segunda janela', async () => {
    const opened = app.waitForEvent('window');
    await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu().items.find((i) => i.label === 'Arquivo');
      file.submenu.items.find((i) => i.label === 'Nova janela').click();
    });
    tech = await opened;
    await tech.waitForSelector('#view-host:not([hidden])');
    tech.on('pageerror', (e) => errors.push(e.message));
  });

  await step('convite, pedido e aprovação entre as duas janelas', async () => {
    await host.fill('#host-name', 'Maria');
    await host.click('#form-host button[type=submit]');
    await host.waitForSelector('#view-invite:not([hidden])');
    const id = await text(host, '#invite-id');
    const secret = await text(host, '#invite-secret');
    await tech.click('.nav-item[data-nav=tech]');
    await tech.fill('#tech-session', id);
    await tech.fill('#tech-secret', secret);
    await tech.fill('#tech-name', 'João');
    await tech.click('#form-tech button[type=submit]');
    await host.waitForSelector('#dlg-approve[open]');
    await host.check('#grant-chat');
    await host.click('#btn-accept');
  });

  await step('cancelar o seletor não compartilha nada e devolve a aprovação com explicação', async () => {
    await host.waitForSelector('#dlg-source[open]');
    assert.equal(await host.$eval('#dlg-approve', (d) => d.open), false, 'só um diálogo por vez');
    await host.click('#btn-source-cancel');
    await host.waitForSelector('#dlg-approve[open]');
    assert.match(await text(host, '#approve-error'), /não escolheu o que compartilhar/);
    assert.equal(await tech.isVisible('#view-pending'), true);
    await host.click('#btn-accept');
  });

  await step('seletor de tela do app lista as telas reais e só compartilha após a escolha', async () => {
    await host.waitForSelector('#dlg-source[open]');
    const cards = await host.$$('.source-card');
    assert.ok(cards.length >= 1, 'deveria listar ao menos uma tela');
    assert.match(await text(host, '.source-card span'), /^(Tela|Janela):/);
    await host.screenshot({ path: join(OUT, 'desktop-03-seletor.png') });
    await cards[0].click();
    await host.waitForSelector('#conn-status[data-kind=ok]', { timeout: 20000 });
    await tech.waitForSelector('#conn-status[data-kind=ok]', { timeout: 20000 });
    await tech.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
    assert.match(await text(host, '#banner-share'), /Sua tela está sendo compartilhada com João/);
    await host.screenshot({ path: join(OUT, 'desktop-04-sessao-anfitriao.png') });
    await tech.screenshot({ path: join(OUT, 'desktop-05-sessao-tecnico.png') });
  });

  await step('chat e encerramento funcionam no app', async () => {
    await tech.click('#tab-chat');
    await tech.fill('#chat-input', 'Oi do app');
    await tech.click('#form-chat button');
    await host.click('#tab-chat');
    await host.waitForFunction(() => document.querySelector('#chat-log').textContent.includes('Oi do app'));
    await host.click('#btn-end');
    await tech.waitForSelector('#view-ended:not([hidden])');
    assert.match(await text(tech, '#ended-reason'), /pessoa atendida encerrou/);
  });

  assert.deepEqual(errors, []);
  console.log(`\n${steps.length} etapas do app de computador OK.`);
} finally {
  // Se o teste falhar no meio de uma sessão, fechar abre a confirmação nativa; não espera por ela.
  const proc = app.process();
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
  try {
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // pasta temporária: se o processo ainda estiver liberando arquivos, o sistema limpa depois
  }
}
