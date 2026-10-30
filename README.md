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

### Servidor de conexão

O app precisa de um servidor de sinalização para que os dois computadores se encontrem
(tela, chat e arquivos **não passam** por ele: vão direto, cifrados).

- **Neste computador** (padrão): o app sobe um servidor interno, acessível só na própria máquina.
  Serve para experimentar com duas janelas (**Arquivo › Nova janela**).
- **Servidor da organização**: para conectar computadores diferentes, publique o servidor com
  HTTPS ([docs/IMPLANTACAO.md](docs/IMPLANTACAO.md), inclui Dockerfile) e informe o endereço em
  **Ajustes** nos dois computadores.

## O que está implementado

| Recurso | Situação |
|---|---|
| App de computador (Electron) com menus nativos, seletor próprio de tela/janela e Ajustes | ✅ |
| Versão web (mesma interface), responsiva para celular | ✅ |
| Convite: ID de 9 dígitos + código de 8 caracteres, uso único, expira em 10 min | ✅ |
| Aprovação mostra nome (marcado como não verificado), permissões pedidas e aviso contra golpes | ✅ |
| Permissões separadas (ver tela, arquivos, chat, gravação), tudo desligado por padrão, revogáveis na hora | ✅ |
| Tela, chat e arquivos via WebRTC ponta a ponta + código de verificação contra interceptação | ✅ |
| Pausar, encerrar, reconexão automática, estados de falha | ✅ |
| Arquivos com aceite dos dois lados, lista de tipos, 25 MB, verificação de conteúdo e SHA-256 | ✅ |
| Gravação local opcional com consentimento e indicador contínuo | ✅ |
| Histórico local e log de auditoria sem conteúdo sensível; limite de tentativas | ✅ |
| **Controle de teclado e mouse** | ⛔ Não implementado (exige injeção de entrada no sistema; ver [proposta](docs/ARQUITETURA.md#controle-remoto)) |
| **Acesso não assistido** | ⛔ Não implementado, de propósito ([proposta](docs/ARQUITETURA.md#acesso-não-assistido)) |
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

64 testes unitários e de integração (servidor real + WebSocket): permissões, consentimento,
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

8 etapas no **app Electron real**: duas janelas, seletor de tela, isolamento de segurança,
Ajustes. Com `PONTE_EXECUTABLE=dist/linux-unpacked/ponte` testa o executável empacotado.
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

- **Controle remoto e acesso não assistido** não existem nesta versão. A permissão de controle
  aparece como "indisponível" em vez de simular.
- **Identidade de quem presta suporte não é verificada**: o nome é informado pela própria pessoa
  (a interface avisa). Contas autenticadas são o próximo passo para uso real.
- **Instaladores sem assinatura digital**: Windows e macOS exibem avisos de segurança.
- **Conectar computadores diferentes exige servidor com HTTPS**; redes com NAT restritivo exigem
  também um servidor TURN.
- **Estado do servidor em memória**: reiniciar encerra as sessões.
- **Gravação** fica no dispositivo de quem presta suporte; um cliente modificado poderia gravar sem
  avisar (como qualquer pessoa pode filmar a tela que vê).
- **Validação de arquivos** reduz riscos, mas não substitui antivírus.
- Antes de uso público: revisão de LGPD (o log de auditoria guarda IPs) e teste de intrusão.

## Licença

MIT — veja [LICENSE](LICENSE).
