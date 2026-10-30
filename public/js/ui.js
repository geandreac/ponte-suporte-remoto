// Utilitários de interface. Todo texto vindo de fora é inserido com textContent (nunca innerHTML).

import { PERMISSION_HINTS, PERMISSION_LABELS, PERMISSIONS } from '../../shared/permissions.js';

export const $ = (id) => document.getElementById(id);

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export const VIEWS = ['view-host', 'view-tech', 'view-history', 'view-settings', 'view-invite', 'view-pending', 'view-session', 'view-ended'];

export function showView(id, { focus = true } = {}) {
  for (const v of VIEWS) $(v).hidden = v !== id;
  // Leva o foco ao título da nova tela para leitores de tela anunciarem a mudança.
  if (focus) {
    const heading = $(id).querySelector('h1');
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0 });
}

export function currentView() {
  return VIEWS.find((v) => !$(v).hidden);
}

export function toast(text, kind = 'info', ms = 5000) {
  const node = el('div', { className: 'toast', role: kind === 'error' ? 'alert' : 'status', dataset: { kind } }, [
    icon(kind === 'error' ? 'warning' : 'info'), el('span', {}, text),
  ]);
  $('toasts').append(node);
  setTimeout(() => node.remove(), ms);
}

const closeTimers = new WeakMap();

export function openDialog(dlg) {
  // Reabrir durante a animação de saída cancela o fechamento pendente.
  clearTimeout(closeTimers.get(dlg));
  dlg.classList.remove('closing');
  if (!dlg.open) dlg.showModal();
}

// Fecha com uma animação curta (ou na hora, com "reduzir movimento").
export function closeDialog(dlg, returnValue) {
  if (!dlg.open) return;
  clearTimeout(closeTimers.get(dlg));
  if (reducedMotion()) return dlg.close(returnValue);
  dlg.classList.add('closing');
  closeTimers.set(dlg, setTimeout(() => {
    dlg.classList.remove('closing');
    if (dlg.open) dlg.close(returnValue);
  }, 120));
}

export function setBusy(button, busy, busyText) {
  if (busy) {
    button.dataset.label ??= button.textContent;
    if (busyText) button.textContent = busyText;
    button.setAttribute('aria-busy', 'true');
  } else {
    button.removeAttribute('aria-busy');
    if (button.dataset.label) button.textContent = button.dataset.label;
    delete button.dataset.label;
  }
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

// Lista de permissões com interruptores. `options[perm]` = { checked, disabled, hint }.
// `showState` acrescenta o texto "Liberado/Bloqueado" (usado durante a sessão).
export function renderPermissionChoices(container, { only = PERMISSIONS, options = {}, name, showState = false }) {
  container.replaceChildren();
  for (const p of only) {
    const opt = options[p] ?? {};
    const id = `${name}-${p}`;
    const hintId = `${id}-hint`;
    const input = el('input', {
      type: 'checkbox', className: 'switch', id, name: p,
      checked: Boolean(opt.checked), disabled: Boolean(opt.disabled),
    });
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-describedby', hintId);
    const row = el('label', { className: 'group-row perm-row', htmlFor: id, dataset: { disabled: String(Boolean(opt.disabled)) } }, [
      el('span', { className: 'row-text' }, [
        el('span', { className: 'row-title' }, PERMISSION_LABELS[p]),
        el('span', { className: 'row-hint', id: hintId }, opt.hint ?? PERMISSION_HINTS[p]),
      ]),
      showState ? el('span', { className: 'perm-state', dataset: { on: String(Boolean(opt.checked)) } }, opt.checked ? 'Liberado' : 'Bloqueado') : null,
      input,
    ]);
    container.append(row);
  }
}

export function readPermissionChoices(container) {
  const out = {};
  for (const input of container.querySelectorAll('input[type="checkbox"]')) out[input.name] = input.checked && !input.disabled;
  return out;
}

// Abas segmentadas acessíveis (setas, Home/End). `onChange(tabId)` é chamado ao trocar.
export function setupTabs(tablist, onChange) {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const select = (tab, focus = false) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
    onChange?.(tab.id);
  };
  tablist.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) select(tab);
  });
  tablist.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length], true);
  });
  return { select: (id) => select($(id)), selected: () => tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.id };
}

export function confirmDialog(title, text, { confirmLabel = 'Confirmar', destructive = false } = {}) {
  const dlg = $('dlg-confirm');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  const yes = $('confirm-yes');
  yes.textContent = confirmLabel;
  yes.className = `btn ${destructive ? 'btn-destructive' : 'btn-primary'}`;
  dlg.returnValue = '';
  openDialog(dlg);
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true });
  });
}
