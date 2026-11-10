# Ponte · Suporte remoto assistido

Aplicativo para uma pessoa **compartilhar a tela com quem vai ajudá-la**, com convite de uso
único, aprovação explícita, permissões separadas por recurso e criptografia ponta a ponta (WebRTC).
Funciona como **programa de computador** (Windows, macOS e Linux) e também pelo navegador.

> **Status: protótipo funcional (MVP), ainda não pronto para uso em produção.** O fluxo principal
> funciona de verdade e está coberto por testes automatizados, mas faltam itens importantes,
> listados em [Limitações](#limitações): controle remoto, acesso não assistido, verificação da
> identidade de quem presta suporte e assinatura digital dos instaladores.

## Baixar e instalar

Os instaladores ficam na página **Releases** do repositório:

| Sistema | Arquivo | Observação |
|---|---|---|
| Windows | `Ponte-x.y.z-win-x64.exe` (instalador) ou `…-win-portable-x64.exe` (sem instalar) | Sem assinatura digital: o SmartScreen avisa. Clique em **Mais informações › Executar assim mesmo**. |
| macOS | `Ponte-x.y.z-mac-*.dmg` | Sem assinatura/notarização: abra com **clique direito › Abrir**. Na 1ª captura, permita em **Ajustes do Sistema › Privacidade e Segurança › Gravação de Tela**. |
| Linux | `Ponte-x.y.z-linux-x86_64.AppImage` ou `…-linux-amd64.deb` | AppImage: `chmod +x` e execute. Debian/Ubuntu: `sudo apt install ./arquivo.deb`. |

Os instaladores são gerados pelo GitHub Actions (workflow **Executáveis**) sempre que a versão do `package.json` muda na `main`.

## Como usar

1. **Quem recebe ajuda** abre o Ponte › **Receber suporte** › **Gerar convite** e passa o ID e o código
   para quem vai ajudar (por telefone, por exemplo).
2. **Quem ajuda** abre o Ponte › **Prestar suporte**, digita ID, código e nome, e escolhe as permissões.
3. Quem recebe ajuda vê o nome e o que foi pedido, escolhe o que liberar e qual tela mostrar.
4. Durante a sessão: faixa vermelha permanente indica o compartilhamento; dá para pausar,
   revogar permissões e encerrar a qualquer momento. Os dois conferem o **código de verificação**.

### Conexão entre computadores

- **Rede local (padrão)**: computadores no mesmo Wi-Fi/roteador se encontram sozinhos pelo ID e
  código, sem servidor externo. O computador de quem gera o convite só fica visível na rede
  enquanto o convite ou a sessão existir. Na 1ª vez, o **Firewall do Windows** pergunta se o
  Ponte pode usar a rede: permita em **Redes privadas**. Se a busca não achar, informe o endereço
  que aparece na tela do convite ("Na rede local: 192.168.…").
- **Servidor de conexão na internet**: para redes diferentes (casa ↔ trabalho, 4G), os dois
  computadores precisam de um "ponto de encontro" com HTTPS. Dá para criar um **gratuito**:

  [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/geandreac/ponte-suporte-remoto)

  1. Clique no botão acima, entre no Render (dá para usar a conta do GitHub) e confirme a criação
     do serviço **ponte-servidor** no plano gratuito.
  2. Quando terminar, copie o endereço `https://….onrender.com` exibido no painel.
  3. Nos **dois** computadores: **Ajustes › Servidor da organização**, cole o endereço e clique em
     **Salvar e reiniciar**.

  No plano gratuito o servidor "dorme" após 15 minutos sem uso e leva até ~1 minuto para acordar:
  o app mostra **"Acordando o servidor…"** e espera. Enquanto houver conexão, o app envia um sinal
  leve a cada 4 minutos para ele não dormir. Detalhes e alternativas em
  [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md). Ainda é preciso alguém no outro computador para
  aceitar a conexão; o acesso sem supervisão está planejado em
  [docs/ACESSO-SEM-SUPERVISAO.md](docs/ACESSO-SEM-SUPERVISAO.md).

### Acessar computador sem supervisão

Para entrar no **seu** computador de outro lugar sem alguém aprovar: no computador que será
acessado, **Ajustes › Acessar computador sem supervisão › Configurar…**, crie uma senha só para ele
e confirme. No outro: **Prestar suporte › Sem supervisão**, informe o ID e a senha. Na mesma rede
funciona direto; de fora, com o servidor da internet configurado (recomendado: Oracle Cloud Free).
Desativado por padrão; a senha nunca é enviada nem guardada em texto. Detalhes e limitações (ex.:
no Windows o computador precisa estar desbloqueado) em [docs/MIGRACAO-ORACLE.md](docs/MIGRACAO-ORACLE.md).

### Controle remoto

Quem presta suporte pede **Controlar teclado e mouse**; quem recebe ajuda libera (desligado por
padrão, com confirmação explícita). Funciona quando quem recebe ajuda usa o **app de computador**
e compartilha a **tela inteira**. Durante o controle, um aviso vermelho compacto fica sempre por
cima de tudo, no canto inferior direito (dá para arrastar ou **minimizar**: aí vira um botão na
barra de tarefas com selo vermelho), com o botão **Parar**, e o atalho **Ctrl+Alt+Shift+X** (⌘⌥⇧X no Mac) retoma o
controle na hora. Pausar o compartilhamento também suspende o controle.

- macOS: permita o Ponte em **Ajustes do Sistema › Privacidade e Segurança › Acessibilidade**.
- Linux: requer sessão X11 (Xorg); no Wayland o controle fica indisponível.

### Atualização automática

A partir da 0.2.0, o app procura novas versões ao abrir e a cada 6 horas. No **Windows
(instalador)** e no **Linux (AppImage)**, baixa em segundo plano e instala ao fechar (ou na hora,
pelo botão **Reiniciar e atualizar**, nunca durante uma sessão). No macOS, no Windows portátil e no
.deb, avisa e abre a página de download. Dá para desligar em **Ajustes › Atualizações**.

## O que está implementado

| Recurso | Situação |
|---|---|
| App de computador (Electron) com menus nativos, seletor próprio de tela/janela e Ajustes | ✅ |
| Conexão na rede local sem servidor externo (descoberta autenticada + TLS) | ✅ |
| Controle de teclado e mouse (app de computador), com consentimento, aviso sempre visível e atalho para retomar | ✅ |
| Atualização automática pelas Releases do GitHub (Windows instalador e AppImage) | ✅ |
| Versão web (mesma interface), responsiva para celular | ✅ |
| Convite: ID de 9 dígitos + código de 8 caracteres, uso único, expira em 10 min | ✅ |
| Aprovação mostra nome (marcado como não verificado), permissões pedidas e aviso contra golpes | ✅ |
| Permissões separadas (ver tela, arquivos, chat, gravação), tudo desligado por padrão, revogáveis na hora | ✅ |
| Tela, chat e arquivos via WebRTC ponta a ponta + código de verificação contra interceptação | ✅ |
| Pausar, encerrar, reconexão automática, estados de falha | ✅ |
| Arquivos com aceite dos dois lados, lista de tipos, 25 MB, verificação de conteúdo e SHA-256 | ✅ |
| Gravação local opcional com consentimento e indicador contínuo | ✅ |
| Histórico local e log de auditoria sem conteúdo sensível; limite de tentativas | ✅ |
| Servidor de conexão gratuito (Render) com espera pelo "acordar" e sinal periódico | ✅ |
| **Acessar computador sem supervisão** (senha fixa por computador, rede local e internet; app de computador) | ✅ ([como funciona](docs/MIGRACAO-ORACLE.md#4-senha-fixa-por-computador--como-foi-implementada)) |
| Implantação na Oracle Cloud Free (HTTPS automático + TURN próprio) | ✅ arquivos e guia ([docs/MIGRACAO-ORACLE.md](docs/MIGRACAO-ORACLE.md)); a VM depende da sua conta |
| Assinatura digital dos instaladores | ⛔ Requer certificados pagos (Apple Developer, Authenticode) |

## Desenvolvimento

Requisitos: Node.js 20+.

```bash
npm install
```

```bash
npm run desktop
```

Abre o app de computador a partir do código-fonte.

```bash
npm start
```

Sobe o servidor web em `http://localhost:8080` (só na máquina local, por padrão).

```bash
npm run dist
```

Gera o instalador do sistema atual em `dist/` (`dist:linux`, `dist:win`, `dist:mac` para escolher).

## Testes

```bash
npm test
```

81 testes unitários e de integração (servidor real + WebSocket): permissões, consentimento,
expiração, bloqueio por tentativas, retomada, encerramento, protocolo, log sem segredos, TURN,
arquivos e ajustes do app.

```bash
npm run test:e2e
```

20 etapas com **dois Chromium reais** conectados por WebRTC (um em tela de celular com
"reduzir movimento"), incluindo navegação por teclado, erros junto aos campos e tema escuro.

```bash
xvfb-run -a -s "-screen 0 1280x800x24" npm run test:desktop
```

15 etapas no **app Electron real**: duas janelas, seletor de tela, isolamento de segurança,
Ajustes, rede local (descoberta UDP + TLS validado) e controle remoto movendo o mouse real. Com `PONTE_EXECUTABLE=dist/linux-unpacked/ponte` testa o executável empacotado.
No Windows/macOS, rode sem o `xvfb-run`.

## Estrutura

```
desktop/  app de computador: processo principal, preload, ajustes
server/   sinalização WebSocket, sessões, limites, auditoria, ICE/TURN, arquivos estáticos
shared/   regras usadas pelos dois lados: permissões, protocolo, estados, arquivos, verificação
public/   interface (HTML/CSS) e cliente: sinalização, WebRTC, sessão, arquivos, gravação
test/     testes node:test     e2e/  testes com navegadores e app reais     docs/  arquitetura, design, implantação
build/    ícone e recursos do instalador     .github/workflows/  CI e geração dos executáveis
```

- Arquitetura e segurança: [docs/ARQUITETURA.md](docs/ARQUITETURA.md)
- Diretrizes visuais aplicadas: [docs/DESIGN.md](docs/DESIGN.md)
- Implantação do servidor: [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md)

## Limitações

- **Acesso sem supervisão** só no app de computador; no Windows exige o computador desbloqueado
  e não há segundo fator por app autenticador (a camada extra é a lista de dispositivos autorizados).
  **Controle remoto** só no app de computador, com a tela
  inteira compartilhada; não funciona no Wayland nem na versão web (aparece como indisponível).
- **Atualização automática** não instala sozinha no macOS (app sem assinatura), no Windows
  portátil nem no .deb: nesses casos o app avisa e abre a página de download.
- **Identidade de quem presta suporte não é verificada**: o nome é informado pela própria pessoa
  (a interface avisa). Contas autenticadas são o próximo passo para uso real.
- **Instaladores sem assinatura digital**: Windows e macOS exibem avisos de segurança.
- **Redes diferentes exigem servidor com HTTPS**; redes com NAT restritivo exigem também TURN.
  Na rede local, Wi-Fi com "isolamento de clientes" (comum em redes de visitantes) impede a conexão.
- **Estado do servidor em memória**: reiniciar encerra as sessões.
- **Gravação** fica no dispositivo de quem presta suporte; um cliente modificado poderia gravar sem
  avisar (como qualquer pessoa pode filmar a tela que vê).
- **Validação de arquivos** reduz riscos, mas não substitui antivírus.
- Antes de uso público: revisão de LGPD (o log de auditoria guarda IPs) e teste de intrusão.

## Licença

MIT — veja [LICENSE](LICENSE).
