# Histórico de versões

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
