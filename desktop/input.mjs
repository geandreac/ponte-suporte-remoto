// Injeção de teclado e mouse no sistema (controle remoto), só no app de computador.
//
// Regras:
// - Só age quando habilitado pela janela que compartilha a tela E com um alvo definido
//   (uma TELA inteira: compartilhando só uma janela, não há como mapear coordenadas com segurança).
// - Toda mensagem é validada de novo aqui (coordenadas 0–1, teclas e botões conhecidos).
// - Ao desabilitar, solta qualquer botão do mouse que tenha ficado pressionado.
// - Teclas de texto são digitadas pelo caractere (funciona com qualquer layout, ex.: ABNT2);
//   atalhos (Ctrl+C, Alt+Tab, setas…) usam a tecla física com os modificadores.

import { validateDataMessage } from '../shared/protocol.js';

export const REVOKE_ACCELERATOR = 'CommandOrControl+Alt+Shift+X';

const NAMED_KEYS = {
  Enter: 'enter', NumpadEnter: 'enter', Backspace: 'backspace', Tab: 'tab', Escape: 'escape',
  Space: 'space', Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end',
  PageUp: 'pageup', PageDown: 'pagedown',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`F${i}`] = `f${i}`;

const MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn',
]);

const BUTTONS = ['left', 'middle', 'right'];

export function codeToKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  return NAMED_KEYS[code] ?? null;
}

// No robotjs, "command" é a tecla ⌘ no macOS e a tecla Windows/Super nos demais sistemas.
export function modifierList(msg) {
  const mods = [];
  if (msg.shift) mods.push('shift');
  if (msg.ctrl) mods.push('control');
  if (msg.alt) mods.push('alt');
  if (msg.meta) mods.push('command');
  return mods;
}

// Decide como reproduzir uma tecla: { type: 'text', text } ou { type: 'tap', key, modifiers } ou null.
export function planKey(msg) {
  if (msg.kind !== 'keydown' || MODIFIER_CODES.has(msg.code)) return null;
  const printable = typeof msg.key === 'string' && [...msg.key].length === 1;
  // AltGr (ex.: "/" no ABNT2) chega como Ctrl+Alt no Windows: ainda é texto.
  const altGr = msg.ctrl && msg.alt && !msg.meta;
  if (printable && msg.code !== 'Space' && ((!msg.ctrl && !msg.alt && !msg.meta) || altGr)) {
    return { type: 'text', text: msg.key };
  }
  const key = codeToKey(msg.code);
  if (!key) return null;
  return { type: 'tap', key, modifiers: modifierList(msg) };
}

// Converte coordenadas normalizadas (0–1) para pixels do sistema dentro do alvo.
export function toTargetPoint(target, x, y) {
  const px = target.x + Math.min(Math.max(x, 0), 1) * (target.width - 1);
  const py = target.y + Math.min(Math.max(y, 0), 1) * (target.height - 1);
  return { x: Math.round(px), y: Math.round(py) };
}

export function wheelTicks(deltaY) {
  const ticks = Math.round(deltaY / 100) || Math.sign(deltaY);
  return Math.max(-10, Math.min(10, ticks));
}

// `robot`: módulo @jitsi/robotjs (ou um dublê nos testes).
// `toScreenPoint`: converte pontos lógicos (DIP) para pixels físicos quando o sistema exige.
export function createInjector({ robot, toScreenPoint = (p) => p }) {
  let enabled = false;
  let target = null;
  const pressed = new Set();

  const releaseAll = () => {
    for (const button of pressed) {
      try {
        robot.mouseToggle('up', button);
      } catch {
        // ignora: o objetivo é não deixar botão preso
      }
    }
    pressed.clear();
  };

  const move = (x, y) => {
    const p = toScreenPoint(toTargetPoint(target, x, y));
    robot.moveMouse(Math.round(p.x), Math.round(p.y));
  };

  return {
    get active() {
      return enabled && Boolean(target);
    },
    setTarget(bounds) {
      releaseAll();
      target = bounds && bounds.width > 0 && bounds.height > 0 ? { ...bounds } : null;
    },
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) releaseAll();
    },
    releaseAll,
    handle(raw) {
      if (!enabled || !target) return false;
      const result = validateDataMessage(raw);
      if (!result.ok || result.value.type !== 'input') return false;
      const msg = result.value;
      switch (msg.kind) {
        case 'pointermove':
          move(msg.x, msg.y);
          return true;
        case 'pointerdown':
        case 'pointerup': {
          const button = BUTTONS[msg.button];
          move(msg.x, msg.y);
          robot.mouseToggle(msg.kind === 'pointerdown' ? 'down' : 'up', button);
          if (msg.kind === 'pointerdown') pressed.add(button);
          else pressed.delete(button);
          return true;
        }
        case 'wheel':
          move(msg.x, msg.y);
          robot.scrollMouse(0, -wheelTicks(msg.deltaY));
          return true;
        case 'keydown': {
          const plan = planKey(msg);
          if (!plan) return false;
          if (plan.type === 'text') robot.typeString(plan.text);
          else robot.keyTap(plan.key, plan.modifiers);
          return true;
        }
        default:
          return false;
      }
    },
  };
}
