// Gera build/icon.png (1024px) a partir de build/icon.svg usando o Chromium do Playwright.
// O electron-builder converte esse PNG nos formatos de cada sistema (.ico, .icns, Linux).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const svg = readFileSync(new URL('../build/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="1024" height="1024" ')}</body></html>`);
await page.screenshot({ path: new URL('../build/icon.png', import.meta.url).pathname, omitBackground: true });
await browser.close();
console.log('build/icon.png gerado');
