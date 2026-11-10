# Ponte · instruções para o Claude Code

App de suporte remoto assistido: servidor de sinalização (Node + WebSocket), interface web e app
Electron (Windows, macOS, Linux). Detalhes em `README.md` e `docs/` (`ARQUITETURA.md`,
`ACESSO-SEM-SUPERVISAO.md`, `MIGRACAO-ORACLE.md`).

## Comandos

- `npm run check`: checagem de sintaxe.
- `npm test`: testes unitários e de integração (`node:test`).
- `npm run test:e2e`: dois Chromium reais via WebRTC. Na primeira vez: `npx playwright install chromium`.
- `npm run test:desktop`: app Electron real (no Linux, com `xvfb-run`).
- `npm run desktop`: abre o app a partir do código-fonte. `npm start`: servidor em `localhost:8080`.
- `npm run dist:win`: instalador do Windows em `dist/`.

Depois de mudar código, rode pelo menos `npm run check` e `npm test`; se mexer em `desktop/` ou
`public/`, rode também os testes e2e correspondentes.

## Testar no Windows com o Ponte instalado aberto

O Ponte instalado ocupa a porta UDP 47800 (rede local) e o atalho global de retomar o controle.
Com ele aberto, `npm run test:desktop` falha na descoberta pela rede local e no registro do atalho.
Feche o Ponte instalado (inclusive na área de notificação) antes de rodar, ou pelo menos use
`PONTE_LAN_PORT=47900` para a parte da rede local. Não feche o Ponte do usuário sem perguntar:
ele pode estar servindo de acesso sem supervisão.

## Commits e versões

- Autor: a identidade do git global (`geandreac`). Nunca adicionar `Co-Authored-By`, "Generated
  with Claude Code" ou link de sessão. Não trocar `user.name`/`user.email` nem usar `--author`.
- Mensagens em português: título curto no imperativo/descritivo, com a versão entre parênteses
  quando houver release, e corpo em tópicos `- `.
- Commits novos sobre a `main`; não reescrever histórico (sem `rebase`/`push --force`).
- Alterar `version` no `package.json` e fazer push na `main` dispara o workflow de release
  (instaladores e atualização automática para os usuários). Só faça isso de propósito, junto
  com a entrada correspondente no `CHANGELOG.md`.
- Pergunte antes de `git push` se o pedido não disser para enviar.

## Regras de segurança do projeto

- Senhas nunca em texto puro, em log ou na rede: só o hash scrypt (salt aleatório, parâmetros
  versionados) guardado com o cofre do sistema (`safeStorage`); a prova é por desafio-resposta.
- O servidor nunca conhece a senha nem o conteúdo das sessões (WebRTC ponta a ponta).
- Consentimento explícito: permissões começam desligadas; controle remoto nunca vem marcado.
- Nada de persistência escondida, execução oculta ou desativação de avisos: o aviso de controle
  e o ícone na área de notificação ficam visíveis enquanto houver acesso.
- Mudanças em Ajustes sensíveis (acesso sem supervisão, senha) ficam bloqueadas durante sessões.
- Logs e auditoria passam pelo `redact` do servidor; não registre segredos, tokens ou senhas.
