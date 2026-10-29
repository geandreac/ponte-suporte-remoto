import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp(config);
const address = await app.listen();
const scheme = app.tls ? 'https' : 'http';
const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(config.host);

console.log(`Ponte rodando em ${scheme}://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${address.port}`);
if (!app.tls && !isLoopback && !config.trustProxy) {
  console.warn('AVISO: servidor exposto sem TLS. Navegadores exigem HTTPS para compartilhar a tela e o tráfego de sinalização ficaria em claro. Configure TLS_CERT_FILE/TLS_KEY_FILE ou um proxy reverso com HTTPS (TRUST_PROXY=1).');
}
if (!app.ice.hasTurn) {
  console.warn('AVISO: nenhum servidor TURN configurado. Conexões entre redes com NAT restritivo podem falhar (veja docs/IMPLANTACAO.md).');
}

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
