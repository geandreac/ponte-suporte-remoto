// Interface: navegação, formulários e ligação da tela de sessão aos controladores.

import { clearHistory, loadHistory } from './history.js';
import { endMessage, errorMessage, STATE_TEXT } from './messages.js';
import { SessionRecorder } from './recorder.js';
import { canCaptureScreen, HostController, ViewerController } from './session-controller.js';
import { startRemoteInput } from './remote-input.js';
import { SignalingClient } from './signaling-client.js';
import {
  $, closeDialog, confirmDialog, countdown, currentView, el, formatSize, formatTime, icon, openDialog,
  readPermissionChoices, renderPermissionChoices, setBusy, setupTabs, showView, toast,
} from './ui.js';
import { ACCEPT_ATTRIBUTE, FILE_ERROR_MESSAGES } from '../../shared/file-policy.js';
import { capabilityAllows, PERMISSION_HINTS, PERMISSION_LABELS, PERMISSIONS } from '../../shared/permissions.js';
import {
  formatSecret, formatSessionId, normalizeSecret, normalizeSessionId, sanitizeName, SECRET_PATTERN, SESSION_ID_PATTERN,
} from '../../shared/protocol.js';

// No app de computador, o preload informa o servidor configurado. No navegador, é o próprio site.
const desktop = window.ponteDesktop ?? null;
const wsUrl = desktop?.signalingUrl ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
// Informações do app de computador (modo de conexão, controle remoto, atualização). Carregadas em setupDesktop().
let desktopInfo = null;
const lanMode = () => desktopInfo?.mode === 'local';
const shortcutLabel = () => desktopInfo?.shortcut ?? 'Ctrl+Alt+Shift+X';

let controller = null;
let stopCountdown = () => {};
let stopDialogCountdown = () => {};
const objectUrls = new Set();
const BASE_TITLE = document.title;
const FLOW_VIEWS = new Set(['view-invite', 'view-pending', 'view-session']);

/* ================= Navegação ================= */

const ROUTES = { receber: 'view-host', prestar: 'view-tech', historico: 'view-history', ajustes: 'view-settings', sessao: null };
const NAV_FOR_VIEW = {
  'view-host': 'host', 'view-tech': 'tech', 'view-history': 'history', 'view-settings': 'settings',
  'view-invite': 'session', 'view-pending': 'session', 'view-session': 'session', 'view-ended': null,
};

function inFlow() {
  return Boolean(controller && !['idle', 'ended', 'failed'].includes(controller.state));
}

