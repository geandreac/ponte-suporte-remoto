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
  env: { ...process.env, PONTE_USER_DATA: userData, PONTE_TEST: '1' },
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
    assert.equal(probe.bridge, [
      'checkForUpdates', 'chooseSource', 'downloadUpdate', 'getSettings', 'injectInput', 'installUpdate',
      'lanDiscover', 'lanHostStart', 'lanHostStop', 'lanInviteUsed', 'minimizeOverlay', 'onCaptureTarget',
      'onControlRevoked', 'onNavigate', 'onOverlay', 'onSourceRequest', 'onUpdateStatus', 'openDocs', 'openReleases', 'platform',
      'revokeFromOverlay', 'saveSettings', 'setAutoUpdate', 'setControlActive', 'signalingUrl',
    ].join(','));
    const csp = await host.evaluate(async () => (await fetch('index.html')).headers.get('content-security-policy'));
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src 'self' ws:\/\/127\.0\.0\.1:\d+ wss:/);
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

  const mouse = () => app.evaluate(() => globalThis.__ponteTest.mousePos());
  const hook = (name) => app.evaluate((_e, n) => globalThis.__ponteTest[n](), name);

  await step('Ajustes mostram controle remoto e atualizações (sem atualizar fora do app instalado)', async () => {
    await host.click('.nav-item[data-nav=settings]');
    assert.match(await text(host, '#control-support'), /^Disponível/);
    assert.equal(await host.isDisabled('#auto-update'), !process.env.PONTE_EXECUTABLE);
    await host.click('.nav-item[data-nav=host]');
  });

  await step('rede local: código errado não encontra o convite', async () => {
    await host.fill('#host-name', 'Maria');
    await host.click('#form-host button[type=submit]');
    await host.waitForSelector('#view-invite:not([hidden])');
    await host.waitForSelector('#invite-lan[data-kind=ok]');
    assert.match(await text(host, '#invite-lan'), /Na rede local/);
    assert.ok(await hook('lanPort'), 'servidor TLS da rede local aberto durante o convite');
    await tech.click('#btn-home').catch(() => {});
    await tech.click('.nav-item[data-nav=tech]');
    await tech.waitForSelector('#view-tech:not([hidden])');
    await tech.fill('#tech-session', await text(host, '#invite-id'));
    await tech.fill('#tech-secret', 'ZZZZ-ZZZZ');
    await tech.fill('#tech-name', 'João');
    await tech.click('#lan-address-box summary');
    await tech.fill('#tech-address', '127.0.0.1');
    await tech.click('#form-tech button[type=submit]');
    await tech.waitForFunction(() => document.querySelector('#tech-form-error').textContent.includes('Não encontramos'), null, { timeout: 15000 });
  });

  await step('rede local: descoberta por UDP + TLS validado, com controle remoto pedido e liberado', async () => {
    await tech.fill('#tech-secret', await text(host, '#invite-secret'));
    await tech.check('#req-control');
    await tech.click('#form-tech button[type=submit]');
    await host.waitForSelector('#dlg-approve[open]', { timeout: 15000 });
    assert.equal(await host.isChecked('#grant-control'), false, 'controle nunca vem ligado');
    assert.match(await text(host, '#grant-control-hint'), /tela inteira/);
    await host.check('#grant-control');
    await host.click('#btn-accept');
    await host.waitForSelector('#dlg-source[open]');
    await host.click('.source-card');
    await tech.waitForSelector('#conn-status[data-kind=ok]', { timeout: 20000 });
    await tech.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
    // Sem a página de convite respondendo a buscas depois de usado.
    assert.equal(await hook('lanPort') !== null, true);
  });

  await step('controle remoto move o mouse real do sistema e mostra o aviso sempre visível', async () => {
    await host.waitForFunction(() => document.querySelector('#banner-control').textContent.includes('ATIVO'), null, { timeout: 10000 });
    assert.equal(await hook('overlayVisible'), true, 'aviso de controle visível');
    // Aviso compacto no canto inferior direito, fora das barras de título.
    const ob = await hook('overlayBounds');
    const wa = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    assert.ok(ob.width <= 340 && ob.height <= 48, `aviso compacto: ${JSON.stringify(ob)}`);
    // Minimizar o aviso cria um botão na barra de tarefas (para ciência do acesso).
    assert.equal(await hook('overlayInTaskbar'), false);
    await hook('minimizeOverlay');
    let inTaskbar = false;
    for (let i = 0; i < 20 && !inTaskbar; i++) {
      await tech.waitForTimeout(100);
      inTaskbar = await hook('overlayInTaskbar');
    }
    assert.equal(inTaskbar, true, 'botão na barra de tarefas enquanto minimizado');
    assert.ok(ob.x + ob.width <= wa.x + wa.width && ob.x > wa.x + wa.width / 2, 'à direita');
    assert.ok(ob.y + ob.height <= wa.y + wa.height && ob.y > wa.y + wa.height / 2, 'embaixo');
    assert.equal(await hook('shortcutRegistered'), true, 'atalho para retomar registrado');
    // Com as duas janelas no mesmo computador, o mouse real movido pelo controle não pode passar
    // por cima da janela do técnico (ela geraria novos eventos, em ciclo). Afasta a janela para a direita.
    await app.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows().filter((w) => !w.isAlwaysOnTop()).sort((a, b) => a.id - b.id);
      wins[1].setBounds({ x: 680, y: 0, width: 600, height: 800 });
    });
    await tech.waitForTimeout(500);
    await tech.waitForSelector('#btn-control:not([disabled])');
    await tech.click('#btn-control');
    assert.equal(await tech.getAttribute('#btn-control', 'aria-pressed'), 'true');
    const box = await tech.$eval('#video', (v) => {
      const r = v.getBoundingClientRect();
      const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
      const w = v.videoWidth * scale;
      const h = v.videoHeight * scale;
      return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, w, h };
    });
    const screenSize = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
    await tech.mouse.move(box.left + box.w * 0.25, box.top + box.h * 0.5);
    const expected = { x: Math.round(0.25 * (screenSize.width - 1)), y: Math.round(0.5 * (screenSize.height - 1)) };
    let pos = null;
    for (let i = 0; i < 40; i++) {
      pos = await mouse();
      if (Math.abs(pos.x - expected.x) <= 3 && Math.abs(pos.y - expected.y) <= 3) break;
      await tech.waitForTimeout(100);
    }
    assert.ok(Math.abs(pos.x - expected.x) <= 3 && Math.abs(pos.y - expected.y) <= 3, `mouse em ${JSON.stringify(pos)}, esperado ${JSON.stringify(expected)}`);
    assert.match(await text(tech, '#banner-control'), /Você está controlando/);
    await host.screenshot({ path: join(OUT, 'desktop-06-controle-anfitriao.png') });
    await tech.screenshot({ path: join(OUT, 'desktop-07-controle-tecnico.png') });
  });

  await step('pausar o compartilhamento suspende o controle; retomar devolve', async () => {
    await host.click('#btn-pause');
    await host.waitForFunction(() => !document.querySelector('#banner-control').textContent.includes('ATIVO'));
    assert.equal(await hook('controlActive'), false);
    await tech.waitForSelector('#btn-control[disabled]');
    await host.click('#btn-pause');
    await host.waitForFunction(() => document.querySelector('#banner-control').textContent.includes('ATIVO'));
    assert.equal(await hook('controlActive'), true);
  });

  await step('atalho de retomada revoga o controle na hora para os dois lados', async () => {
    await hook('revokeViaShortcut');
    assert.equal(await hook('controlActive'), false);
    await host.waitForFunction(() => document.querySelector('#banner-control').textContent.includes('desativado'));
    assert.equal(await host.isChecked('#live-control'), false);
    await tech.waitForSelector('#btn-control[disabled]');
    assert.equal(await hook('overlayVisible'), false);
    assert.equal(await hook('overlayInTaskbar'), false, 'botão da barra some ao parar o controle');
    assert.equal(await hook('shortcutRegistered'), false);
    // Mensagens de controle chegando depois da revogação não movem nada.
    const before = await mouse();
    await tech.mouse.move(10, 10);
    await tech.waitForTimeout(400);
    assert.deepEqual(await mouse(), before);
  });

  await step('religar o controle pede consentimento explícito', async () => {
    await host.click('#tab-perms');
    await host.click('label[for=live-control]');
    await host.waitForSelector('#dlg-confirm[open]');
    assert.match(await text(host, '#confirm-title'), /controle este computador/);
    await host.click('#dlg-confirm button[value=no]');
    await host.waitForSelector('#dlg-confirm', { state: 'hidden' });
    assert.equal(await host.isChecked('#live-control'), false);
    await host.click('#btn-end');
    await tech.waitForSelector('#view-ended:not([hidden])');
    let port = await hook('lanPort');
    for (let i = 0; i < 20 && port !== null; i++) {
      await host.waitForTimeout(100);
      port = await hook('lanPort');
    }
    assert.equal(port, null, 'rede local fechada ao fim da sessão');
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
