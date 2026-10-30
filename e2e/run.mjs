// Teste ponta a ponta com dois navegadores Chromium reais conectados por WebRTC.
// Requer Playwright + Chromium disponíveis (npx playwright install chromium, se necessário).
// Uso: npm run test:e2e   (capturas de tela ficam em e2e/output/)

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const OUT = fileURLToPath(new URL('./output/', import.meta.url));
mkdirSync(OUT, { recursive: true });

// Sem STUN: os dois navegadores estão na mesma máquina, candidatos locais bastam.
const app = createApp({ ...loadConfig({}), port: 0, stunUrls: [] }, { auditWrite: () => {} });
const { port } = await app.listen();
const BASE = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
  ],
});

const steps = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    steps.push(`✓ ${name} (${Date.now() - t} ms)`);
    console.log(`✓ ${name}`);
  } catch (err) {
    console.log(`✗ ${name}`);
    throw err;
  }
}

const errors = [];
async function newPage(label, options) {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], ...options });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] console: ${m.text()}`); });
  await page.goto(BASE);
  return page;
}

const text = (page, sel) => page.textContent(sel).then((t) => t.trim());

async function createInvite(host, name = 'Maria') {
  await host.fill('#host-name', name);
  await host.click('#form-host button[type=submit]');
  await host.waitForSelector('#view-invite:not([hidden])');
  return { id: await text(host, '#invite-id'), secret: await text(host, '#invite-secret') };
}

async function requestJoin(tech, invite, name = 'João Técnico', extra = []) {
  await tech.click('.nav-item[data-nav=tech]');
  await tech.waitForSelector('#view-tech:not([hidden])');
  await tech.fill('#tech-session', invite.id);
  await tech.fill('#tech-secret', invite.secret);
  await tech.fill('#tech-name', name);
  for (const p of extra) await tech.check(`#req-${p}`);
  await tech.click('#form-tech button[type=submit]');
}

