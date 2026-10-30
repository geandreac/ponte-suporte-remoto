# Implantação

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `HOST` | `127.0.0.1` | Interface de escuta. Use `0.0.0.0` só com TLS ou atrás de proxy HTTPS |
| `PORT` | `8080` | Porta |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | — | Certificado e chave para HTTPS/WSS direto |
| `TRUST_PROXY` | — | `1` para usar `X-Forwarded-For` (apenas atrás de proxy confiável) |
| `ALLOWED_ORIGINS` | mesmo host | Lista de origens aceitas no WebSocket, separadas por vírgula |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | STUN; vazio desativa |
| `TURN_URLS` | — | Ex.: `turn:turn.exemplo.com:3478?transport=udp,turns:turn.exemplo.com:5349` |
| `TURN_SECRET` | — | Mesmo valor de `static-auth-secret` do coturn |
| `ICE_TRANSPORT_POLICY` | `all` | `relay` força TURN (esconde IPs entre os participantes) |
| `AUDIT_LOG_FILE` | stdout | Arquivo do log de auditoria (criado com permissão 600) |
| `INVITE_TTL_SECONDS`, `JOIN_REQUEST_TTL_SECONDS`, `RECONNECT_GRACE_SECONDS`, `MAX_SESSION_MINUTES`, `MAX_FAILED_ATTEMPTS` | 600, 120, 30, 240, 5 | Prazos e limites |

## Rede local (sem servidor)

O app de computador conecta máquinas no mesmo Wi-Fi/roteador sem nenhum servidor. Requisitos:
- Firewall: permitir o Ponte em redes **privadas** (o Windows pergunta na 1ª vez). Portas usadas
  só durante convites/sessões: **UDP 47800** (descoberta) e uma porta TCP aleatória (TLS).
- O roteador não pode isolar os clientes do Wi-Fi (comum em redes de visitantes).

## Servidor gratuito no Render (recomendado para começar)

O arquivo `render.yaml` na raiz descreve o serviço (Docker, plano gratuito, verificação em
`/healthz`, `TRUST_PROXY=1`). Use o botão **Deploy to Render** do README ou, no painel do Render,
**New › Blueprint** apontando para este repositório. O Render fornece HTTPS e define `PORT`.

Comportamento do plano gratuito (confirme os termos atuais em render.com/free):
- Dorme após 15 minutos sem tráfego HTTP **ou mensagens WebSocket**; acordar leva ~1 minuto.
  O app espera até 75 s mostrando "Acordando o servidor…".
- Enquanto conectado, o app envia `keepalive` a cada 4 minutos, o que mantém o serviço ativo.
- O serviço pode reiniciar: como o estado das sessões fica em memória, sessões em andamento caem
  e o app informa; basta conectar de novo.
- Os logs do Render recebem o log de auditoria (eventos e IPs; nunca códigos, tokens ou conteúdo).

Se a rede do trabalho bloquear a conexão direta entre os computadores, configure TURN (abaixo).

## Docker

```bash
docker build -t ponte-servidor .
```

```bash
docker run -d --name ponte -p 127.0.0.1:8080:8080 -e ALLOWED_ORIGINS=https://suporte.exemplo.com ponte-servidor
```

A imagem já usa `HOST=0.0.0.0` e `TRUST_PROXY=1`; publique a porta só para o proxy com HTTPS.
O app de computador (origem `ponte://app`) é sempre aceito; `ALLOWED_ORIGINS` controla os sites.

## HTTPS

Navegadores só permitem compartilhar a tela em contexto seguro (HTTPS ou `localhost`).
Recomendado: proxy reverso com certificado (Caddy, Nginx) repassando `/` e `/ws`:

```
suporte.exemplo.com {
  reverse_proxy 127.0.0.1:8080
}
```

```bash
HOST=127.0.0.1 TRUST_PROXY=1 ALLOWED_ORIGINS=https://suporte.exemplo.com npm start
```

## TURN (coturn)

Sem TURN, pares atrás de NAT simétrico ou firewall corporativo não se conectam. Exemplo de
`turnserver.conf`:

```
listening-port=3478
tls-listening-port=5349
use-auth-secret
static-auth-secret=TROQUE_POR_UM_SEGREDO_LONGO
realm=suporte.exemplo.com
cert=/etc/ssl/turn.pem
pkey=/etc/ssl/turn.key
no-cli
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

```bash
TURN_URLS="turn:turn.exemplo.com:3478,turns:turn.exemplo.com:5349" TURN_SECRET=... npm start
```

O servidor da Ponte emite credenciais temporárias (padrão TURN REST API) só para participantes
aprovados; o segredo nunca vai ao navegador. O tráfego via TURN continua cifrado ponta a ponta.

## Checklist antes de uso real

- [ ] HTTPS ativo e `ALLOWED_ORIGINS` configurado
- [ ] TURN próprio configurado e testado entre redes diferentes
- [ ] Log de auditoria em arquivo com retenção definida (contém IPs)
- [ ] Termos de uso e aviso de privacidade (LGPD)
- [ ] Autenticação de técnicos (não implementada no MVP)
- [ ] Teste de intrusão
