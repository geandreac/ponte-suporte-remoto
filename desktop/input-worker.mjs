// Processo separado que injeta teclado e mouse (Electron utilityProcess).
//
// Por que separado: no Windows, um clique injetado na barra de título de uma janela do próprio
// app (ex.: botão minimizar) faz o sistema entrar num laço modal que segura a linha principal até
// o botão ser solto. Se a injeção dependesse dessa linha, o "soltar" nunca chegaria e o app
// inteiro travaria. Por isso os eventos chegam aqui por um canal DIRETO (MessagePort) vindo da
// janela que recebe os comandos, sem passar pela linha principal.
//
// Do processo principal (controle): { t: 'target', bounds } em pixels físicos, { t: 'enabled', value },
// { t: 'port' } com o canal da janela dona do controle, { t: 'pos', id } (só testes).
// Pelo canal direto: as mensagens 'input' do protocolo.
import { createRequire } from 'node:module';
import { createInjector } from './input.mjs';

const port = process.parentPort;
let injector = null;
let robot = null;

try {
  robot = createRequire(import.meta.url)('@jitsi/robotjs');
  robot.setMouseDelay(0);
  robot.setKeyboardDelay(0);
  injector = createInjector({ robot });
  port.postMessage({ t: 'ready', ok: true });
} catch (err) {
  port.postMessage({ t: 'ready', ok: false, error: String(err?.message ?? err) });
}

let inputPort = null;
let lastInjectAt = 0;

// Proteção extra: botão "preso" sem nenhum comando por 15 s é solto (evita travar o sistema
// num arraste ou clique que nunca termina, por exemplo se a conexão cair no meio).
const STUCK_BUTTON_MS = 15_000;
setInterval(() => {
  if (injector?.pressedCount && Date.now() - lastInjectAt > STUCK_BUTTON_MS) injector.releaseAll();
}, 1_000).unref?.();

function attachInputPort(newPort) {
  inputPort?.close();
  inputPort = newPort ?? null;
  if (!inputPort) return;
  inputPort.on('message', ({ data }) => {
    try {
      if (injector?.handle(data)) lastInjectAt = Date.now();
    } catch {
      // um evento que falhou não pode derrubar o processo de controle
    }
  });
  inputPort.start();
}

port.on('message', ({ data, ports }) => {
  if (!injector || !data || typeof data !== 'object') return;
  try {
    switch (data.t) {
      case 'target':
        injector.setTarget(data.bounds ?? null);
        break;
      case 'enabled':
        injector.setEnabled(data.value === true);
        if (data.value !== true) attachInputPort(null);
        break;
      case 'port':
        attachInputPort(ports?.[0]);
        break;
      case 'pos':
        port.postMessage({ t: 'pos', id: data.id, pos: robot.getMousePos(), lastInjectAt });
        break;
      default:
    }
  } catch {
    // idem
  }
});