try {
  const host = await newPage('anfitrião', { viewport: { width: 1280, height: 800 } });
  // Técnico no celular e com "reduzir movimento": a interface precisa funcionar igual sem animações.
  const tech = await newPage('técnico', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });

  await step('tela inicial: tarefa principal clara, campos com rótulo, navegação adaptada', async () => {
    assert.equal(await host.title(), 'Ponte · Suporte remoto');
    assert.equal(await text(host, '#host-title'), 'Receber suporte');
    assert.match(await text(host, '#capture-support'), /pode compartilhar a tela/);
    const unlabeled = await host.$$eval('input', (els) => els.filter((e) => !e.labels?.length && !e.getAttribute('aria-label')).map((e) => e.id));
    assert.deepEqual(unlabeled, []);
    // Computador: barra lateral. Celular: barra de abas inferior.
    const hostNav = await host.$eval('.sidebar', (n) => getComputedStyle(n).position);
    const techNav = await tech.$eval('.sidebar', (n) => getComputedStyle(n).position);
    assert.equal(hostNav, 'sticky');
    assert.equal(techNav, 'fixed');
    assert.equal(await host.getAttribute('.nav-item[data-nav=host]', 'aria-current'), 'page');
    // Ajustes só existem no app de computador.
    assert.equal(await host.isHidden('.nav-item[data-nav=settings]'), true);
    await host.screenshot({ path: join(OUT, '01-inicio-desktop.png') });
    await tech.screenshot({ path: join(OUT, '01-inicio-celular.png') });
    await host.emulateMedia({ colorScheme: 'dark' });
    await host.screenshot({ path: join(OUT, '01-inicio-desktop-escuro.png') });
    await host.emulateMedia({ colorScheme: 'light' });
  });

  await step('formulário do técnico mostra o erro junto do campo', async () => {
    await tech.click('.nav-item[data-nav=tech]');
    await tech.click('#form-tech button[type=submit]');
    assert.match(await text(tech, '#err-session'), /9 números/);
    assert.equal(await tech.getAttribute('#tech-session', 'aria-invalid'), 'true');
    assert.equal(await tech.evaluate(() => document.activeElement.id), 'tech-session');
    await tech.screenshot({ path: join(OUT, '02-erros-campo-celular.png'), fullPage: true });
  });

  await step('código errado é recusado com mensagem no campo do código', async () => {
    const other = await newPage('anfitrião-2', { viewport: { width: 1000, height: 700 } });
    const inv = await createInvite(other);
    await requestJoin(tech, { id: inv.id, secret: 'ZZZZ-ZZZZ' });
    await tech.waitForFunction(() => document.querySelector('#err-secret').textContent.includes('incorretos'));
    await other.click('#btn-cancel-invite');
    await other.waitForSelector('#view-ended:not([hidden])');
    await other.context().close();
  });

  await step('recusa do anfitrião: técnico vê que foi recusado', async () => {
    const inv = await createInvite(host);
    await requestJoin(tech, inv, 'Desconhecido');
    await host.waitForSelector('#dlg-approve[open]');
    assert.equal(await text(host, '#approve-name'), 'Desconhecido');
    await host.click('#btn-reject');
    await tech.waitForSelector('#view-ended:not([hidden])');
    assert.match(await text(tech, '#ended-reason'), /recusou/);
    assert.equal(await text(tech, '#ended-title'), 'Conexão não realizada');
    await tech.click('#btn-home');
    await host.click('#btn-cancel-invite');
    await host.click('#btn-home');
  });

  let invite;
  await step('convite, navegação travada na sessão e pedido com identidade', async () => {
    invite = await createInvite(host);
    assert.match(invite.id, /^\d{3} \d{3} \d{3}$/);
    assert.match(invite.secret, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    // Uma tarefa por vez: com convite ativo, as outras seções ficam desabilitadas.
    assert.equal(await host.getAttribute('.nav-item[data-nav=history]', 'aria-disabled'), 'true');
    assert.equal(await host.isVisible('#nav-session'), true);
    await host.screenshot({ path: join(OUT, '03-convite.png') });
    await requestJoin(tech, invite, 'João Técnico', ['files', 'record']);
    await tech.waitForSelector('#view-pending:not([hidden])');
    await host.waitForSelector('#dlg-approve[open]');
    assert.equal(await text(host, '#approve-name'), 'João Técnico');
    // Menor privilégio: só "ver a tela" vem ligado.
    assert.equal(await host.isChecked('#grant-view'), true);
    assert.equal(await host.isChecked('#grant-chat'), false);
    assert.equal(await host.isChecked('#grant-files'), false);
    assert.equal(await host.isChecked('#grant-record'), false);
    assert.equal(await host.getAttribute('#grant-view', 'role'), 'switch');
    await host.screenshot({ path: join(OUT, '04-aprovacao.png') });
    await tech.screenshot({ path: join(OUT, '04-aguardando-celular.png') });
  });

  await step('aprovação abre conexão WebRTC real com vídeo', async () => {
    await host.check('#grant-chat');
    await host.click('#btn-accept');
    await host.waitForSelector('#conn-status[data-kind=ok]', { timeout: 15000 });
    await tech.waitForSelector('#conn-status[data-kind=ok]', { timeout: 15000 });
    await tech.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 15000 });
    assert.match(await text(host, '#banner-share'), /Sua tela está sendo compartilhada com João Técnico/);
    assert.match(await text(tech, '#banner-share'), /Você está vendo a tela de Maria/);
    assert.match(await text(host, '#banner-control'), /desativado/);
    assert.equal(await text(host, '#session-title'), 'Sessão com João Técnico');
  });

  await step('código de verificação é igual nos dois lados', async () => {
    await host.waitForFunction(() => /\d{4} \d{4}/.test(document.querySelector('#verify-code').textContent));
    await tech.waitForFunction(() => /\d{4} \d{4}/.test(document.querySelector('#verify-code').textContent));
    assert.equal(await text(host, '#verify-code'), await text(tech, '#verify-code'));
  });

  await step('abas do painel funcionam com teclado (setas)', async () => {
    await host.focus('#tab-perms');
    await host.keyboard.press('ArrowRight');
    assert.equal(await host.getAttribute('#tab-chat', 'aria-selected'), 'true');
    assert.equal(await host.isVisible('#panel-chat'), true);
    assert.equal(await host.evaluate(() => document.activeElement.id), 'tab-chat');
  });

  await step('chat nos dois sentidos, com aviso de mensagem nova em outra aba', async () => {
    await tech.click('#tab-chat');
    await tech.fill('#chat-input', 'Olá, consegue me ver?');
    await tech.click('#form-chat button');
    await host.waitForFunction(() => document.querySelector('#chat-log').textContent.includes('Olá, consegue me ver?'));
    await tech.click('#tab-perms');
    await host.fill('#chat-input', '<img src=x onerror=alert(1)> sim!');
    await host.click('#form-chat button');
    await tech.waitForSelector('#chat-badge:not([hidden])');
    assert.match(await tech.getAttribute('#tab-chat', 'aria-label'), /1 mensagem nova/);
    await tech.click('#tab-chat');
    assert.equal(await tech.isHidden('#chat-badge'), true);
    assert.equal(await tech.$$eval('#chat-log img', (n) => n.length), 0, 'chat não pode interpretar HTML');
  });

  await step('arquivos ficam bloqueados até o anfitrião liberar', async () => {
    await tech.click('#tab-files');
    assert.equal(await tech.isHidden('#file-pick-label'), true);
    await host.click('#tab-perms');
    await host.check('#live-files');
    await tech.waitForSelector('#file-pick-label:not([hidden])');
  });

  await step('arquivo: confirmação inline de quem envia, aceite de quem recebe, conteúdo íntegro', async () => {
    const content = 'relatório de diagnóstico\n'.repeat(3000);
    await tech.setInputFiles('#file-input', { name: 'diagnostico.txt', mimeType: 'text/plain', buffer: Buffer.from(content) });
    await tech.waitForSelector('#file-confirm:not([hidden])');
    assert.match(await text(tech, '#file-confirm-text'), /diagnostico\.txt/);
    await tech.click('#btn-file-send');
    await host.waitForSelector('#dlg-file[open]');
    assert.equal(await text(host, '#file-dlg-name'), 'diagnostico.txt');
    await host.click('#form-file button[type=submit]');
    await host.click('#tab-files');
    await host.waitForSelector('#file-list a[download="diagnostico.txt"]', { timeout: 15000 });
    const [download] = await Promise.all([host.waitForEvent('download'), host.click('#file-list a[download="diagnostico.txt"]')]);
    assert.equal(await readFile(await download.path(), 'utf8'), content);
    await tech.waitForFunction(() => document.querySelector('#file-list').textContent.includes('Enviado: diagnostico.txt'));
  });

  await step('tipo proibido é barrado antes de sair do dispositivo', async () => {
    await tech.setInputFiles('#file-input', { name: 'ferramenta.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') });
    await tech.click('#btn-file-send');
    await tech.waitForFunction(() => document.querySelector('#toasts').textContent.includes('não permitido'));
    assert.equal(await host.isVisible('#dlg-file'), false);
  });

  await step('pausar e retomar o compartilhamento', async () => {
    await host.click('#btn-pause');
    await tech.waitForFunction(() => document.querySelector('#stage-overlay').textContent.includes('pausou'));
    assert.match(await text(host, '#banner-share'), /pausado/);
    assert.equal(await text(host, '#btn-pause'), 'Retomar');
    await host.screenshot({ path: join(OUT, '05-sessao-pausada.png') });
    await host.click('#btn-pause');
    await tech.waitForFunction(() => document.querySelector('#stage-overlay').textContent === '');
  });

  await step('gravação exige permissão e aparece para o anfitrião', async () => {
    assert.equal(await tech.isDisabled('#btn-record'), true);
    await host.click('#tab-perms');
    await host.check('#live-record');
    await tech.waitForFunction(() => !document.querySelector('#btn-record').disabled);
    await tech.click('#btn-record');
    await tech.click('#confirm-yes');
    await host.waitForSelector('#banner-record-item:not([hidden])');
    assert.match(await text(host, '#banner-record'), /gravando/);
    await tech.screenshot({ path: join(OUT, '06-sessao-tecnico-celular.png'), fullPage: true });
    await host.screenshot({ path: join(OUT, '06-sessao-anfitriao.png') });
    await host.emulateMedia({ colorScheme: 'dark' });
    await host.screenshot({ path: join(OUT, '06-sessao-anfitriao-escuro.png') });
    await host.emulateMedia({ colorScheme: 'light' });
  });

  await step('revogar gravação para a gravação e libera o arquivo no técnico', async () => {
    await host.uncheck('#live-record');
    await host.waitForSelector('#banner-record-item', { state: 'hidden' });
    await tech.waitForSelector('#file-list a[download$=".webm"]', { timeout: 10000 });
  });

  await step('revogar chat bloqueia o chat do técnico', async () => {
    await host.uncheck('#live-chat');
    await tech.waitForSelector('#form-chat', { state: 'hidden' });
    assert.equal(await tech.$eval('#chat-disabled', (n) => n.hidden), false);
  });

  await step('revogar "ver a tela" para o vídeo imediatamente', async () => {
    await host.uncheck('#live-view');
    await tech.waitForFunction(() => document.querySelector('#stage-overlay').textContent.includes('não foi liberada'));
    assert.match(await text(host, '#banner-share'), /não está sendo compartilhada/);
  });

  await step('encerrar pelo anfitrião encerra para os dois e grava histórico', async () => {
    await host.click('#btn-end');
    await host.waitForSelector('#view-ended:not([hidden])');
    await tech.waitForSelector('#view-ended:not([hidden])');
    assert.match(await text(tech, '#ended-reason'), /pessoa atendida encerrou/);
    assert.match(await text(host, '#ended-reason'), /Você encerrou/);
    await tech.screenshot({ path: join(OUT, '07-encerrada-celular.png') });
    await host.click('#btn-home');
    await host.click('.nav-item[data-nav=history]');
    await host.waitForSelector('#view-history:not([hidden])');
    assert.match(await text(host, '#history-list'), /Ajuda de João Técnico/);
    await host.screenshot({ path: join(OUT, '08-historico.png') });
    await tech.click('#btn-home');
    await tech.click('.nav-item[data-nav=history]');
    await tech.waitForSelector('#view-history:not([hidden])');
    assert.match(await text(tech, '#history-list'), /Ajuda para Maria/);
  });

  await step('limpar histórico pede confirmação', async () => {
    await host.click('#btn-clear-history');
    await host.waitForSelector('#dlg-confirm[open]');
    assert.match(await host.getAttribute('#confirm-yes', 'class'), /btn-destructive/);
    await host.click('#dlg-confirm button[value=no]');
    await host.waitForSelector('#dlg-confirm', { state: 'hidden' });
    assert.match(await text(host, '#history-list'), /Ajuda de João Técnico/);
  });

  await step('queda da sinalização: os dois lados retomam sozinhos e a sessão continua', async () => {
    await host.click('.nav-item[data-nav=host]');
    const inv = await createInvite(host);
    await requestJoin(tech, inv);
    await host.waitForSelector('#dlg-approve[open]');
    await host.check('#grant-chat');
    await host.click('#btn-accept');
    await tech.waitForSelector('#conn-status[data-kind=ok]', { timeout: 15000 });
    for (const ws of app.signaling.wss.clients) ws.terminate();
    await host.waitForSelector('#signal-status[data-status=reconnecting]');
    await host.waitForSelector('#signal-status[data-status=online]', { timeout: 15000 });
    await tech.waitForFunction(() => document.querySelector('#signal-status').dataset.status === 'online', null, { timeout: 15000 });
    assert.equal(await host.getAttribute('#conn-status', 'data-kind'), 'ok');
    await tech.click('#tab-chat');
    await tech.fill('#chat-input', 'ainda aqui');
    await tech.click('#form-chat button');
    await host.click('#tab-chat');
    await host.waitForFunction(() => document.querySelector('#chat-log').textContent.includes('ainda aqui'));
    // Quem presta suporte confirma antes de encerrar.
    await tech.click('#btn-end');
    await tech.click('#confirm-yes');
    await host.waitForSelector('#view-ended:not([hidden])');
    assert.match(await text(host, '#ended-reason'), /Quem prestava suporte encerrou/);
  });

  // Ruído esperado: quedas de WebSocket provocadas pelo teste de reconexão e o aviso que o Chromium
  // emite porque a captura de tela *simulada* (--use-fake-device-for-media-stream) passa pelo
  // caminho de câmera, bloqueado de propósito pela nossa Permissions-Policy (camera=()).
  const unexpected = errors.filter((e) => !e.includes('WebSocket') && !e.includes('Permissions policy violation: camera'));
  assert.deepEqual(unexpected, [], `erros no navegador:\n${errors.join('\n')}`);
  writeFileSync(join(OUT, 'resultado.txt'), `${steps.join('\n')}\n`);
  console.log(`\n${steps.length} etapas ponta a ponta OK. Capturas em e2e/output/`);
} finally {
  await browser.close();
  await app.close();
}
