// Ajustes do "Acessar computador sem supervisão" (app de computador).
// A interface só exibe e pede; quem decide e guarda tudo é o processo principal.

import { checkPassword } from '../../shared/password-policy.js';
import { formatSessionId } from '../../shared/protocol.js';
import {
  $, closeDialog, confirmDialog, el, openDialog, readPermissionChoices, renderPermissionChoices, toast,
} from './ui.js';

const LOG_TEXT = {
  enabled: 'Acesso sem supervisão ativado',
  disabled: 'Acesso sem supervisão desativado',
  password_changed: 'Senha trocada (dispositivos precisam entrar de novo)',
  settings_changed: 'Ajustes alterados',
  device_revoked: 'Acesso revogado',
  unlocked_locally: 'Desbloqueado neste computador',
  session_requested: 'Pedido de conexão',
  auth_success: 'Entrou com a senha',
  auth_failed: 'Senha incorreta',
  auth_blocked: 'Tentativa bloqueada',
  auth_rejected: 'Dispositivo não autorizado',
  session_ended: 'Sessão encerrada',
};

const ERRORS = {
  session_active: 'Termine as sessões em andamento antes de mudar isso (ninguém pode alterar este acesso controlando o computador).',
  not_confirmed: 'Marque a confirmação para continuar.',
  weak_password: 'A senha não atende aos requisitos.',
  already_enabled: 'O acesso sem supervisão já está ativado.',
};

