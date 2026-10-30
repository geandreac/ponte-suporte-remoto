# Arquitetura e segurança

## Visão geral

```
 Anfitrião (navegador)                Servidor de sinalização               Técnico (navegador)
 ┌──────────────────┐   WSS: convite,   ┌─────────────────────┐   WSS    ┌──────────────────┐
 │ HostController   │◄─ aprovação, ────►│ SessionStore        │◄────────►│ ViewerController │
 │  getDisplayMedia │   SDP/ICE         │ RateLimiter, Audit  │          │  vídeo, gravação │
 └────────┬─────────┘                   └─────────────────────┘          └────────┬─────────┘
          │        WebRTC (DTLS-SRTP + SCTP): vídeo, chat, arquivos — ponta a ponta│
          └──────────────────── direto ou via TURN (ainda cifrado) ────────────────┘
```

- O servidor **nunca vê** tela, chat ou arquivos. Ele só pareia os dois lados e repassa SDP/ICE
  depois da aprovação.
- **Quem compartilha é a autoridade das permissões.** Como os dados vão direto entre navegadores,
  o lado do anfitrião descarta toda mensagem não liberada (`authorizeIncoming`) e para de enviar
  vídeo no instante da revogação (`replaceTrack(null)`), sem esperar o servidor.
- O anfitrião sempre faz a oferta e o técnico só responde: sem colisões de negociação. O vídeo
  usa um transceiver `sendonly` criado no início, então pausar/retomar/revogar não renegocia.

## App de computador (Electron)

- A interface é a mesma da web, servida pelo protocolo próprio `ponte://app` (marcado como seguro).
  Janelas com `contextIsolation`, `sandbox` e sem Node na página; o `preload` expõe só 8 funções
  com argumentos convertidos para texto. Navegação externa, `window.open` e `<webview>` bloqueados.
- Permissões do Chromium liberadas apenas para a origem do app: captura de tela, escrita na área de
  transferência e tela cheia. Câmera, microfone etc. negados.
- Captura de tela: `setDisplayMediaRequestHandler` lista telas e janelas reais
  (`desktopCapturer`) e a pessoa escolhe no seletor do app; no macOS 15+ usa o seletor do sistema.
  Cancelar não compartilha nada.
- Modo "neste computador": servidor de sinalização embutido em `127.0.0.1` (porta aleatória).
  Modo "servidor da organização": endereço HTTPS em Ajustes, convertido para `wss://…/ws`; a CSP da
  página libera conexão só para esse endereço. O servidor aceita a origem `ponte://app`.
- Os instaladores são gerados por `electron-builder` (`npm run dist`) e pelo workflow
  `.github/workflows/release.yml` (Windows, macOS e Linux).

## Camadas

| Camada | Arquivos | Responsabilidade |
|---|---|---|
| Regras compartilhadas | `shared/permissions.js`, `protocol.js`, `session-machine.js`, `file-policy.js`, `verification.js` | Puras e testáveis; mesmas regras no servidor e no cliente |
| Servidor | `server/session-store.js` (estado, sem rede), `signaling.js` (WebSocket), `rate-limiter.js`, `audit-log.js`, `ice.js`, `app.js` | Convite, consentimento, prazos, pareamento |
| Comunicação (cliente) | `public/js/signaling-client.js`, `peer-link.js`, `file-transfer.js`, `recorder.js` | WebSocket com retomada, WebRTC, arquivos |
| Lógica de sessão | `public/js/session-controller.js` | Estados, aplicação de permissões; sem DOM |
| Interface | `public/index.html`, `css/app.css`, `js/main.js`, `ui.js`, `messages.js` | Renderização e acessibilidade |

## Fluxo de convite e consentimento

1. Anfitrião pede `host:create` → servidor gera ID (9 dígitos), código (8 caracteres sem ambíguos,
   ~40 bits) e token de anfitrião. **Só hashes SHA-256** ficam guardados.
2. Técnico envia `tech:join` com ID, código, nome e permissões pedidas. Código errado conta
   tentativa; na 5ª a sessão é destruída e o anfitrião avisado. ID inexistente/expirado responde
   igual a código errado (não permite descobrir IDs válidos). Limite por IP: 10 tentativas, +1 a cada 30 s.
3. Anfitrião vê nome (marcado como **não verificado**), permissões pedidas, aviso contra golpes e
   prazo do pedido (2 min). Só "Ver a tela" vem marcado; o resto é opt-in.
4. Ao aceitar com "Ver a tela", o navegador pede a escolha da tela **antes** de liberar a entrada.
5. Servidor invalida o código (uso único), emite token do técnico e credenciais ICE/TURN
   temporárias **apenas para participantes aprovados**.

## Prazos

| Item | Padrão | Variável |
|---|---|---|
| Convite sem uso | 10 min | `INVITE_TTL_SECONDS` |
| Pedido sem resposta | 2 min | `JOIN_REQUEST_TTL_SECONDS` |
| Reconexão (sinalização ou ICE) | 30 s | `RECONNECT_GRACE_SECONDS` |
| Duração máxima da sessão | 4 h | `MAX_SESSION_MINUTES` |
| Credencial TURN | 1 h | `TURN_TTL_SECONDS` |

## Medidas de segurança implementadas

- WSS/HTTPS (TLS direto ou proxy), HSTS quando TLS; servidor só em `127.0.0.1` por padrão.
- Checagem de `Origin` no WebSocket; `maxPayload` de 64 KB; limite de mensagens por conexão.
- Validação estrita de todas as mensagens (servidor e canal de dados); nomes sem caracteres de
  controle/direção (evita nomes que se disfarçam); permissões aceitam só `true` literal em
  propriedades próprias (teste pegou um caso de `__proto__`).
