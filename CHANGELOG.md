# Histórico de versões

## 0.3.1
- Correção: depois de uma tentativa sem supervisão recusada, o computador podia ficar até 30 s
  impedindo mudanças nos Ajustes (sessão órfã contada como "em andamento"). Quem conecta agora
  avisa o servidor ao ser recusado, e só sessões realmente ativas bloqueiam os Ajustes.
- O computador mostra o motivo real da recusa ("senha incorreta", "dispositivo não autorizado").

## 0.3.0
- **Acessar computador sem supervisão** (app de computador): senha fixa por computador (scrypt com
  salt, cofre do sistema), ativação explícita e só sem sessões em andamento, desafio-resposta sem
  enviar a senha, atraso progressivo e bloqueios, dispositivos autorizados com revogação, registro
  de segurança, ícone na área de notificação, notificações de início/fim, início com o sistema
  opcional. Funciona na rede local e pela internet.
- Servidor: registro de computadores com chave Ed25519 (ID derivado da chave) e sessões sem
  supervisão que nascem sem permissões; motivo de encerramento (ex.: acesso revogado).
- Implantação na **Oracle Cloud Free** (`deploy/oracle/`): Caddy com HTTPS automático, servidor e
  TURN próprio (coturn); guia em docs/MIGRACAO-ORACLE.md.
- Correção: interruptor dos Ajustes podia ser desfeito por uma atualização de estado atrasada.

## 0.2.4
- Servidor de conexão gratuito no Render (`render.yaml` + botão "Deploy to Render") para conectar
  computadores em redes diferentes.
- Se o servidor estiver em repouso, o app mostra "Acordando o servidor…" e espera até ~1 minuto
  em vez de falhar; reconexão mais longa para reinícios do servidor.
- Sinal periódico (a cada 4 min) mantém o servidor ativo enquanto houver conexão.
- Especificação do futuro "Acessar computador sem supervisão" (docs/ACESSO-SEM-SUPERVISAO.md).

## 0.2.3
- Aviso de controle remoto menor ("Nome controlando · Parar"), no canto inferior direito da tela
  (fora de barras de título e abas) e arrastável. Pode ser minimizado: vira um botão na barra de
  tarefas ("Controle remoto ativo", com selo vermelho no Windows) para você continuar ciente do
  acesso sem nada na tela. Some ao parar o controle.

## 0.2.2
- Correção: no Windows, o app de quem recebia ajuda podia travar segundos depois de liberar o
  controle (clique remoto na barra de título prendia o app). A injeção de teclado e mouse agora
  roda num processo separado, recebendo os comandos por um canal direto.
- Botão do mouse "preso" por 15 s sem comandos é solto automaticamente.
- A faixa de controle remoto não pode mais ser arrastada.

## 0.2.1
- Versão de verificação da atualização automática (sem mudanças de funcionamento).

## 0.2.0
- Conexão na rede local sem servidor externo (descoberta autenticada pelo código do convite + TLS).
- Controle de teclado e mouse no app de computador, com consentimento, faixa sempre visível e
  atalho Ctrl+Alt+Shift+X para retomar.
- Atualização automática pelas Releases do GitHub.
- Correção: dois computadores diferentes não se encontravam no modo padrão.

## 0.1.0
- Primeira versão: convite com consentimento, compartilhamento de tela, chat, arquivos e gravação
  via WebRTC ponta a ponta; app de computador e versão web.
