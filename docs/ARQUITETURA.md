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

## Controle remoto (agente nativo)

**Por que não está na web:** navegadores não expõem API para gerar eventos de teclado/mouse no
sistema operacional — por segurança. Qualquer "controle" só via web seria simulado.

**O que já está pronto para isso:** a mensagem `input` (coordenadas normalizadas 0–1, teclas,
botões) é validada em `shared/protocol.js`; a permissão `control` exige a capacidade
`inputInjection` declarada pelo dispositivo; o anfitrião descarta `input` sem permissão.

**Proposta:** um agente desktop (ex.: Electron ou Tauri) que reusa este cliente, declara
`inputInjection: true` e injeta eventos pelo SO (SendInput no Windows, CGEvent no macOS com
permissão de Acessibilidade, XTest/uinput no Linux). Requisitos: consentimento explícito antes de
cada sessão de controle, atalho global para revogar, indicador sempre visível, e bloqueio de
sequências críticas (ex.: Ctrl+Alt+Del) por padrão.

## Acesso não assistido

**Não implementado**, de propósito. Exige o agente nativo (o navegador sempre pede para escolher a
tela e precisa de alguém presente). Proposta mínima segura:

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
4. Agente nativo para controle remoto e, depois, acesso não assistido.
5. Revisão jurídica (LGPD), política de retenção do log de auditoria e teste de intrusão.