function syncNav() {
  const flow = inFlow();
  if (updateStatus) renderUpdate(updateStatus);
  document.body.dataset.flow = flow ? 'active' : 'idle';
  $('nav-session').hidden = !flow;
  const active = NAV_FOR_VIEW[currentView()];
  for (const a of document.querySelectorAll('.nav-item')) {
    const key = a.dataset.nav;
    if (key === active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
    // Durante uma sessão a navegação fica presa a ela: uma tarefa por vez.
    const locked = flow && key !== 'session';
    a.setAttribute('aria-disabled', String(locked));
    a.tabIndex = locked ? -1 : 0;
  }
}

function go(viewId, options) {
  showView(viewId, options);
  syncNav();
}

function route() {
  if (inFlow()) return syncNav();
  const key = location.hash.slice(1);
  const view = ROUTES[key] ?? 'view-host';
  if (view === 'view-settings' && !desktop) return go('view-host', { focus: false });
  if (view === 'view-history') renderHistory();
  go(view, { focus: Boolean(key) });
}
window.addEventListener('hashchange', route);

/* ================= Servidor ================= */

const SIGNAL_TEXT = {
  online: 'Servidor conectado',
  connecting: 'Conectando ao servidor…',
  reconnecting: 'Reconectando ao servidor…',
  waking: 'Acordando o servidor (pode levar até 1 minuto)…',
  offline: 'Servidor desconectado',
};
// Cada sessão tem sua conexão de sinalização (na rede local, quem presta suporte se conecta
// direto ao computador de quem gerou o convite).
function createSignaling(url) {
  const client = new SignalingClient(url);
  client.addEventListener('status', (e) => {
    if (controller?.signaling !== client) return;
    $('signal-status').dataset.status = e.detail;
    $('signal-status').querySelector('.status-text').textContent = SIGNAL_TEXT[e.detail];
    // Servidor gratuito em repouso: o botão em andamento explica a espera.
    if (e.detail === 'waking') {
      for (const id of ['btn-create-invite', 'btn-join']) {
        if ($(id).getAttribute('aria-busy') === 'true') setBusy($(id), true, 'Acordando o servidor…');
      }
    }
  });
  return client;
}

// Integração do controle remoto (só no app de computador, quando o sistema permite).
function controlPlatform() {
  if (!desktop || !desktopInfo?.input?.available) return null;
  return {
    inputInjection: true,
    setControlActive: (active, peerName) => desktop.setControlActive(active, peerName),
    injectInput: (msg) => desktop.injectInput(msg),
  };
}

/* ================= Receber suporte ================= */

function renderCaptureSupport() {
  const row = $('capture-support');
  row.replaceChildren();
  let kind = 'ok';
  let text = 'Este dispositivo pode compartilhar a tela.';
  if (!canCaptureScreen()) {
    kind = 'warning';
    text = window.isSecureContext
      ? 'Este navegador não compartilha a tela (comum em celulares). Chat e arquivos continuam disponíveis.'
      : 'Compartilhar a tela exige conexão segura (HTTPS).';
  }
  row.dataset.kind = kind;
  row.append(icon(kind === 'ok' ? 'check' : 'warning'), el('span', {}, text));
}

function showHostError(text) {
  $('home-error').textContent = text;
  $('home-error').hidden = !text;
}

$('form-host').addEventListener('submit', (e) => {
  e.preventDefault();
  showHostError('');
  setBusy($('btn-create-invite'), true, 'Gerando convite…');
  const host = new HostController({ signaling: createSignaling(wsUrl), platform: controlPlatform() });
  useController(host);
  host.start(sanitizeName($('host-name').value));
});

/* ================= Prestar suporte ================= */

function renderTechPermissions() {
  renderPermissionChoices($('tech-perms'), {
    name: 'req',
    options: {
      view: { checked: true },
      chat: { checked: true },
      control: { hint: 'Funciona quando a outra pessoa usa o app de computador e compartilha a tela inteira.' },
    },
  });
}

function setFieldError(input, errorEl, message) {
  input.setAttribute('aria-invalid', String(Boolean(message)));
  errorEl.textContent = message;
}

function showTechError(text) {
  $('tech-form-error').textContent = text;
  $('tech-form-error').hidden = !text;
}

$('form-tech').addEventListener('submit', async (e) => {
  e.preventDefault();
  showTechError('');
  const sessionId = normalizeSessionId($('tech-session').value);
  const secret = normalizeSecret($('tech-secret').value);
  const name = sanitizeName($('tech-name').value);
  const requested = readPermissionChoices($('tech-perms'));
  const checks = [
    [$('tech-session'), $('err-session'), SESSION_ID_PATTERN.test(sessionId) ? '' : 'Digite os 9 números do ID da sessão.'],
    [$('tech-secret'), $('err-secret'), SECRET_PATTERN.test(secret) ? '' : 'O código tem 8 letras e números. Não usa 0, 1, I, L nem O.'],
    [$('tech-name'), $('err-name'), name ? '' : 'Digite seu nome para a pessoa saber quem está pedindo acesso.'],
  ];
  let firstInvalid = null;
  for (const [input, err, msg] of checks) {
    setFieldError(input, err, msg);
    if (msg && !firstInvalid) firstInvalid = input;
  }
  if (firstInvalid) return firstInvalid.focus();
  if (!Object.values(requested).some(Boolean)) return showTechError(errorMessage('no_permissions_requested'));
  let url = wsUrl;
  if (desktop && lanMode()) {
    const address = $('tech-address').value.trim();
    setFieldError($('tech-address'), $('err-address'), '');
    setBusy($('btn-join'), true, 'Procurando na rede…');
    const found = await desktop.lanDiscover(sessionId, secret, address);
    setBusy($('btn-join'), false);
    if (!found.ok) {
      if (found.error === 'invalid_address') {
        setFieldError($('tech-address'), $('err-address'), 'Endereço inválido. Exemplo: 192.168.0.10');
        return $('tech-address').focus();
      }
      $('lan-address-box').open = true;
      return showTechError(errorMessage(address ? 'lan_not_found_address' : 'lan_not_found'));
    }
    url = found.url;
  }
  setBusy($('btn-join'), true, 'Enviando pedido…');
  const viewer = new ViewerController({ signaling: createSignaling(url) });
  useController(viewer);
  viewer.join({ sessionId, secret, name, requested });
});

/* ================= Histórico ================= */

const END_SHORT = {
  host_ended: 'Encerrada', tech_ended: 'Encerrada', connection_failed: 'Falha de conexão',
  host_timeout: 'Conexão perdida', tech_timeout: 'Conexão perdida', max_duration: 'Tempo máximo',
  policy_violation: 'Encerrada por segurança', signaling_lost: 'Conexão perdida', session_lost: 'Conexão perdida',
};

function renderHistory() {
  const list = $('history-list');
  const items = loadHistory();
  list.replaceChildren();
  $('btn-clear-history').disabled = !items.length;
  if (!items.length) {
    list.append(el('li', { className: 'history-empty' }, [
      icon('clock'), el('strong', {}, 'Nenhuma sessão ainda'), el('span', {}, 'As sessões que você fizer aparecem aqui.'),
    ]));
    return;
  }
  for (const h of items) {
    const mins = Math.max(1, Math.round((h.endedAt - h.startedAt) / 60000));
    const who = h.role === 'host' ? `Ajuda de ${h.peerName || '—'}` : `Ajuda para ${h.peerName || '—'}`;
    const perms = h.permissions.map((p) => PERMISSION_LABELS[p] ?? p).join(', ') || 'Sem permissões';
    const when = new Date(h.startedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    list.append(el('li', { className: 'group-row' }, [
      el('span', { className: 'row-icon' }, icon(h.role === 'host' ? 'share' : 'support')),
      el('span', { className: 'row-text' }, [
        el('span', { className: 'row-title' }, who),
        el('span', { className: 'row-hint' }, `${when} · ${mins} min · ${perms}`),
      ]),
      el('span', { className: 'row-trailing' }, END_SHORT[h.endReason] ?? 'Encerrada'),
    ]));
  }
}

$('btn-clear-history').addEventListener('click', async () => {
  const ok = await confirmDialog('Limpar histórico?', 'Todas as sessões salvas neste dispositivo serão apagadas.', { confirmLabel: 'Limpar histórico', destructive: true });
  if (!ok) return;
  clearHistory();
  renderHistory();
  toast('Histórico apagado.');
});

/* ================= Ajustes (app de computador) ================= */

async function setupDesktop() {
  if (!desktop) return;
  for (const n of document.querySelectorAll('[data-desktop-only]')) n.hidden = false;
  const settings = await desktop.getSettings();
  desktopInfo = settings;
  $('lan-address-box').hidden = !lanMode();
  renderControlSupport();
  setupUpdates(settings);
  desktop.onCaptureTarget(({ controllable }) => {
    if (controller?.role === 'host') controller.setCaptureControllable(controllable);
  });
  desktop.onControlRevoked(() => {
    if (controller?.role === 'host') controller.onControlRevoked();
  });
  $(settings.mode === 'remote' ? 'mode-remote' : 'mode-local').checked = true;
  $('server-url').value = settings.serverUrl ?? '';
  $('app-version').textContent = settings.version ?? '';
  const syncUrlField = () => { $('server-url').disabled = !$('mode-remote').checked; };
  for (const r of document.querySelectorAll('input[name="mode"]')) r.addEventListener('change', syncUrlField);
  syncUrlField();

  $('form-settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = $('mode-remote').checked ? 'remote' : 'local';
    const serverUrl = $('server-url').value.trim();
    const result = await desktop.saveSettings({ mode, serverUrl });
    setFieldError($('server-url'), $('err-server'), result.ok ? '' : result.error);
    if (!result.ok) $('server-url').focus();
  });
  $('btn-docs').addEventListener('click', () => desktop.openDocs());
  desktop.onNavigate((key) => {
    if (key in ROUTES) location.hash = key;
  });

  // Seletor de tela/janela: o app mostra as opções reais do sistema e a pessoa escolhe.
  desktop.onSourceRequest(({ requestId, sources }) => {
    const list = $('source-list');
    list.replaceChildren();
    let answered = false;
    const answer = (sourceId) => {
      if (answered) return;
      answered = true;
      desktop.chooseSource(requestId, sourceId);
      closeDialog($('dlg-source'));
    };
    for (const s of sources) {
      const card = el('button', { type: 'button', className: 'source-card' }, [
        el('img', { src: s.thumbnail, alt: '' }),
        el('span', {}, `${s.kind === 'screen' ? 'Tela' : 'Janela'}: ${s.name}`),
      ]);
      card.addEventListener('click', () => answer(s.id));
      list.append(card);
    }
    if (!sources.length) list.append(el('p', { className: 'secondary' }, 'Nenhuma tela disponível. No macOS, permita a gravação de tela em Ajustes do Sistema › Privacidade e Segurança.'));
    $('btn-source-cancel').onclick = () => answer(null);
    $('dlg-source').oncancel = (ev) => { ev.preventDefault(); answer(null); };
    // Um diálogo por vez: a aprovação sai da tela enquanto a pessoa escolhe o que compartilhar.
    if ($('dlg-approve').open) $('dlg-approve').close();
    openDialog($('dlg-source'));
  });
}

/* ================= Controlador de sessão ================= */

function useController(c) {
  controller?.dispose();
  controller?.signaling.close();
  stopControlling();
  controller = c;
  document.body.dataset.role = c.role;
  resetSessionUi();

  c.addEventListener('state', (e) => onState(e.detail.state));
  c.addEventListener('log', (e) => addEvent(e.detail));
  c.addEventListener('chat', (e) => addChat(e.detail));
  c.addEventListener('permissions', () => renderSessionPermissions());
  c.addEventListener('verification', (e) => {
    $('verify-code').textContent = e.detail.code ?? 'indisponível';
    $('route-info').textContent = e.detail.route === 'relay'
      ? 'Rota: via servidor de retransmissão (TURN), ainda cifrada ponta a ponta.'
      : (e.detail.route === 'direct' ? 'Rota: conexão direta entre os dispositivos.' : '');
  });
  c.addEventListener('notice', (e) => {
    if (e.detail.code === 'peer_unavailable') return;
    if (c.state === 'idle') {
      if (c.role === 'host') showHostError(errorMessage(e.detail.code));
      else showTechError(errorMessage(e.detail.code));
    } else {
      toast(errorMessage(e.detail.code), 'error');
    }
  });
  c.addEventListener('peer-status', () => updateBanner());
  c.addEventListener('file-incoming', (e) => onFileIncoming(e.detail));
  c.addEventListener('file-outgoing', (e) => onFileOutgoing(e.detail));
  c.addEventListener('file-progress', (e) => onFileProgress(e.detail));
  c.addEventListener('share', () => {
    updateBanner();
    updateStage();
  });
  c.addEventListener('recording', (e) => onRecording(e.detail));
  c.addEventListener('control', () => updateBanner());
  c.addEventListener('ended', (e) => onEnded(e.detail.reason));

  if (c.role === 'host') bindHost(c);
  else bindViewer(c);
}

const STATE_KIND = { connecting: 'waiting', connected: 'ok', reconnecting: 'warning', failed: 'error' };

function onState(state) {
  const status = $('conn-status');
  status.dataset.kind = STATE_KIND[state] ?? 'waiting';
  status.querySelector('.status-label').textContent = STATE_TEXT[state] ?? '';
  if (state !== 'creating') setBusy($('btn-create-invite'), false);
  if (state !== 'joining') setBusy($('btn-join'), false);

  if (state === 'idle') {
    go(controller?.role === 'viewer' ? 'view-tech' : 'view-host', { focus: false });
  } else if (state === 'waiting') {
    go('view-invite');
  } else if (state === 'awaiting_approval') {
    go('view-pending');
  } else if (state === 'connecting' && $('view-session').hidden) {
    stopCountdown();
    // Convite usado: o computador deixa de responder a buscas na rede (a sessão continua).
    if (desktop && controller?.role === 'host' && lanMode()) desktop.lanInviteUsed(controller.sessionId);
    go('view-session');
    tabs.select('tab-perms');
    renderSessionPermissions();
    updateStage();
  }
  syncNav();
  updateBanner();
}

/* ---------- Anfitrião ---------- */

function bindHost(c) {
  c.addEventListener('invite', (e) => {
    const { sessionId, secret, expiresAt } = e.detail;
    $('invite-id').textContent = formatSessionId(sessionId);
    $('invite-secret').textContent = formatSecret(secret);
    stopCountdown();
    stopCountdown = countdown($('invite-countdown'), expiresAt);
    openLanForInvite(sessionId, secret);
  });
  c.addEventListener('join-request', (e) => openApproveDialog(e.detail));
  c.addEventListener('join-request-closed', (e) => {
    stopDialogCountdown();
    closeDialog($('dlg-approve'));
    toast(e.detail.reason === 'expired' ? 'O pedido de conexão expirou.' : 'A pessoa desistiu do pedido.');
  });
  c.addEventListener('capture', (e) => {
    $('video').srcObject = e.detail.stream;
    updateStage();
    updateBanner();
  });
  c.addEventListener('permissions-request', (e) => openPermRequestDialog(e.detail.asked));
}

function hostPermissionOptions(c) {
  const options = {};
  for (const p of PERMISSIONS) {
    const supported = capabilityAllows(p, c.capabilities);
    options[p] = {
      checked: p === 'view' && supported,
      disabled: !supported,
      hint: !supported
        ? (p === 'control' ? controlUnavailableHint() : 'Indisponível: este dispositivo não compartilha a tela.')
        : (p === 'control'
          ? `Permite clicar e digitar no seu computador. Só funciona compartilhando a tela inteira. Para retomar a qualquer momento: ${shortcutLabel()}.`
          : PERMISSION_HINTS[p]),
    };
  }
  return options;
}

function openApproveDialog(req) {
  const c = controller;
  $('approve-name').textContent = req.name;
  $('approve-error').textContent = '';
  renderPermissionChoices($('approve-perms'), {
    name: 'grant', only: PERMISSIONS.filter((p) => req.requested[p]), options: hostPermissionOptions(c),
  });
  stopDialogCountdown();
  stopDialogCountdown = countdown($('approve-countdown'), req.expiresAt);
  setBusy($('btn-accept'), false);
  openDialog($('dlg-approve'));
}

$('form-approve').addEventListener('submit', async (e) => {
  e.preventDefault();
  const granted = readPermissionChoices($('approve-perms'));
  setBusy($('btn-accept'), true, 'Aceitando…');
  try {
    await controller.approve(granted);
    stopDialogCountdown();
    closeDialog($('dlg-approve'));
  } catch {
    if (controller?.pendingRequest) {
      $('approve-error').textContent = 'Você não escolheu o que compartilhar. Escolha uma tela ou desative "Ver a tela".';
      openDialog($('dlg-approve'));
    }
  } finally {
    setBusy($('btn-accept'), false);
  }
});

function rejectRequest() {
  stopDialogCountdown();
  controller?.reject();
  closeDialog($('dlg-approve'));
}
$('btn-reject').addEventListener('click', rejectRequest);
// Esc no pedido de conexão equivale a recusar (a opção segura).
$('dlg-approve').addEventListener('cancel', (e) => {
  e.preventDefault();
  rejectRequest();
});

function openPermRequestDialog(asked) {
  const c = controller;
  const pending = PERMISSIONS.filter((p) => asked[p] && !c.granted[p]);
  if (!pending.length) return;
  $('permreq-name').textContent = c.peerName;
  const options = hostPermissionOptions(c);
  for (const p of pending) options[p].checked = false;
  renderPermissionChoices($('permreq-perms'), { name: 'permreq', only: pending, options });
  openDialog($('dlg-perm-request'));
}

$('form-perm-request').addEventListener('submit', async (e) => {
  e.preventDefault();
  const chosen = readPermissionChoices($('permreq-perms'));
  closeDialog($('dlg-perm-request'));
  try {
    await controller.setPermissions({ ...controller.granted, ...chosen });
  } catch {
    toast('Você não escolheu o que compartilhar. "Ver a tela" continua desativado.', 'error');
  }
});
$('btn-permreq-deny').addEventListener('click', () => closeDialog($('dlg-perm-request')));

$('btn-copy-invite').addEventListener('click', async () => {
  const text = `ID: ${$('invite-id').textContent}  Código: ${$('invite-secret').textContent}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('Convite copiado.');
  } catch {
    toast('Não foi possível copiar. Selecione o ID e o código e copie manualmente.', 'error');
  }
});

// Cancelar convite e encerrar (anfitrião) são imediatos de propósito: parar de compartilhar
// precisa ser instantâneo. Nada se perde, a pessoa pode gerar um novo convite.
$('btn-cancel-invite').addEventListener('click', () => controller?.end('host_ended'));

$('btn-pause').addEventListener('click', () => {
  const c = controller;
  if (c?.role === 'host') c.setPaused(!c.paused);
});

$('btn-share-again').addEventListener('click', async () => {
  try {
    await controller.shareAgain();
  } catch {
    toast('Você não escolheu o que compartilhar.', 'error');
  }
});

$('btn-revoke-all').addEventListener('click', () => controller?.revokeAll());

/* ---------- Técnico ---------- */

function bindViewer(c) {
  c.addEventListener('pending', (e) => {
    $('pending-text').textContent = e.detail.hostName
      ? `${e.detail.hostName} precisa aceitar seu pedido.`
      : 'A pessoa precisa aceitar seu pedido.';
    stopCountdown();
    stopCountdown = countdown($('pending-countdown'), e.detail.expiresAt);
  });
  c.addEventListener('join-error', (e) => {
    const code = e.detail.code;
    if (code === 'invalid_credentials') {
      setFieldError($('tech-secret'), $('err-secret'), errorMessage(code));
      $('tech-secret').focus();
    } else {
      showTechError(errorMessage(code));
    }
  });
  c.addEventListener('stream', (e) => {
    $('video').srcObject = e.detail.stream;
    updateStage();
  });
}

$('btn-cancel-pending').addEventListener('click', () => controller?.cancelJoin());

$('btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('stage').requestFullscreen?.().catch(() => toast('Tela cheia indisponível aqui.'));
});

$('btn-record').addEventListener('click', async () => {
  const c = controller;
  if (c.recording) return c.stopRecording();
  const ok = await confirmDialog(
    'Gravar a sessão?',
    'A outra pessoa verá um aviso enquanto a gravação durar. O vídeo fica só neste dispositivo: guarde em local protegido e apague quando não precisar mais.',
    { confirmLabel: 'Começar a gravar' },
  );
  if (!ok) return;
  try {
    c.startRecording();
  } catch (err) {
    toast(err.code === 'not_permitted' ? 'A gravação não está liberada.' : 'Ainda não há imagem para gravar.', 'error');
  }
});

$('btn-ask-perms').addEventListener('click', () => {
  const c = controller;
  const missing = PERMISSIONS.filter((p) => !c.granted[p]);
  if (!missing.length) return toast('Você já tem todas as permissões disponíveis.');
  const options = {};
  for (const p of missing) {
    const supported = capabilityAllows(p, c.capabilities);
    options[p] = { disabled: !supported, hint: supported ? PERMISSION_HINTS[p] : 'Indisponível no dispositivo da outra pessoa.' };
  }
  renderPermissionChoices($('ask-perms'), { name: 'ask', only: missing, options });
  openDialog($('dlg-ask-perms'));
});

$('form-ask-perms').addEventListener('submit', (e) => {
  e.preventDefault();
  const chosen = readPermissionChoices($('ask-perms'));
  closeDialog($('dlg-ask-perms'));
  if (Object.values(chosen).some(Boolean)) controller.requestPermissions(chosen);
});
$('btn-ask-cancel').addEventListener('click', () => closeDialog($('dlg-ask-perms')));

/* ---------- Sessão (comum) ---------- */

let unread = 0;
const tabs = setupTabs(document.querySelector('.segmented'), (id) => {
  if (id === 'tab-chat') {
    unread = 0;
    updateChatBadge();
  }
});

function updateChatBadge() {
  const badge = $('chat-badge');
  badge.hidden = unread === 0;
  badge.textContent = String(unread);
  $('tab-chat').setAttribute('aria-label', unread ? `Chat, ${unread} ${unread === 1 ? 'mensagem nova' : 'mensagens novas'}` : 'Chat');
}

$('btn-end').addEventListener('click', async () => {
  const c = controller;
  if (!c) return;
  // O anfitrião encerra na hora (segurança). Quem presta suporte confirma, para não cair por engano.
  if (c.role === 'viewer') {
    const ok = await confirmDialog('Encerrar a sessão?', `A conexão com ${c.peerName} será encerrada para os dois.`, { confirmLabel: 'Encerrar sessão', destructive: true });
    if (!ok) return;
  }
  c.end();
});

function resetSessionUi() {
  for (const id of ['chat-log', 'event-log', 'file-list', 'ended-downloads']) $(id).replaceChildren();
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
  fileRows.clear();
  unread = 0;
  updateChatBadge();
  $('chat-empty').hidden = false;
  $('file-confirm').hidden = true;
  $('verify-code').textContent = '----';
  $('route-info').textContent = '';
  $('video').srcObject = null;
  $('file-input').accept = ACCEPT_ATTRIBUTE;
  $('btn-record').hidden = !SessionRecorder.isSupported();
}

function renderSessionPermissions() {
  const c = controller;
  if (!c) return;
  const box = $('session-perms');
  if (c.role === 'host') {
    // Anfitrião: interruptores. Só aparecem permissões que a outra pessoa pediu.
    const shown = PERMISSIONS.filter((p) => c.requested[p]);
    const options = hostPermissionOptions(c);
    for (const p of shown) options[p].checked = c.granted[p];
    renderPermissionChoices(box, { name: 'live', only: shown, options, showState: true });
    for (const input of box.querySelectorAll('input')) {
      input.addEventListener('change', async () => {
        // Controle de teclado e mouse exige um consentimento explícito na hora de ligar.
        if (input.name === 'control' && input.checked) {
          const ok = await confirmDialog(
            `Permitir que ${c.peerName} controle este computador?`,
            `Essa pessoa poderá mover o mouse, clicar e digitar como se fosse você. Você continua vendo tudo e pode retomar o controle a qualquer momento com ${shortcutLabel()} ou pelo botão "Parar" no aviso vermelho que fica no canto da tela.`,
            { confirmLabel: 'Permitir controle', destructive: true },
          );
          if (!ok) return renderSessionPermissions();
        }
        try {
          await c.setPermissions({ ...c.granted, [input.name]: input.checked });
        } catch {
          toast('Você não escolheu o que compartilhar. "Ver a tela" continua desativado.', 'error');
          renderSessionPermissions();
        }
      });
    }
    if (!shown.length) box.replaceChildren(el('p', { className: 'group-row secondary' }, 'Nenhuma permissão foi pedida.'));
    $('btn-revoke-all').disabled = !PERMISSIONS.some((p) => c.granted[p]);
  } else {
    box.replaceChildren();
    for (const p of PERMISSIONS) {
      const on = c.granted[p];
      box.append(el('div', { className: 'group-row' }, [
        el('span', { className: 'row-text' }, el('span', { className: 'row-title' }, PERMISSION_LABELS[p])),
        el('span', { className: 'perm-state', dataset: { on: String(on) } }, [icon(on ? 'check' : 'stop'), ` ${on ? 'Liberado' : 'Bloqueado'}`]),
      ]));
    }
  }
  const chatOn = c.can('chat');
  $('form-chat').hidden = !chatOn;
  $('chat-disabled').hidden = chatOn;
  const filesOn = c.can('files');
  $('file-input').disabled = !filesOn;
  $('file-pick-label').hidden = !filesOn;
  if (!filesOn) $('file-confirm').hidden = true;
  $('files-hint').textContent = filesOn
    ? 'Até 25 MB: txt, log, csv, json, md, pdf, png, jpg ou webp. A outra pessoa precisa aceitar.'
    : 'A transferência de arquivos não está liberada.';
  $('btn-record').disabled = !c.can('record');
  updateBanner();
  updateStage();
}

function setButtonText(button, text) {
  button.querySelector('.btn-text').textContent = text;
}

function updateBanner() {
  const c = controller;
  const banner = $('session-banner');
  const active = c && ['connecting', 'connected', 'reconnecting'].includes(c.state);
  banner.hidden = !active;
  if (!active) {
    document.title = BASE_TITLE;
    return;
  }
  let text;
  let sharing;
  if (c.role === 'host') {
    sharing = c.sharing;
    if (sharing) text = `Sua tela está sendo compartilhada com ${c.peerName}`;
    else if (c.can('view') && c.paused) text = 'Compartilhamento pausado: a outra pessoa não vê sua tela';
    else if (c.can('view')) text = 'Sua tela não está sendo enviada';
    else text = 'Sua tela não está sendo compartilhada';
    const pause = $('btn-pause');
    setButtonText(pause, c.paused ? 'Retomar' : 'Pausar');
    pause.querySelector('use').setAttribute('href', c.paused ? '#i-play' : '#i-pause');
    pause.disabled = !c.can('view') || !c.capture;
    $('btn-share-again').hidden = !(c.can('view') && !c.capture);
    $('banner-record-item').hidden = !c.peerRecording;
    $('banner-record').textContent = `${c.peerName} está gravando a sessão`;
  } else {
    sharing = c.can('view') && !c.hostPaused;
    syncControlButton();
    text = sharing ? `Você está vendo a tela de ${c.peerName}` : `Sessão com ${c.peerName}: tela indisponível`;
    $('banner-record-item').hidden = !c.recording;
    $('banner-record').textContent = 'Você está gravando';
    setButtonText($('btn-record'), c.recording ? 'Parar gravação' : 'Gravar');
  }
  banner.dataset.sharing = String(sharing);
  $('banner-share').textContent = text;
  $('banner-control').textContent = controlBannerText(c);
  $('session-title').textContent = `Sessão com ${c.peerName}`;
  $('session-peer').textContent = c.role === 'host' ? 'Você está recebendo suporte' : 'Você está prestando suporte';
  document.title = c.role === 'host' && sharing ? `● Compartilhando a tela · ${BASE_TITLE}` : BASE_TITLE;
  document.documentElement.style.setProperty('--banner-h', `${banner.offsetHeight}px`);
}

function updateStage() {
  const c = controller;
  if (!c) return;
  let overlay = '';
  if (c.role === 'host') {
    if (!c.can('view')) overlay = 'A visualização da tela não está liberada.';
    else if (!c.capture) overlay = 'Nada está sendo compartilhado.';
    else if (c.paused) overlay = 'Pausado: a outra pessoa não está vendo sua tela.';
  } else if (!c.can('view')) {
    overlay = 'A visualização da tela não foi liberada.';
  } else if (c.hostPaused) {
    overlay = 'A pessoa pausou o compartilhamento.';
  } else if (!c.remoteStream) {
    overlay = 'Aguardando a imagem…';
  }
  $('stage-overlay').textContent = overlay;
}

function addEvent({ text, kind, at }) {
  $('event-log').prepend(el('li', { dataset: { kind } }, [el('time', {}, formatTime(at)), el('span', {}, text)]));
}

function addChat({ from, text, at }) {
  const who = from === 'me' ? 'Você' : controller.peerName;
  const item = el('li', { dataset: { from } }, [el('span', { className: 'meta' }, `${who} · ${formatTime(at)}`), text]);
  $('chat-log').append(item);
  $('chat-empty').hidden = true;
  item.scrollIntoView({ block: 'nearest' });
  if (from !== 'me' && tabs.selected() !== 'tab-chat') {
    unread += 1;
    updateChatBadge();
  }
}

$('form-chat').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  if (controller?.sendChat(input.value)) input.value = '';
  else if (input.value.trim()) toast('Não foi possível enviar: chat não liberado ou conexão indisponível.', 'error');
});

/* ---------- Arquivos ---------- */

const fileRows = new Map();
let fileToSend = null;

function fileRow(id, label) {
  let row = fileRows.get(id);
  if (!row) {
    row = { li: el('li'), text: el('span'), progress: el('progress', { max: 1, value: 0, hidden: true }) };
    row.li.append(row.text, row.progress);
    $('file-list').prepend(row.li);
    fileRows.set(id, row);
  }
  if (label) row.text.textContent = label;
  return row;
}

function downloadLink(blob, name, container) {
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  const a = el('a', { href: url, download: name, className: 'btn' }, [icon('download'), `Salvar ${name}`]);
  container.append(a);
  return a;
}

// Confirmação inline (no próprio painel), sem abrir outro diálogo.
$('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !controller) return;
  fileToSend = file;
  $('file-confirm-text').textContent = `Enviar "${file.name}" (${formatSize(file.size)}) para ${controller.peerName}? A pessoa ainda precisará aceitar.`;
  $('file-confirm').hidden = false;
  $('btn-file-send').focus();
});
$('btn-file-cancel').addEventListener('click', () => {
  fileToSend = null;
  $('file-confirm').hidden = true;
});
$('btn-file-send').addEventListener('click', async () => {
  const file = fileToSend;
  fileToSend = null;
  $('file-confirm').hidden = true;
  if (!file) return;
  try {
    await controller.sendFile(file);
  } catch (err) {
    toast(FILE_ERROR_MESSAGES[err.code] ?? 'Não foi possível enviar o arquivo.', 'error');
  }
});

let pendingIncoming = null;

function onFileIncoming(d) {
  const size = formatSize(d.size);
  switch (d.status) {
    case 'offered':
      pendingIncoming = d.id;
      fileRow(d.id, `Oferta recebida: ${d.name} (${size})`);
      $('file-dlg-name').textContent = d.name;
      $('file-dlg-size').textContent = size;
      openDialog($('dlg-file'));
      break;
    case 'receiving':
      fileRow(d.id, `Recebendo ${d.name}…`).progress.hidden = false;
      break;
    case 'received': {
      const row = fileRow(d.id, `Recebido e verificado: ${d.name}`);
      row.progress.hidden = true;
      downloadLink(d.blob, d.name, row.li);
      break;
    }
    case 'blocked':
      fileRow(d.id, `Arquivo bloqueado (${d.name}): ${FILE_ERROR_MESSAGES[d.reason] ?? d.reason}`);
      break;
    case 'rejected':
      fileRow(d.id, `Você recusou ${d.name}.`).progress.hidden = true;
      break;
    case 'failed':
      if (pendingIncoming === d.id) closeDialog($('dlg-file'));
      fileRow(d.id, `Falhou: ${d.name}. ${FILE_ERROR_MESSAGES[d.reason] ?? d.reason}`).progress.hidden = true;
      break;
    default:
  }
}

$('form-file').addEventListener('submit', (e) => {
  e.preventDefault();
  closeDialog($('dlg-file'));
  if (pendingIncoming) controller?.files?.accept(pendingIncoming);
  pendingIncoming = null;
});
function rejectFile() {
  if (pendingIncoming) controller?.files?.reject(pendingIncoming);
  pendingIncoming = null;
  closeDialog($('dlg-file'));
}
$('btn-file-reject').addEventListener('click', rejectFile);
$('dlg-file').addEventListener('cancel', (e) => {
  e.preventDefault();
  rejectFile();
});

function onFileOutgoing(d) {
  const messages = {
    offered: `Aguardando a outra pessoa aceitar ${d.name}…`,
    sending: `Enviando ${d.name}…`,
    sent: `Enviado: ${d.name}`,
    rejected: `Não aceito: ${d.name}. ${FILE_ERROR_MESSAGES[d.reason] ?? FILE_ERROR_MESSAGES.rejected}`,
    failed: `Falhou: ${d.name}. ${FILE_ERROR_MESSAGES[d.reason] ?? d.reason}`,
  };
  const row = fileRow(d.id, messages[d.status]);
  row.progress.hidden = d.status !== 'sending';
}

function onFileProgress({ id, sent, size }) {
  const row = fileRows.get(id);
  if (!row) return;
  row.progress.hidden = false;
  row.progress.value = size ? sent / size : 1;
}

/* ---------- Gravação ---------- */

function onRecording({ active, blob, extension }) {
  updateBanner();
  if (!active && blob === null) toast('A gravação terminou sem imagem para salvar.', 'error');
  if (!active && blob) {
    const name = `sessao-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${extension}`;
    const ended = controller.state === 'ended' || controller.state === 'failed';
    const holder = ended ? el('p', {}, 'Gravação da sessão:') : el('li', {}, el('span', {}, 'Gravação pronta.'));
    (ended ? $('ended-downloads') : $('file-list')).prepend(holder);
    downloadLink(blob, name, holder);
    if (!ended) toast('Gravação pronta na aba Arquivos.');
  }
}

/* ---------- Encerramento ---------- */

function onEnded(reason) {
  stopCountdown();
  stopDialogCountdown();
  for (const id of ['dlg-approve', 'dlg-file', 'dlg-perm-request', 'dlg-ask-perms', 'dlg-confirm', 'dlg-source']) {
    if ($(id).open) $(id).close();
  }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('video').srcObject = null;
  $('session-banner').hidden = true;
  document.title = BASE_TITLE;
  const c = controller;
  const failed = c.state === 'failed';
  const notConnected = c.role === 'viewer' && !c.startedAt && reason !== 'cancelled';
  $('ended-title').textContent = failed ? 'Falha na conexão' : (notConnected ? 'Conexão não realizada' : 'Sessão encerrada');
  const kind = failed ? 'error' : (notConnected || ['policy_violation', 'too_many_attempts'].includes(reason) ? 'warning' : 'ok');
  $('ended-icon').dataset.kind = kind;
  $('ended-icon').querySelector('use').setAttribute('href', kind === 'ok' ? '#i-check' : '#i-warning');
  $('ended-reason').textContent = endMessage(reason, c.role);
  go('view-ended');
  c.signaling.close();
  stopControlling();
  if (desktop && c.role === 'host' && c.sessionId) desktop.lanHostStop(c.sessionId);
}

$('btn-home').addEventListener('click', () => {
  const role = controller?.role;
  controller?.dispose();
  controller = null;
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
  fileRows.clear();
  $('ended-downloads').replaceChildren();
  delete document.body.dataset.role;
  const target = role === 'viewer' ? 'prestar' : 'receber';
  if (location.hash.slice(1) === target) route();
  else location.hash = target;
});

// O formulário de confirmação fecha com a mesma animação dos outros diálogos.
$('dlg-confirm').querySelector('form').addEventListener('submit', (e) => {
  e.preventDefault();
  closeDialog($('dlg-confirm'), e.submitter?.value ?? 'no');
});

// Aviso ao fechar no meio de uma sessão.
window.addEventListener('beforeunload', (e) => {
  if (inFlow()) e.preventDefault();
});

/* ---------- Rede local ---------- */

async function openLanForInvite(sessionId, secret) {
  const row = $('invite-lan');
  row.hidden = true;
  if (!desktop || !lanMode()) return;
  const result = await desktop.lanHostStart(sessionId, secret);
  row.replaceChildren();
  if (result.ok) {
    row.dataset.kind = 'ok';
    const where = result.addresses.length ? `Na rede local: ${result.addresses.join(', ')}` : 'Na rede local';
    row.append(icon('check'), el('span', {}, `${where}. Computadores no mesmo Wi-Fi encontram este convite pelo ID e código.`));
  } else {
    row.dataset.kind = 'warning';
    row.append(icon('warning'), el('span', {}, 'Não foi possível abrir a rede local (verifique o firewall). O convite só funciona neste computador.'));
  }
  row.hidden = false;
}

/* ---------- Controle remoto ---------- */

function controlUnavailableHint() {
  const reason = desktopInfo?.input?.reason;
  if (!desktop) return 'Indisponível no navegador: use o app de computador.';
  if (reason === 'wayland') return 'Indisponível no Wayland. Entre numa sessão Xorg para permitir o controle.';
  return 'Indisponível neste computador.';
}

function renderControlSupport() {
  const info = desktopInfo?.input;
  let text = controlUnavailableHint();
  if (info?.available) {
    text = `Disponível. Só funciona compartilhando a tela inteira. Para retomar o controle a qualquer momento: ${shortcutLabel()}.`;
    if (desktop.platform === 'darwin') text += ' No macOS, permita o Ponte em Ajustes do Sistema › Privacidade e Segurança › Acessibilidade.';
  }
  $('control-support').textContent = text;
}

function controlBannerText(c) {
  if (c.role === 'host') {
    if (c.controlActive) return `Controle remoto ATIVO · ${shortcutLabel()} para retomar`;
    if (c.can('control')) return c.controllable ? 'Controle remoto liberado (pausado)' : 'Controle remoto liberado: compartilhe a tela inteira';
    return 'Controle remoto: desativado';
  }
  if (remoteInput) return 'Você está controlando o computador';
  return c.canControl ? 'Controle remoto disponível' : 'Controle remoto: desativado';
}

let remoteInput = null;

function stopControlling() {
  remoteInput?.stop();
  remoteInput = null;
  const btn = $('btn-control');
  btn.setAttribute('aria-pressed', 'false');
  setButtonText(btn, 'Controlar');
}

function syncControlButton() {
  const c = controller;
  const btn = $('btn-control');
  const allowed = Boolean(c?.role === 'viewer' && c.canControl);
  btn.disabled = !allowed;
  btn.title = allowed ? '' : 'A outra pessoa precisa liberar o controle e compartilhar a tela inteira.';
  if (!allowed && remoteInput) {
    stopControlling();
    toast('O controle remoto foi encerrado pela outra pessoa.');
  }
}

$('btn-control').addEventListener('click', () => {
  const c = controller;
  if (remoteInput) {
    stopControlling();
  } else if (c?.canControl) {
    remoteInput = startRemoteInput({ stage: $('stage'), video: $('video'), send: (msg) => c.sendInput(msg) });
    $('btn-control').setAttribute('aria-pressed', 'true');
    setButtonText($('btn-control'), 'Parar de controlar');
    toast('Mouse e teclado agora agem no outro computador enquanto a tela estiver em foco.');
  }
  updateBanner();
});

/* ---------- Atualizações (app de computador) ---------- */

let updateStatus = null;

const UPDATE_TEXT = {
  unsupported: 'Disponível no app instalado.',
  idle: 'Ainda não verificado.',
  checking: 'Procurando atualizações…',
  'up-to-date': 'Você está usando a versão mais recente.',
  error: 'Não foi possível verificar agora. Tente mais tarde.',
};

function setupUpdates(settings) {
  const sw = $('auto-update');
  sw.checked = settings.autoUpdate !== false;
  const mode = settings.update?.mode;
  sw.disabled = mode === 'unsupported';
  $('btn-update-check').disabled = mode === 'unsupported';
  if (mode === 'notify') $('auto-update-hint').textContent = 'Neste formato (macOS, portátil ou .deb) o Ponte avisa e abre a página para baixar a nova versão.';
  sw.addEventListener('change', async () => {
    sw.checked = await desktop.setAutoUpdate(sw.checked);
  });
  $('btn-update-check').addEventListener('click', () => desktop.checkForUpdates());
  $('btn-update-action').addEventListener('click', onUpdateAction);
  desktop.onUpdateStatus(renderUpdate);
  renderUpdate(settings.update);
}

function renderUpdate(status) {
  if (!status) return;
  updateStatus = status;
  let text = UPDATE_TEXT[status.state] ?? '';
  if (status.state === 'available') text = `Versão ${status.version} disponível.`;
  if (status.state === 'downloading') text = `Baixando a versão ${status.version}… ${status.percent ?? 0}%`;
  if (status.state === 'ready') text = `Versão ${status.version} pronta para instalar.`;
  $('update-status').textContent = text;

  const banner = $('update-banner');
  const action = $('btn-update-action');
  const show = status.state === 'ready' || status.state === 'available';
  banner.hidden = !show;
  if (!show) return;
  $('update-banner-text').textContent = status.state === 'ready'
    ? `Nova versão ${status.version} pronta. Ela será instalada ao fechar o Ponte.`
    : `Nova versão ${status.version} disponível.`;
  if (status.state === 'ready') action.textContent = 'Reiniciar e atualizar';
  else action.textContent = status.mode === 'auto' ? 'Baixar atualização' : 'Baixar';
  // Nunca reinicia no meio de uma sessão.
  action.disabled = status.state === 'ready' && inFlow();
  action.title = action.disabled ? 'Disponível quando a sessão terminar.' : '';
}

async function onUpdateAction() {
  const status = updateStatus;
  if (!status) return;
  if (status.state === 'ready') {
    const result = await desktop.installUpdate();
    if (!result.ok) toast(result.error === 'session_active' ? 'Termine a sessão antes de atualizar.' : 'Não foi possível instalar agora.', 'error');
  } else if (status.mode === 'auto') {
    desktop.downloadUpdate();
  } else {
    desktop.openReleases();
  }
}

renderCaptureSupport();
renderTechPermissions();
setupDesktop();
route();