- CSP sem `unsafe-inline`, `frame-ancestors 'none'`, `Permissions-Policy` limitando câmera,
  microfone e captura; toda entrada externa vai para o DOM via `textContent`.
- Comparação de hashes em tempo constante; tokens de 256 bits.
- Log de auditoria em JSON por linha que mascara chaves sensíveis (`secret`, `token`, `sdp`,
  `candidate`, `text`, `data`…) — coberto por teste.
- Código de verificação de 8 dígitos derivado das impressões digitais DTLS dos dois lados: se
  os dois veem o mesmo número, não há intermediário na sinalização. É uma checagem leve, não um
  protocolo formal de SAS com compromisso (ZRTP).
- Arquivos: lista de tipos, 25 MB, MIME coerente, assinatura do conteúdo, SHA-256, aceite
  explícito, blocos fora de transferência aceita descartados, revalidação no lado que recebe.

## Rede local (modo padrão do app)

1. Ao gerar o convite, o app abre (só enquanto houver convite/sessão dele) um servidor de
   sinalização **TLS** em `0.0.0.0` com certificado próprio (gerado no 1º uso, chave `0600`) e um
   respondedor **UDP 47800**.
2. Quem presta suporte envia em broadcast (ou direto a um endereço) `{id, nonce}`. O código **não
   trafega**.
3. Só o computador com aquele convite responde `{porta, impressão digital do certificado, mac}`,
   onde `mac = HMAC-SHA256(scrypt(código, id), id|nonce|porta|impressão)`. Quem pede verifica com
   o código que tem: resposta forjada (sem o código) é descartada; o nonce impede reaproveitar
   respostas; o scrypt (N=2^15) torna inviável descobrir o código escutando a rede no prazo do convite.
4. A conexão `wss://` é aceita só se o certificado for exatamente o anunciado (pinning via
   `setCertificateVerifyProc`). Depois disso, o fluxo é o mesmo: pedido, aprovação, WebRTC.
5. Após o convite ser usado, o computador deixa de responder buscas; ao fim da sessão, fecha as portas.

## Controle remoto

- **Onde:** só no app de computador, via `@jitsi/robotjs` (N-API, binários prontos para Windows,
  macOS e Linux X11). Na web e no Wayland, a capacidade `inputInjection` é falsa e a permissão
  aparece como indisponível.
- **Quando fica ativo:** permissão `control` concedida **e** tela inteira compartilhada (não janela:
  sem mapeamento seguro de coordenadas) **e** compartilhamento não pausado **e** sessão conectada.
  O anfitrião avisa o técnico (`share-state.controlActive`), que só então envia eventos.
- **Consentimento:** desligado por padrão; ligar durante a sessão abre confirmação explícita.
- **Visibilidade e revogação:** faixa vermelha sempre por cima de tudo ("X está controlando este
  computador · Parar controle") e atalho global `Ctrl/⌘+Alt+Shift+X`. Revogar desliga a injeção
  no processo principal imediatamente e solta botões presos.
- **Validação em camadas:** técnico → protocolo (`validateDataMessage`) → anfitrião (permissão e
  estado) → processo principal (valida de novo, só aceita eventos da janela dona do controle).
- **Teclado:** texto é digitado pelo caractere (funciona com ABNT2/AltGr); atalhos (Ctrl+C,
  Alt+Tab, setas, F1–F12) usam a tecla física com modificadores. Ctrl+Alt+Del não pode ser
  injetado (proteção do Windows).
- **Mouse:** coordenadas 0–1 da imagem (descontando faixas pretas) → pixels da tela compartilhada,
  com conversão de pontos lógicos para físicos em telas com escala (Windows/Linux).

## Atualização automática

`electron-updater` com o provedor GitHub: o app lê `latest*.yml` da última Release (publicada pelo
workflow junto com os instaladores), baixa e confere o **SHA-512**. Windows (NSIS) e AppImage
instalam ao fechar ou pelo botão "Reiniciar e atualizar" (bloqueado durante sessões). macOS (sem
assinatura), Windows portátil e .deb só avisam e abrem a página da Release. Pode ser desligada em
Ajustes. Limitação: sem assinatura de código, a confiança se apoia na Release do GitHub (HTTPS +
SHA-512); quem controlar a conta do repositório consegue publicar uma atualização.

## Acesso não assistido

**Não implementado**, de propósito. Exigiria o app de computador rodando em segundo plano, com
captura sem confirmação a cada sessão. Proposta mínima segura:

1. Desativado por padrão; ativado só pelo dono do dispositivo, localmente, com reautenticação.
2. Dispositivo registra um par de chaves (privada no cofre do SO: DPAPI/Keychain/libsecret).
3. Técnicos autenticados com conta + 2FA/passkey; o dono autoriza técnicos específicos.
4. Nenhuma senha em texto puro: se houver senha de acesso, guardar com Argon2id e limitar tentativas.
5. Notificação local ao iniciar, log de cada acesso, lista de autorizados com revogação imediata
   e prazo de validade para cada autorização.

## Próximos passos recomendados

1. Autenticação de técnicos (contas, OIDC/passkeys) e exibir identidade verificada na aprovação.
2. TURN próprio (coturn) com `use-auth-secret` — já suportado pelo servidor.
3. Persistência compartilhada (Redis) para múltiplas instâncias e reinícios sem derrubar sessões.
4. Acesso não assistido (com as salvaguardas acima).
5. Assinatura digital dos instaladores (Apple Developer ID + notarização; certificado Authenticode).
6. Revisão jurídica (LGPD), política de retenção do log de auditoria e teste de intrusão.