const when = (ts) => new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export function setupUnattendedSettings(desktop, { onStatus } = {}) {
  let status = null;
  let dialogMode = 'enable';
  let togglePending = false; // não sobrescreve o interruptor enquanto a mudança da pessoa é aplicada

  function render(next) {
    status = next;
    onStatus?.(next);
    const on = Boolean(next?.enabled);
    $('ua-off').hidden = on;
    $('ua-on').hidden = !on;
    $('ua-devices-block').hidden = !on;
    $('unattended-indicator').hidden = !on;
    if (!on) return;

    $('ua-device-id').textContent = formatSessionId(next.deviceId);
    const parts = [next.lan ? 'Rede local: disponível' : 'Rede local: indisponível'];
    const internet = next.presences.find((p) => p.internet);
    parts.push(internet ? `Internet: ${internet.status === 'online' ? 'conectado ao servidor' : 'tentando conectar…'}` : 'Internet: sem servidor configurado');
    if (next.activeSessions.length) parts.push(`Em uso agora por ${next.activeSessions.map((s) => s.techName).join(', ')}`);
    $('ua-presence').textContent = parts.join(' · ');

    if (!togglePending) $('ua-allow-new').checked = next.allowNewDevices;
    const locked = next.hardLocked || next.lockedUntil > Date.now();
    $('ua-locked').hidden = !locked;
    $('ua-locked').textContent = next.hardLocked
      ? 'Bloqueado por excesso de senhas incorretas. Só volta a aceitar conexões depois de desbloquear aqui.'
      : (locked ? `Bloqueado temporariamente por senhas incorretas até ${when(next.lockedUntil)}.` : '');
    $('btn-ua-unlock').hidden = !locked;
    $('ua-vault').hidden = next.protection === 'system';
    $('ua-vault').textContent = 'O cofre de senhas do sistema não está disponível: os dados do acesso ficam protegidos só pelas permissões do arquivo.';

    $('ua-autostart-row').hidden = !next.autostart.supported;
    $('ua-autostart').checked = next.autostart.enabled;

    const list = $('ua-devices');
    list.replaceChildren();
    if (!next.devices.length) {
      list.append(el('li', { className: 'group-row secondary' }, 'Nenhum dispositivo entrou ainda.'));
    }
    for (const d of next.devices) {
      const revoke = el('button', { type: 'button', className: 'btn btn-plain btn-destructive-text' }, 'Revogar acesso');
      revoke.setAttribute('aria-label', `Revogar acesso de ${d.name || 'dispositivo sem nome'}`);
      revoke.addEventListener('click', async () => {
        const ok = await confirmDialog('Revogar acesso?', `${d.name || 'Este dispositivo'} não poderá mais entrar sem autenticar de novo (e não conseguirá, se "Aceitar novos dispositivos" estiver desligado). Sessões dele em andamento são encerradas agora.`, { confirmLabel: 'Revogar acesso', destructive: true });
        if (ok) apply(await desktop.unattendedRevoke(d.id), 'Acesso revogado.');
      });
      list.append(el('li', { className: 'group-row' }, [
        el('span', { className: 'row-text' }, [
          el('span', { className: 'row-title' }, d.name || 'Dispositivo sem nome'),
          el('span', { className: 'row-hint' }, `Autorizado em ${when(d.addedAt)} · último acesso ${when(d.lastUsedAt)}`),
        ]),
        revoke,
      ]));
    }

    const log = $('ua-log');
    log.replaceChildren();
    for (const e of next.log) {
      log.append(el('li', { dataset: { kind: e.event.startsWith('auth_f') || e.event === 'auth_blocked' || e.event === 'auth_rejected' ? 'warn' : 'info' } }, [
        el('time', {}, when(e.ts)),
        el('span', {}, `${LOG_TEXT[e.event] ?? e.event}${e.techName ? ` — ${e.techName}` : ''}`),
      ]));
    }
  }

  function apply(result, okText) {
    if (result?.ok) {
      render(result.status);
      if (okText) toast(okText);
    } else {
      toast(ERRORS[result?.error] ?? 'Não foi possível concluir.', 'error');
      refresh();
    }
    return result;
  }

  async function refresh() {
    render(await desktop.unattendedStatus());
  }

  /* ----- Diálogo de ativação / troca de senha ----- */

  function showProblems() {
    const pw = $('ua-dlg-password').value;
    const list = $('ua-dlg-problems');
    list.replaceChildren();
    if (!pw) return true;
    const { problems } = checkPassword(pw);
    for (const p of problems) list.append(el('li', {}, p));
    return problems.length === 0;
  }

  function openSetup(mode) {
    dialogMode = mode;
    const enabling = mode === 'enable';
    $('ua-dlg-title').textContent = enabling ? 'Acessar computador sem supervisão' : 'Trocar a senha deste computador';
    $('ua-dlg-explain').hidden = !enabling;
    $('ua-dlg-name-group').hidden = !enabling;
    $('ua-dlg-perms-block').hidden = !enabling;
    $('ua-dlg-confirm-row').hidden = !enabling;
    $('btn-ua-dlg-submit').textContent = enabling ? 'Ativar acesso sem supervisão' : 'Trocar senha';
    for (const id of ['ua-dlg-password', 'ua-dlg-password2']) $(id).value = '';
    $('ua-dlg-understand').checked = false;
    $('ua-dlg-error').textContent = '';
    $('ua-dlg-problems').replaceChildren();
    renderPermissionChoices($('ua-dlg-perms'), {
      name: 'uaallow',
      only: ['control', 'files', 'chat', 'record'],
      options: {
        control: { checked: true, hint: 'Clicar e digitar neste computador (aviso vermelho sempre visível).' },
        chat: { checked: true },
        files: { checked: false },
        record: { checked: false, hint: 'A gravação fica no dispositivo de quem entrar.' },
      },
    });
    openDialog($('dlg-ua'));
    $(enabling ? 'ua-dlg-name' : 'ua-dlg-password').focus();
  }

  $('ua-dlg-password').addEventListener('input', showProblems);
  // Mensagem de erro some assim que a pessoa corrige algo.
  for (const id of ['ua-dlg-password', 'ua-dlg-password2', 'ua-dlg-understand']) {
    $(id).addEventListener('input', () => { $('ua-dlg-error').textContent = ''; });
  }
  $('btn-ua-dlg-cancel').addEventListener('click', () => closeDialog($('dlg-ua')));
  $('form-ua-setup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('ua-dlg-password').value;
    const error = (text) => { $('ua-dlg-error').textContent = text; };
    if (!showProblems() || !pw) return error('A senha não atende aos requisitos acima.');
    if (pw !== $('ua-dlg-password2').value) return error('As duas senhas não são iguais.');
    if (dialogMode === 'enable' && !$('ua-dlg-understand').checked) return error('Marque a confirmação para ativar.');
    const result = dialogMode === 'enable'
      ? await desktop.unattendedEnable({
        confirm: true, password: pw, deviceName: $('ua-dlg-name').value.trim(),
        permissions: { view: true, ...readPermissionChoices($('ua-dlg-perms')) },
      })
      : await desktop.unattendedChangePassword(pw);
    // Limpa os campos de senha logo após o uso.
    for (const id of ['ua-dlg-password', 'ua-dlg-password2']) $(id).value = '';
    if (!result?.ok) return error(ERRORS[result?.error] ?? (result?.problems?.join(' ') || 'Não foi possível concluir.'));
    closeDialog($('dlg-ua'));
    apply(result, dialogMode === 'enable' ? 'Acesso sem supervisão ativado.' : 'Senha trocada. Os dispositivos precisam entrar de novo.');
  });

  $('btn-ua-setup').addEventListener('click', () => openSetup('enable'));
  $('btn-ua-password').addEventListener('click', () => openSetup('password'));
  $('btn-ua-disable').addEventListener('click', async () => {
    const ok = await confirmDialog('Desativar o acesso sem supervisão?', 'Ninguém mais entrará neste computador sem aprovação. Sessões sem supervisão em andamento serão encerradas e a senha será apagada.', { confirmLabel: 'Desativar', destructive: true });
    if (ok) apply(await desktop.unattendedDisable(), 'Acesso sem supervisão desativado.');
  });
  $('btn-ua-unlock').addEventListener('click', async () => {
    apply(await desktop.unattendedUnlock(), 'Desbloqueado.');
  });
  $('ua-allow-new').addEventListener('change', async (e) => {
    togglePending = true;
    try {
      apply(await desktop.unattendedUpdate({ allowNewDevices: e.target.checked }));
    } finally {
      togglePending = false;
    }
  });
  $('ua-autostart').addEventListener('change', async (e) => {
    const r = await desktop.setAutostart(e.target.checked);
    e.target.checked = r.enabled;
  });

  desktop.onUnattendedChanged(render);
  refresh();
  return { refresh, get status() { return status; } };
}
