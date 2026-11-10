// Textos exibidos ao usuário para códigos de erro e motivos de encerramento.

const ERRORS = {
  invalid_credentials: 'ID ou código de acesso incorretos, ou o convite expirou.',
  session_busy: 'Outra pessoa já está pedindo acesso a esta sessão. Tente de novo em instantes.',
  rate_limited: 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.',
  signaling_unreachable: 'Não foi possível falar com o servidor. Verifique sua internet.',
  server_busy: 'O servidor está no limite de sessões. Tente mais tarde.',
  invalid_name: 'Informe seu nome.',
  no_permissions_requested: 'Escolha pelo menos uma permissão.',
  already_in_session: 'Você já está em uma sessão.',
  no_pending_request: 'O pedido expirou antes da resposta.',
  not_active: 'A sessão não está ativa.',
  invalid_message: 'Mensagem inválida.',
  capture_cancelled: 'Você não escolheu o que compartilhar.',
  lan_not_found: 'Não encontramos esse convite na sua rede. Confira o ID e o código, se os dois aparelhos estão no mesmo Wi-Fi e se o Ponte foi liberado no firewall do outro computador. Você também pode informar o endereço dele abaixo.',
  lan_not_found_address: 'Não encontramos o convite nesse endereço. Confira o endereço, o ID e o código, e se o firewall do outro computador libera o Ponte.',
  control_no_target: 'Para liberar o controle, compartilhe a tela inteira (não uma janela).',
  control_accessibility: 'Permita o Ponte em Ajustes do Sistema › Privacidade e Segurança › Acessibilidade e ligue o controle de novo.',
  control_unavailable: 'O controle remoto não está disponível neste computador.',
  device_unavailable: 'Computador não encontrado. Confira o ID e se ele está ligado, com o Ponte aberto e o acesso sem supervisão ativado.',
  device_not_found: 'Não encontramos esse computador na rede local e não há servidor da internet configurado (Ajustes › Servidor da organização).',
  invalid_device: 'ID do computador inválido.',
};

export function errorMessage(code) {
  return ERRORS[code] ?? 'Algo deu errado. Tente novamente.';
}

export function endMessage(reason, role) {
  const host = role === 'host';
  switch (reason) {
    case 'host_ended': return host ? 'Você encerrou a sessão.' : 'A pessoa atendida encerrou a sessão.';
    case 'tech_ended': return host ? 'Quem prestava suporte encerrou a sessão.' : 'Você encerrou a sessão.';
    case 'invite_expired': return 'O convite expirou sem ser usado. Gere um novo se ainda precisar de ajuda.';
    case 'too_many_attempts': return 'Houve muitas tentativas com código errado. Por segurança, o convite foi cancelado.';
    case 'host_timeout': return host ? 'Sua conexão caiu por tempo demais e a sessão foi encerrada.' : 'A pessoa atendida perdeu a conexão e não voltou a tempo.';
    case 'tech_timeout': return host ? 'Quem prestava suporte perdeu a conexão e não voltou a tempo.' : 'Sua conexão caiu por tempo demais e a sessão foi encerrada.';
    case 'max_duration': return 'A sessão atingiu a duração máxima permitida.';
    case 'declined': return 'A pessoa recusou o pedido de conexão.';
    case 'request_expired': return 'O pedido não foi respondido a tempo.';
    case 'cancelled': return 'Você desistiu do pedido.';
    case 'connection_failed': return 'Não foi possível manter a conexão entre os dispositivos. Redes com firewall ou NAT restritivo exigem um servidor TURN configurado.';
    case 'session_lost': return 'A sessão não existe mais no servidor (pode ter sido reiniciado).';
    case 'signaling_lost': return 'Perdemos a conexão com o servidor e não foi possível reconectar.';
    case 'auth_wrong_password': return host ? 'Alguém tentou entrar sem supervisão com uma senha incorreta. A tentativa foi bloqueada e registrada.' : 'Senha incorreta.';
    case 'auth_too_soon': return host ? 'Uma nova tentativa chegou cedo demais e foi recusada.' : 'Muitas tentativas seguidas: aguarde antes de tentar de novo.';
    case 'auth_locked': return host ? 'Acesso sem supervisão bloqueado por excesso de senhas incorretas.' : 'O acesso a este computador está bloqueado por excesso de tentativas. O dono precisa desbloquear (ou aguarde).';
    case 'auth_device_not_allowed': return host ? 'Um dispositivo não autorizado tentou entrar e foi recusado.' : 'Este dispositivo não está autorizado. O dono do computador precisa permitir novos dispositivos.';
    case 'auth_timeout': return 'A autenticação não foi concluída a tempo.';
    case 'auth_expired': case 'auth_error': case 'auth_failed': case 'auth_denied': case 'auth_not_enabled':
      return 'Não foi possível autenticar o acesso sem supervisão.';
    case 'revoked': return host ? 'Você revogou o acesso deste dispositivo.' : 'O dono do computador revogou o acesso deste dispositivo.';
    case 'disabled': return host ? 'O acesso sem supervisão foi desativado.' : 'O acesso sem supervisão foi desativado naquele computador.';
    case 'policy_violation': return 'A sessão foi encerrada porque o outro lado tentou usar um recurso não autorizado.';
    default: return 'A sessão foi encerrada.';
  }
}

export const STATE_TEXT = {
  connecting: 'Estabelecendo conexão segura…',
  connected: 'Conectado com criptografia ponta a ponta',
  reconnecting: 'Conexão instável — tentando reconectar (até 30 s)…',
  failed: 'Falha na conexão',
  ended: 'Sessão encerrada',
};
