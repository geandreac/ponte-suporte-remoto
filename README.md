# Ponte · Suporte remoto assistido

Aplicação web para uma pessoa **compartilhar a tela com quem vai ajudá-la**, com convite de uso
único, aprovação explícita, permissões separadas por recurso e criptografia ponta a ponta (WebRTC).

> **Status: protótipo funcional (MVP), não pronto para produção.** O fluxo principal funciona de
> verdade entre dois navegadores e está coberto por testes, mas faltam itens listados em
> [Limitações](#limitações) — em especial controle remoto, acesso não assistido, autenticação de
> técnicos e um servidor TURN para redes restritivas.

## O que funciona hoje

| Recurso | Situação |
|---|---|
| Convite com ID de 9 dígitos + código de 8 caracteres, uso único, expira em 10 min | ✅ Implementado |
| Pedido de conexão mostrando nome do solicitante e permissões pedidas; aprovação/recusa | ✅ Implementado |
| Permissões separadas: ver tela, controle, arquivos, chat, gravação (tudo negado por padrão) | ✅ Implementado |
| Alterar/revogar permissões durante a sessão, "Revogar todas", pedido de mais permissões | ✅ Implementado |
| Compartilhamento de tela via WebRTC (DTLS-SRTP, ponta a ponta) | ✅ Implementado |
| Pausar/retomar, encerrar na hora, faixa permanente "sua tela está sendo compartilhada" | ✅ Implementado |
| Código de verificação (compara impressões digitais DTLS contra intermediário) | ✅ Implementado |
| Chat pelo canal de dados cifrado | ✅ Implementado |
| Arquivos: confirmação dos dois lados, lista de tipos, 25 MB, assinatura e SHA-256 | ✅ Implementado |
| Gravação local opcional, com consentimento e indicador contínuo para os dois lados | ✅ Implementado |
| Estados de conexão, reconexão automática (sinalização e ICE) e falha | ✅ Implementado |
| Histórico local de sessões + log de auditoria no servidor sem conteúdo sensível | ✅ Implementado |
| Limite de tentativas por IP e bloqueio da sessão após 5 códigos errados | ✅ Implementado |
| **Controle de teclado e mouse** | ⛔ Impossível só com navegador — requer agente nativo ([proposta](docs/ARQUITETURA.md#controle-remoto-agente-nativo)) |
| **Acesso não assistido** | ⛔ Não implementado — requer agente nativo ([proposta](docs/ARQUITETURA.md#acesso-não-assistido)) |
| TURN para redes com NAT restritivo | 🔧 Suportado, depende de servidor externo ([implantação](docs/IMPLANTACAO.md)) |

## Como rodar

Requisitos: Node.js 20+.

```bash
npm install
```

```bash
npm start
```

Abra `http://localhost:8080` em **duas abas ou dois navegadores**: em um clique em
"Gerar convite"; no outro preencha "Prestar suporte" com o ID e o código.

Por padrão o servidor escuta **apenas em 127.0.0.1** (não fica exposto na rede). Para usar entre
computadores diferentes é preciso HTTPS — veja [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md).

> No celular, navegadores não permitem compartilhar a tela (`getDisplayMedia` não existe no
> iOS/Android). O celular funciona bem como lado **técnico** (ver a tela, chat, arquivos) e o
> anfitrião no celular consegue usar chat e arquivos.

## Testes

```bash
npm test
```

60 testes unitários e de integração (servidor real + clientes WebSocket): permissões, consentimento,
expiração de convites e pedidos, bloqueio por tentativas, retomada, encerramento, validação de
protocolo, log sem segredos, TURN, arquivos (aceite, recusa, hash, tipos, revogação no meio).

```bash
npm run test:e2e
```

Teste ponta a ponta com **dois Chromium reais** conectados por WebRTC (17 etapas: recusa, código
errado, aprovação, vídeo, verificação, chat, arquivos, pausa, gravação, revogações, encerramento,
histórico e queda da sinalização). Requer Playwright com Chromium; capturas em `e2e/output/`.

```bash
npm run check
```

Checagem de sintaxe de todos os módulos.

## Estrutura

```
server/   sinalização WebSocket, sessões, limites, auditoria, ICE/TURN, arquivos estáticos
shared/   regras usadas pelos dois lados: permissões, protocolo, estados, arquivos, verificação
public/   interface (HTML/CSS) e cliente: sinalização, WebRTC, sessão, arquivos, gravação
test/     testes node:test        e2e/   teste com navegadores reais        docs/   arquitetura e implantação
```

Detalhes de projeto e segurança: [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

## Limitações

- **Controle remoto e acesso não assistido** não existem na versão web (o navegador não permite
  injetar teclado/mouse no sistema nem capturar a tela sem a pessoa presente). A permissão aparece
  como "indisponível" em vez de simular.
- **Identidade do técnico não é verificada**: o nome é informado pela própria pessoa (a interface
  avisa isso). Contas autenticadas para técnicos são o próximo passo para uso real.
- **Sem TURN configurado**, conexões entre redes com NAT simétrico/firewall podem falhar.
- **Estado em memória**: reiniciar o servidor encerra as sessões; não escala horizontalmente sem
  um armazenamento compartilhado (ex.: Redis).
- **Gravação** fica no dispositivo do técnico; a aplicação não oferece armazenamento protegido
  centralizado. Um cliente modificado também poderia gravar sem avisar (como qualquer pessoa pode
  filmar a tela que vê); a permissão vale para o cliente oficial e o anfitrião encerra a sessão se
  detectar gravação não autorizada.
- **Validação de arquivos** reduz riscos, mas não substitui antivírus.
- Antes de disponibilizar publicamente, revise LGPD/consentimento (termos, retenção do log de
  auditoria que guarda IP, base legal) e faça um teste de intrusão.
