// Interface: liga os elementos da página aos controladores de sessão.

import { clearHistory, loadHistory } from './history.js';
import { endMessage, errorMessage, STATE_TEXT } from './messages.js';
import { SessionRecorder } from './recorder.js';
import { canCaptureScreen, HostController, ViewerController } from './session-controller.js';
import { SignalingClient } from './signaling-client.js';
import {
  $, confirmDialog, countdown, el, formatSize, formatTime, readPermissionChoices,
  renderPermissionChoices, showView, toast,
} from './ui.js';
import { ACCEPT_ATTRIBUTE, FILE_ERROR_MESSAGES } from '../../shared/file-policy.js';
import { capabilityAllows, PERMISSION_HINTS, PERMISSION_LABELS, PERMISSIONS } from '../../shared/permissions.js';
import {
  formatSecret, formatSessionId, normalizeSecret, normalizeSessionId, sanitizeName, SECRET_PATTERN, SESSION_ID_PATTERN,
} from '../../shared/protocol.js';

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const signaling = new SignalingClient(wsUrl);

let controller = null;
let stopCountdown = () => {};
let stopDialogCountdown = () => {};
const objectUrls = new Set();
const BASE_TITLE = document.title;

/* ---------- Estado do servidor ---------- */

const SIGNAL_TEXT = {
  online: 'Servidor: conectado',
  connecting: 'Servidor: conectando…',
  reconnecting: 'Servidor: reconectando…',
  offline: 'Servidor: desconectado',
};
signaling.addEventListener('status', (e) => {
  $('signal-status').dataset.status = e.detail;
  $('signal-status').querySelector('.pill-text').textContent = SIGNAL_TEXT[e.detail];
});

/* ---------- Tela inicial ---------- */

function renderHome() {
  $('capture-support').textContent = canCaptureScreen()
    ? 'Seu navegador permite compartilhar a tela.'
    : (window.isSecureContext
      ? 'Este navegador não permite compartilhar a tela (comum em celulares). Você ainda pode usar chat e arquivos.'
      : 'Compartilhar a tela exige conexão segura (HTTPS). Peça ao administrador para ativar HTTPS.');

  renderPermissionChoices($('tech-perms'), {
    name: 'req',
    options: {
      view: { checked: true },
      chat: { checked: true },
      control: { hint: 'Depende do agente nativo no outro dispositivo; a versão web não oferece.' },
    },
  });
  renderHistory();
}

function renderHistory() {
  const list = $('history-list');
  const items = loadHistory();
  list.replaceChildren();
  if (!items.length) {
    list.append(el('li', { className: 'empty' }, 'Nenhuma sessão ainda.'));
    return;
  }
  for (const h of items) {
    const mins = Math.max(1, Math.round((h.endedAt - h.startedAt) / 60000));
    const who = h.role === 'host' ? `Suporte recebido de ${h.peerName || '—'}` : `Suporte prestado a ${h.peerName || '—'}`;
    const perms = h.permissions.map((p) => PERMISSION_LABELS[p] ?? p).join(', ') || 'sem permissões';
    list.append(el('li', {}, [
      el('span', {}, who),
      el('span', { className: 'muted' }, `${new Date(h.startedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · ${mins} min · ${perms}`),
    ]));
  }
}

$('btn-clear-history').addEventListener('click', () => {
  clearHistory();
  renderHistory();
});

function showHomeError(text) {
  $('home-error').textContent = text;
  $('home-error').hidden = !text;
}

$('form-host').addEventListener('submit', (e) => {
  e.preventDefault();
  showHomeError('');
  const host = new HostController({ signaling });
  useController(host);
  host.start(sanitizeName($('host-name').value));
});

