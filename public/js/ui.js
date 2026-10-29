// Utilitários de interface. Todo texto vindo de fora é inserido com textContent (nunca innerHTML).

import { PERMISSION_HINTS, PERMISSION_LABELS, PERMISSIONS } from '../../shared/permissions.js';

export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) node.append(c);
  return node;
}

const VIEWS = ['view-home', 'view-invite', 'view-pending', 'view-session', 'view-ended'];

export function showView(id) {
  for (const v of VIEWS) $(v).hidden = v !== id;
  // Leva o foco ao título da nova tela para leitores de tela anunciarem a mudança.
  const heading = $(id).querySelector('h1');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0 });
}

export function toast(text, kind = 'info', ms = 5000) {
  const node = el('div', { className: 'toast', role: kind === 'error' ? 'alert' : 'status', dataset: { kind } }, text);
  $('toasts').append(node);
  setTimeout(() => node.remove(), ms);
}

export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function countdown(node, expiresAt, onDone) {
  const tick = () => {
    const left = expiresAt - Date.now();
    node.textContent = formatClock(left);
    if (left <= 0) {
      clearInterval(timer);
      onDone?.();
    }
  };
  const timer = setInterval(tick, 1000);
  tick();
  return () => clearInterval(timer);
}

// Lista de permissões com checkbox. `options[perm]` = { checked, disabled, hint }.
export function renderPermissionChoices(container, { only = PERMISSIONS, options = {}, name }) {
  container.replaceChildren();
  for (const p of only) {
    const opt = options[p] ?? {};
    const id = `${name}-${p}`;
    const input = el('input', { type: 'checkbox', id, name: p, checked: Boolean(opt.checked), disabled: Boolean(opt.disabled) });
    const hintId = `${id}-hint`;
    input.setAttribute('aria-describedby', hintId);
    const label = el('label', { className: 'perm-item', htmlFor: id, dataset: { disabled: String(Boolean(opt.disabled)) } }, [
      input,
      el('span', { className: 'perm-label' }, PERMISSION_LABELS[p]),
      el('span', { className: 'perm-hint', id: hintId }, opt.hint ?? PERMISSION_HINTS[p]),
    ]);
    container.append(label);
  }
}

export function readPermissionChoices(container) {
  const out = {};
  for (const input of container.querySelectorAll('input[type="checkbox"]')) out[input.name] = input.checked && !input.disabled;
  return out;
}

export function confirmDialog(title, text, confirmLabel = 'Confirmar') {
  const dlg = $('dlg-confirm');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-yes').textContent = confirmLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true });
  });
}
