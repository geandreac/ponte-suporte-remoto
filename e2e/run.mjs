// Teste ponta a ponta com dois navegadores Chromium reais conectados por WebRTC.
// Requer Playwright + Chromium disponíveis (npx playwright install chromium, se necessário).
// Uso: npm run test:e2e   (screenshots ficam em e2e/output/)

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
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
async function newPage(label, viewport) {
  const ctx = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] console: ${m.text()}`); });
  await page.goto(BASE);
  return page;
}

async function createInvite(host, name = 'Maria') {
  await host.fill('#host-name', name);
  await host.click('#form-host button[type=submit]');
  await host.waitForSelector('#view-invite:not([hidden])');
  return {
    id: (await host.textContent('#invite-id')).trim(),
    secret: (await host.textContent('#invite-secret')).trim(),
  };
}

async function requestJoin(tech, invite, name = 'João Técnico', extra = []) {
  await tech.fill('#tech-session', invite.id);
  await tech.fill('#tech-secret', invite.secret);
  await tech.fill('#tech-name', name);
  for (const p of extra) await tech.check(`#req-${p}`);
  await tech.click('#form-tech button[type=submit]');
}

const text = (page, sel) => page.textContent(sel).then((t) => t.trim());

try {
  const host = await newPage('anfitrião', { width: 1280, height: 800 });
  const tech = await newPage('técnico', { width: 390, height: 844 }); // celular

  await step('tela inicial carrega sem erros e com rótulos acessíveis', async () => {
    assert.equal(await host.title(), 'Ponte · Suporte remoto');
    assert.match(await text(host, '#capture-support'), /permite compartilhar/);
    const unlabeled = await host.$$eval('input:not([type=hidden])', (els) => els.filter((e) => !e.labels?.length && !e.getAttribute('aria-label')).map((e) => e.id));
    assert.deepEqual(unlabeled, []);
    await host.screenshot({ path: join(OUT, '01-inicio-desktop.png'), fullPage: true });
    await tech.screenshot({ path: join(OUT, '01-inicio-celular.png'), fullPage: true });
  });

  await step('código errado é recusado com mensagem clara', async () => {
    const wrongHost = await newPage('anfitrião-2', { width: 1000, height: 700 });
    const inv = await createInvite(wrongHost);
    await requestJoin(tech, { id: inv.id, secret: 'ZZZZ-ZZZZ' });
    await tech.waitForFunction(() => document.querySelector('#tech-form-error').textContent.includes('incorretos'));
    await wrongHost.click('#btn-cancel-invite');
    await wrongHost.waitForSelector('#view-ended:not([hidden])');
    await wrongHost.context().close();
  });

  await step('recusa do anfitrião: técnico vê que foi recusado', async () => {
    const inv = await createInvite(host);
    await requestJoin(tech, inv, 'Desconhecido');
    await host.waitForSelector('#dlg-approve[open]');
    assert.equal(await text(host, '#approve-name'), 'Desconhecido');
    await host.click('#btn-reject');
    await tech.waitForSelector('#view-ended:not([hidden])');
    assert.match(await text(tech, '#ended-reason'), /recusou/);
    await tech.click('#btn-home');
    await host.click('#btn-cancel-invite');
    await host.click('#btn-home');
  });

  let invite;
  await step('convite, pedido com identidade e permissões pedidas', async () => {
    invite = await createInvite(host);
    assert.match(invite.id, /^\d{3} \d{3} \d{3}$/);
    assert.match(invite.secret, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    await host.screenshot({ path: join(OUT, '02-convite.png'), fullPage: true });
    await requestJoin(tech, invite, 'João Técnico', ['files', 'record']);
    await tech.waitForSelector('#view-pending:not([hidden])');
    await host.waitForSelector('#dlg-approve[open]');
    assert.equal(await text(host, '#approve-name'), 'João Técnico');
    // Menor privilégio: só "ver a tela" vem marcado; controle está indisponível na web.
    assert.equal(await host.isChecked('#grant-view'), true);
    assert.equal(await host.isChecked('#grant-chat'), false);
    assert.equal(await host.isChecked('#grant-files'), false);
    assert.equal(await host.isChecked('#grant-record'), false);
    await host.screenshot({ path: join(OUT, '03-aprovacao.png') });
  });

  await step('aprovação abre conexão WebRTC real com vídeo nos dois lados', async () => {
    await host.check('#grant-chat');
    await host.click('#btn-accept');
    await host.waitForSelector('#conn-status[data-state=connected]', { timeout: 15000 });
    await tech.waitForSelector('#conn-status[data-state=connected]', { timeout: 15000 });
    await tech.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 15000 });
    assert.match(await text(host, '#banner-share'), /Sua tela está sendo compartilhada com João Técnico/);
    assert.match(await text(tech, '#banner-share'), /Você está vendo a tela de Maria/);
    assert.match(await text(host, '#banner-control'), /desativado/);
  });

  await step('código de verificação é igual nos dois lados', async () => {
    await host.waitForFunction(() => /\d{4} \d{4}/.test(document.querySelector('#verify-code').textContent));
    await tech.waitForFunction(() => /\d{4} \d{4}/.test(document.querySelector('#verify-code').textContent));
    assert.equal(await text(host, '#verify-code'), await text(tech, '#verify-code'));
  });

  await step('chat nos dois sentidos', async () => {
    await tech.fill('#chat-input', 'Olá, consegue me ver?');
    await tech.click('#form-chat button');
    await host.waitForFunction(() => document.querySelector('#chat-log').textContent.includes('Olá, consegue me ver?'));
    await host.fill('#chat-input', '<img src=x onerror=alert(1)> sim!');
    await host.click('#form-chat button');
    await tech.waitForFunction(() => document.querySelector('#chat-log').textContent.includes('sim!'));
    assert.equal(await tech.$$eval('#chat-log img', (n) => n.length), 0, 'chat não pode interpretar HTML');
  });

  await step('arquivos ficam bloqueados até o anfitrião liberar', async () => {
    assert.equal(await tech.isHidden('#file-pick-label'), true);
    await host.check('#live-files');
    await tech.waitForSelector('#file-pick-label:not([hidden])');
  });

  await step('arquivo do técnico exige confirmação dos dois lados e chega íntegro', async () => {
    const content = 'relatório de diagnóstico\n'.repeat(3000);
    await tech.setInputFiles('#file-input', { name: 'diagnostico.txt', mimeType: 'text/plain', buffer: Buffer.from(content) });
    await tech.waitForSelector('#dlg-confirm[open]');
    await tech.click('#confirm-yes');
    await host.waitForSelector('#dlg-file[open]');
    assert.equal(await text(host, '#file-dlg-name'), 'diagnostico.txt');
    await host.click('#form-file button[type=submit]');
    await host.waitForSelector('#file-list a[download="diagnostico.txt"]', { timeout: 15000 });
    const [download] = await Promise.all([
      host.waitForEvent('download'),
      host.click('#file-list a[download="diagnostico.txt"]'),
    ]);
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(await download.path(), 'utf8'), content);
    await tech.waitForFunction(() => document.querySelector('#file-list').textContent.includes('Enviado: diagnostico.txt'));
  });

  await step('tipo proibido é barrado antes de sair do navegador', async () => {
    await tech.setInputFiles('#file-input', { name: 'ferramenta.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') });
    await tech.click('#confirm-yes');
    await tech.waitForFunction(() => document.querySelector('#toasts').textContent.includes('não permitido'));
    assert.equal(await host.isVisible('#dlg-file[open]'), false);
  });

  await step('pausar e retomar o compartilhamento', async () => {
    await host.click('#btn-pause');
    await tech.waitForFunction(() => document.querySelector('#stage-overlay').textContent.includes('pausou'));
    assert.match(await text(host, '#banner-share'), /pausado/);
    await host.screenshot({ path: join(OUT, '04-sessao-anfitriao-pausada.png'), fullPage: true });
    await host.click('#btn-pause');
    await tech.waitForFunction(() => document.querySelector('#stage-overlay').textContent === '');
  });

  await step('gravação exige permissão e aparece para o anfitrião', async () => {
    assert.equal(await tech.isDisabled('#btn-record'), true);
    await host.check('#live-record');
    await tech.waitForFunction(() => !document.querySelector('#btn-record').disabled);
    await tech.click('#btn-record');
    await tech.click('#confirm-yes');
    await host.waitForSelector('#banner-record:not([hidden])');
    assert.match(await text(host, '#banner-record'), /gravando/);
    await tech.screenshot({ path: join(OUT, '05-sessao-tecnico-celular.png'), fullPage: true });
    await host.screenshot({ path: join(OUT, '05-sessao-anfitriao.png'), fullPage: true });
  });

  await step('revogar gravação para a gravação e libera o arquivo só no técnico', async () => {
    await host.uncheck('#live-record');
    await host.waitForSelector('#banner-record', { state: 'hidden' });
    await tech.waitForSelector('#file-list a[download$=".webm"]', { timeout: 10000 }).catch(async (err) => {
      console.log('DEBUG eventos técnico:', await text(tech, '#event-log'));
      console.log('DEBUG arquivos técnico:', await text(tech, '#file-list'));
      throw err;
    });
  });

  await step('revogar chat esconde o chat do técnico', async () => {
    await host.uncheck('#live-chat');
    await tech.waitForSelector('#form-chat', { state: 'hidden' });
    assert.equal(await tech.isVisible('#chat-disabled'), true);
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
    await tech.screenshot({ path: join(OUT, '06-encerrada-celular.png'), fullPage: true });
    await host.click('#btn-home');
    assert.match(await text(host, '#history-list'), /Suporte recebido de João Técnico/);
    await tech.click('#btn-home');
    assert.match(await text(tech, '#history-list'), /Suporte prestado a Maria/);
  });

  await step('queda da sinalização: os dois lados retomam sozinhos e a sessão continua', async () => {
    const inv = await createInvite(host);
    await requestJoin(tech, inv);
    await host.waitForSelector('#dlg-approve[open]');
    await host.check('#grant-chat');
    await host.click('#btn-accept');
    await tech.waitForSelector('#conn-status[data-state=connected]', { timeout: 15000 });
    // Derruba todas as conexões WebSocket no servidor (simula queda de rede/proxy).
    for (const ws of app.signaling.wss.clients) ws.terminate();
    await host.waitForSelector('#signal-status[data-status=reconnecting]');
    await host.waitForSelector('#signal-status[data-status=online]', { timeout: 15000 });
    await tech.waitForSelector('#signal-status[data-status=online]', { timeout: 15000 });
    // O WebRTC é independente do servidor: a sessão e o chat seguem funcionando.
    assert.equal(await host.getAttribute('#conn-status', 'data-state'), 'connected');
    await tech.fill('#chat-input', 'ainda aqui');
    await tech.click('#form-chat button');
    await host.waitForFunction(() => document.querySelector('#chat-log').textContent.includes('ainda aqui'));
    // Encerrar depende da sinalização retomada.
    await tech.click('#btn-end');
    await host.waitForSelector('#view-ended:not([hidden])');
    assert.match(await text(host, '#ended-reason'), /Quem prestava suporte encerrou/);
  });

  // Ruído esperado: quedas de WebSocket provocadas pelo teste de reconexão e o aviso que o Chromium
  // emite porque a captura de tela *simulada* (--use-fake-device-for-media-stream) passa pelo
  // caminho de câmera, bloqueado de propósito pela nossa Permissions-Policy (camera=()).
  const unexpected = errors.filter((e) => !e.includes('WebSocket') && !e.includes('Permissions policy violation: camera'));
  assert.deepEqual(unexpected, [], `erros no navegador:\n${errors.join('\n')}`);
  writeFileSync(join(OUT, 'resultado.txt'), `${steps.join('\n')}\n`);
  console.log(`\n${steps.length} etapas ponta a ponta OK. Screenshots em e2e/output/`);
} finally {
  await browser.close();
  await app.close();
}