$('form-tech').addEventListener('submit', (e) => {
  e.preventDefault();
  showHomeError('');
  const sessionId = normalizeSessionId($('tech-session').value);
  const secret = normalizeSecret($('tech-secret').value);
  const name = sanitizeName($('tech-name').value);
  const requested = readPermissionChoices($('tech-perms'));
  const problems = [
    [$('tech-session'), !SESSION_ID_PATTERN.test(sessionId), 'O ID tem 9 números.'],
    [$('tech-secret'), !SECRET_PATTERN.test(secret), 'O código tem 8 letras/números (sem 0, 1, I, L ou O).'],
    [$('tech-name'), !name, 'Informe seu nome.'],
  ];
  let message = '';
  for (const [input, bad, text] of problems) {
    input.setAttribute('aria-invalid', String(bad));
    if (bad && !message) {
      message = text;
      input.focus();
    }
  }
  if (!message && !Object.values(requested).some(Boolean)) message = errorMessage('no_permissions_requested');
  $('tech-form-error').textContent = message;
  if (message) return;
  const viewer = new ViewerController({ signaling });
  useController(viewer);
  viewer.join({ sessionId, secret, name, requested });
});

/* ---------- Ligação com o controlador ---------- */

function useController(c) {
  controller?.dispose();
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
    if (c.state === 'idle') showHomeError(errorMessage(e.detail.code));
    else toast(errorMessage(e.detail.code), 'error');
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
  c.addEventListener('ended', (e) => onEnded(e.detail.reason));

  if (c.role === 'host') bindHost(c);
  else bindViewer(c);
}

function onState(state) {
  $('conn-status').dataset.state = state;
  $('conn-status').textContent = STATE_TEXT[state] ?? '';
  if (state === 'idle') {
    showView('view-home');
    renderHistory();
  } else if (state === 'waiting') {
    showView('view-invite');
  } else if (state === 'awaiting_approval') {
    showView('view-pending');
  } else if (state === 'connecting' && $('view-session').hidden) {
    stopCountdown();
    showView('view-session');
    renderSessionPermissions();
    updateBanner();
    updateStage();
  }
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
  });
  c.addEventListener('join-request', (e) => openApproveDialog(e.detail));
  c.addEventListener('join-request-closed', (e) => {
    stopDialogCountdown();
    if ($('dlg-approve').open) $('dlg-approve').close();
    toast(e.detail.reason === 'expired' ? 'O pedido de conexão expirou.' : 'A pessoa desistiu do pedido.');
  });
  c.addEventListener('capture', (e) => {
    $('video').srcObject = e.detail.stream;
    updateStage();
    updateBanner();
  });
  c.addEventListener('permissions-request', (e) => openPermRequestDialog(e.detail.asked));
}

function hostPermissionOptions(c, requested) {
  const options = {};
  for (const p of PERMISSIONS) {
    const supported = capabilityAllows(p, c.capabilities);
    options[p] = {
      checked: p === 'view' && supported,
      disabled: !supported,
      hint: supported ? PERMISSION_HINTS[p] : (p === 'control'
        ? 'Indisponível: este dispositivo não tem o agente nativo de controle.'
        : 'Indisponível: este navegador não compartilha a tela.'),
    };
  }
  return { only: PERMISSIONS.filter((p) => requested[p]), options };
}

function openApproveDialog(req) {
  const c = controller;
  $('approve-name').textContent = req.name;
  $('approve-error').textContent = '';
  renderPermissionChoices($('approve-perms'), { name: 'grant', ...hostPermissionOptions(c, req.requested) });
  stopDialogCountdown();
  stopDialogCountdown = countdown($('approve-countdown'), req.expiresAt);
  $('btn-accept').disabled = false;
  $('dlg-approve').showModal();
}

$('form-approve').addEventListener('submit', async (e) => {
  e.preventDefault();
  const granted = readPermissionChoices($('approve-perms'));
  $('btn-accept').disabled = true;
  try {
    await controller.approve(granted);
    stopDialogCountdown();
    $('dlg-approve').close();
  } catch {
    $('approve-error').textContent = 'Você não escolheu o que compartilhar. Escolha uma tela ou desmarque "Ver a tela".';
    $('btn-accept').disabled = false;
  }
});

function rejectRequest() {
  stopDialogCountdown();
  controller?.reject();
  if ($('dlg-approve').open) $('dlg-approve').close();
}
$('btn-reject').addEventListener('click', rejectRequest);
// Esc no diálogo de aprovação equivale a recusar (a opção segura).
$('dlg-approve').addEventListener('cancel', (e) => {
  e.preventDefault();
  rejectRequest();
});

function openPermRequestDialog(asked) {
  const c = controller;
  const pending = PERMISSIONS.filter((p) => asked[p] && !c.granted[p]);
  if (!pending.length) return;
  $('permreq-name').textContent = c.peerName;
  const { options } = hostPermissionOptions(c, asked);
  for (const p of pending) options[p].checked = false;
  renderPermissionChoices($('permreq-perms'), { name: 'permreq', only: pending, options });
  $('dlg-perm-request').showModal();
}

$('form-perm-request').addEventListener('submit', async (e) => {
  e.preventDefault();
  const chosen = readPermissionChoices($('permreq-perms'));
  $('dlg-perm-request').close();
  try {
    await controller.setPermissions({ ...controller.granted, ...chosen });
  } catch {
    toast('Você não escolheu o que compartilhar; "Ver a tela" continua desativado.', 'error');
  }
});
$('btn-permreq-deny').addEventListener('click', () => $('dlg-perm-request').close());

$('btn-copy-invite').addEventListener('click', async () => {
  const text = `ID: ${$('invite-id').textContent}  Código: ${$('invite-secret').textContent}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('ID e código copiados.');
  } catch {
    toast('Não foi possível copiar. Selecione e copie manualmente.', 'error');
  }
});

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
      ? `${e.detail.hostName} precisa aceitar seu pedido na tela dela.`
      : 'A pessoa precisa aceitar seu pedido na tela dela.';
    stopCountdown();
    stopCountdown = countdown($('pending-countdown'), e.detail.expiresAt);
  });
  c.addEventListener('join-error', (e) => {
    $('tech-form-error').textContent = errorMessage(e.detail.code);
  });
  c.addEventListener('stream', (e) => {
    $('video').srcObject = e.detail.stream;
    updateStage();
  });
}

$('btn-cancel-pending').addEventListener('click', () => controller?.cancelJoin());

$('btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('stage').requestFullscreen?.().catch(() => toast('Tela cheia indisponível neste navegador.'));
});

$('btn-record').addEventListener('click', async () => {
  const c = controller;
  if (c.recording) return c.stopRecording();
  const ok = await confirmDialog(
    'Gravar a sessão?',
    'A outra pessoa verá um aviso de gravação enquanto ela durar. O vídeo fica só neste dispositivo: guarde-o em local protegido e apague quando não precisar mais.',
    'Começar a gravar',
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
  if (!missing.length) return toast('Você já tem todas as permissões possíveis.');
  const options = {};
  for (const p of missing) {
    const supported = capabilityAllows(p, c.capabilities);
    options[p] = { disabled: !supported, hint: supported ? PERMISSION_HINTS[p] : 'Indisponível no dispositivo da outra pessoa.' };
  }
  renderPermissionChoices($('ask-perms'), { name: 'ask', only: missing, options });
  $('dlg-ask-perms').showModal();
});

$('form-ask-perms').addEventListener('submit', (e) => {
  e.preventDefault();
  const chosen = readPermissionChoices($('ask-perms'));
  $('dlg-ask-perms').close();
  if (Object.values(chosen).some(Boolean)) controller.requestPermissions(chosen);
});
$('btn-ask-cancel').addEventListener('click', () => $('dlg-ask-perms').close());

/* ---------- Sessão (comum) ---------- */

$('btn-end').addEventListener('click', () => controller?.end());

function resetSessionUi() {
  for (const id of ['chat-log', 'event-log', 'file-list', 'ended-downloads']) $(id).replaceChildren();
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
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
  box.replaceChildren();
  if (c.role === 'host') {
    // Anfitrião: interruptores. Só aparecem permissões que a outra pessoa pediu.
    const shown = PERMISSIONS.filter((p) => c.requested[p]);
    const { options } = hostPermissionOptions(c, c.requested);
    for (const p of shown) options[p].checked = c.granted[p];
    renderPermissionChoices(box, { name: 'live', only: shown, options });
    for (const input of box.querySelectorAll('input')) {
      input.setAttribute('role', 'switch');
      input.addEventListener('change', async () => {
        try {
          await c.setPermissions({ ...c.granted, [input.name]: input.checked });
        } catch {
          toast('Você não escolheu o que compartilhar; "Ver a tela" continua desativado.', 'error');
          renderSessionPermissions();
        }
      });
    }
    if (!shown.length) box.append(el('p', { className: 'hint' }, 'Nenhuma permissão foi pedida.'));
  } else {
    for (const p of PERMISSIONS) {
      const on = c.granted[p];
      box.append(el('div', { className: 'perm-item' }, [
        el('span', { 'aria-hidden': 'true' }, on ? '✔' : '✕'),
        el('span', { className: 'perm-label' }, PERMISSION_LABELS[p]),
        el('span', { className: 'perm-state', dataset: { on: String(on) } }, on ? 'Liberado' : 'Não liberado'),
      ]));
    }
  }
  const chatOn = c.can('chat');
  $('form-chat').hidden = !chatOn;
  $('chat-disabled').hidden = chatOn;
  const filesOn = c.can('files');
  $('file-input').disabled = !filesOn;
  $('file-pick-label').hidden = !filesOn;
  $('files-hint').textContent = filesOn
    ? 'Até 25 MB. Tipos aceitos: txt, log, csv, json, md, pdf, png, jpg, webp. A outra pessoa precisa aceitar.'
    : 'A transferência de arquivos não está liberada.';
  $('btn-record').disabled = !c.can('record');
  updateBanner();
  updateStage();
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
    else if (c.can('view') && c.paused) text = 'Compartilhamento pausado — a outra pessoa não vê sua tela';
    else if (c.can('view')) text = 'Tela não está sendo enviada — use "Compartilhar novamente"';
    else text = 'Sua tela não está sendo compartilhada';
    $('btn-pause').textContent = c.paused ? 'Retomar compartilhamento' : 'Pausar compartilhamento';
    $('btn-pause').disabled = !c.can('view') || !c.capture;
    $('btn-share-again').hidden = !(c.can('view') && !c.capture);
    $('banner-record').hidden = !c.peerRecording;
    $('banner-record').textContent = 'O técnico está gravando a sessão';
  } else {
    sharing = c.can('view') && !c.hostPaused;
    text = sharing ? `Você está vendo a tela de ${c.peerName}` : `Sessão com ${c.peerName} — tela não disponível`;
    $('banner-record').hidden = !c.recording;
    $('banner-record').textContent = 'Você está gravando';
    $('btn-record').textContent = c.recording ? 'Parar gravação' : 'Gravar';
  }
  banner.dataset.sharing = String(sharing);
  $('banner-share').textContent = text;
  $('banner-control').textContent = c.can('control') ? 'Controle remoto: ATIVO' : 'Controle remoto: desativado';
  $('session-peer').textContent = c.role === 'host' ? `Com: ${c.peerName} (presta suporte)` : `Com: ${c.peerName} (recebe suporte)`;
  document.title = c.role === 'host' && sharing ? `● Compartilhando a tela · ${BASE_TITLE}` : BASE_TITLE;
}

function updateStage() {
  const c = controller;
  if (!c) return;
  let overlay = '';
  if (c.role === 'host') {
    if (!c.can('view')) overlay = 'A visualização da tela não está liberada. Só chat e arquivos (se liberados) funcionam.';
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
  const item = el('li', { dataset: { kind } }, [el('time', {}, formatTime(at)), text]);
  $('event-log').prepend(item);
}

function addChat({ from, text, at }) {
  const who = from === 'me' ? 'Você' : controller.peerName;
  const item = el('li', { dataset: { from } }, [el('span', { className: 'meta' }, `${who} · ${formatTime(at)}`), text]);
  $('chat-log').append(item);
  item.scrollIntoView({ block: 'nearest' });
}

$('form-chat').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  if (controller?.sendChat(input.value)) input.value = '';
  else if (input.value.trim()) toast('Não foi possível enviar: chat não liberado ou conexão indisponível.', 'error');
});

/* ---------- Arquivos ---------- */

const fileRows = new Map();

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
  const a = el('a', { href: url, download: name, className: 'btn btn-small' }, `Salvar ${name}`);
  container.append(a);
  return a;
}

$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !controller) return;
  const ok = await confirmDialog('Enviar arquivo?', `Enviar "${file.name}" (${formatSize(file.size)}) para ${controller.peerName}? A pessoa ainda precisará aceitar.`, 'Enviar');
  if (!ok) return;
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
      fileRow(d.id, `Recebendo oferta: ${d.name} (${size})`);
      $('file-dlg-name').textContent = d.name;
      $('file-dlg-size').textContent = size;
      $('dlg-file').showModal();
      break;
    case 'receiving':
      fileRow(d.id, `Recebendo ${d.name}…`).progress.hidden = false;
      break;
    case 'received': {
      const row = fileRow(d.id, `Recebido e verificado: ${d.name} `);
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
      if (pendingIncoming === d.id && $('dlg-file').open) $('dlg-file').close();
      fileRow(d.id, `Falhou: ${d.name} — ${FILE_ERROR_MESSAGES[d.reason] ?? d.reason}`).progress.hidden = true;
      break;
    default:
  }
}

$('form-file').addEventListener('submit', (e) => {
  e.preventDefault();
  $('dlg-file').close();
  if (pendingIncoming) controller?.files?.accept(pendingIncoming);
  pendingIncoming = null;
});
function rejectFile() {
  if (pendingIncoming) controller?.files?.reject(pendingIncoming);
  pendingIncoming = null;
  if ($('dlg-file').open) $('dlg-file').close();
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
    rejected: `Não aceito: ${d.name} — ${FILE_ERROR_MESSAGES[d.reason] ?? FILE_ERROR_MESSAGES.rejected}`,
    failed: `Falhou: ${d.name} — ${FILE_ERROR_MESSAGES[d.reason] ?? d.reason}`,
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
    const target = controller.state === 'ended' || controller.state === 'failed' ? $('ended-downloads') : $('file-list');
    const holder = target === $('file-list') ? el('li', {}, 'Gravação pronta: ') : el('p', {}, 'Gravação da sessão: ');
    target.prepend(holder);
    downloadLink(blob, name, holder);
  }
}

/* ---------- Encerramento ---------- */

function onEnded(reason) {
  stopCountdown();
  stopDialogCountdown();
  for (const id of ['dlg-approve', 'dlg-file', 'dlg-perm-request', 'dlg-ask-perms', 'dlg-confirm']) {
    if ($(id).open) $(id).close();
  }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('video').srcObject = null;
  $('session-banner').hidden = true;
  document.title = BASE_TITLE;
  const c = controller;
  // Falha de entrada do técnico (antes de ser aceito) volta para o formulário.
  if (c.role === 'viewer' && !c.startedAt && reason !== 'cancelled') {
    $('ended-title').textContent = 'Conexão não realizada';
  } else {
    $('ended-title').textContent = c.state === 'failed' ? 'Falha na conexão' : 'Sessão encerrada';
  }
  $('ended-reason').textContent = endMessage(reason, c.role);
  showView('view-ended');
  signaling.close();
}

$('btn-home').addEventListener('click', () => {
  controller?.dispose();
  controller = null;
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
  fileRows.clear();
  $('ended-downloads').replaceChildren();
  delete document.body.dataset.role;
  showView('view-home');
  renderHistory();
});

// Aviso ao fechar a aba no meio de uma sessão.
window.addEventListener('beforeunload', (e) => {
  if (controller && ['waiting', 'connecting', 'connected', 'reconnecting'].includes(controller.state)) e.preventDefault();
});

renderHome();
