# Migração do servidor para a Oracle Cloud Free + acesso sem supervisão

Documento de trabalho da versão **0.3.0**. Cada etapa traz o que foi decidido e como foi validado.
Itens marcados **[você]** dependem da sua conta na Oracle; o resto já está no repositório.

---

## 1. Avaliação: estado atual e plataforma nova

### Estado antes da migração (0.2.4)

| Item | Situação |
|---|---|
| Servidor de conexão | Node.js (WebSocket). Só faz a sinalização: tela, teclado/mouse e arquivos vão direto entre os computadores (WebRTC, cifrado ponta a ponta). Estado em memória. |
| Onde roda | Embutido no app (só `127.0.0.1`, para rede local) ou em servidor próprio com HTTPS. Havia `render.yaml` para o Render gratuito, que **dorme** após 15 min sem uso. |
| TURN (retransmissão) | Suportado no código (credenciais temporárias), mas **sem servidor** configurado: redes corporativas que bloqueiam conexão direta falhavam. |
| Acesso sem supervisão | Só especificado; não implementado. |

### Plataforma nova: Oracle Cloud "Always Free"

| Característica | Impacto para o Ponte |
|---|---|
| VM sempre ligada (não "dorme") | O computador de casa fica registrado 24 h; acessar não depende de "acordar" o servidor. |
| ARM Ampere A1 (até 2 OCPU / 12 GB em 2026) ou 2 VMs AMD micro (1 GB) | Sobra para sinalização + TURN. Imagens usadas (`node:22-alpine`, `caddy:2.11-alpine`, `coturn:4.18-alpine`) têm versão ARM. |
| ~10 TB/mês de tráfego de saída | Permite hospedar o **TURN próprio** (o tráfego retransmitido continua cifrado). |
| IP público fixo (reservado) | Domínio estável para o app. |
| Firewall duplo (Security List + iptables da imagem Ubuntu) | Precisa abrir portas nos dois lugares (o `install.sh` cuida do iptables). |
| Exige cartão para verificação; VMs ociosas podem ser recuperadas | Ver desafios (seção 5). |

Fontes consultadas: [Always Free Resources (Oracle)](https://docs.oracle.com/iaas/Content/FreeTier/resourceref.htm), ociosidade e conversão para PAYG ([51sec](https://blog.51sec.org/2023/02/oracle-cloud-cleaning-up-idle-compute.html)), limites do Always Free em 2026 ([Site2US](https://site2us.com/en/servers/oracle-cloud-free-tier), [unixgaming](https://unixgaming.org/oracle-cloud-free-tier-vs-aws-gcp-game-servers-2026/)) e liberação de portas em imagens Ubuntu da Oracle ([Oracle Developers](https://blogs.oracle.com/developers/post/enabling-network-traffic-to-ubuntu-images-in-oracle-cloud-infrastructure)).

---

## 2. Requisitos e restrições

**Funcionais**
- Acessar o computador **sem aprovação a cada sessão**, com **senha fixa por computador**.
- Funcionar **na rede interna** (sem servidor) **e pela internet** (servidor na Oracle).
- Manter o fluxo assistido (convite + aprovação) intacto.

**Segurança (obrigatórios)**: desativado por padrão; ativação só local e com confirmação explícita;
senha criada pela pessoa (sem padrão/mestra/compartilhada); nunca em texto puro; nunca em logs;
proteção contra força bruta; camada adicional; revogar/trocar/desativar a qualquer momento;
indicador visível e notificações; log de segurança sem dados sensíveis; nada oculto.

**Restrições técnicas**
- O servidor não pode conhecer a senha nem guardar segredos dos computadores (ele é público).
- Estado do servidor continua em memória: reiniciar derruba sessões, mas os computadores se
  registram de novo sozinhos (nada a migrar de dados).
- App de usuário comum: no Windows **não captura nem controla a tela bloqueada** (UAC/Ctrl+Alt+Del).
- Captura sem seletor exige que o app peça a tela sem gesto da pessoa: só liberado depois da senha.

---

## 3. Cronograma de implementação

| Fase | Entrega | Pré-requisitos | Situação |
|---|---|---|---|
| 0 | Avaliação, requisitos, este plano | — | ✅ |
| 1 | Arquivos de implantação Oracle (`deploy/oracle/`): Caddy (HTTPS automático), servidor, coturn (TURN), `install.sh` | — | ✅ validado localmente |
| 2 | Servidor: registro de computadores (chave Ed25519, ID derivado da chave) e sessão sem supervisão | Fase 0 | ✅ |
| 3 | App: cofre da senha (scrypt + cofre do sistema), bloqueios, log, dispositivos | Fase 2 | ✅ |
| 4 | App: presença na rede local e na internet, desafio-resposta, captura automática, bandeja, notificações, interface | Fases 2–3 | ✅ |
| 5 | Validação ponta a ponta (rede local e internet), pacote, publicação 0.3.0 | Fases 1–4 | ✅ |
| 6 | **[você]** Criar a VM na Oracle e rodar o `install.sh` | Conta Oracle, domínio | Pendente |
| 7 | **[você]** Configurar o endereço nos dois computadores e testar casa ↔ trabalho | Fase 6 | Pendente |

### Fase 6 — passo a passo na Oracle **[você]**

1. Crie a conta em cloud.oracle.com/free (pede cartão só para verificação).
2. **Compute › Instances › Create**: imagem **Ubuntu 24.04**, forma **VM.Standard.A1.Flex** (1 OCPU,
   6 GB basta). Guarde a chave SSH. Em **Networking**, use um **IP público reservado**.
3. **Networking › Virtual Cloud Networks › (sua VCN) › Security Lists › Default › Add Ingress Rules**
   (origem `0.0.0.0/0`): TCP **80, 443, 3478**; UDP **3478** e **49160-49200**.
4. Domínio gratuito: crie um subdomínio em duckdns.org apontando para o IP público da VM
   (ou use um domínio seu).
5. Na VM (via SSH):

   ```bash
   sudo apt-get update && sudo apt-get install -y git
   ```

   ```bash
   git clone https://github.com/geandreac/ponte-suporte-remoto.git && cd ponte-suporte-remoto/deploy/oracle
   ```

   ```bash
   sudo PONTE_DOMAIN=seu-nome.duckdns.org ACME_EMAIL=seu-email@exemplo.com ./install.sh
   ```

6. Teste: `curl https://seu-nome.duckdns.org/healthz` deve responder `ok`.

O `install.sh` instala Docker, libera as portas no iptables da imagem (e salva), **gera o segredo do
TURN na própria VM** (`.env` com permissão 600, nunca no repositório) e sobe Caddy + servidor + coturn.

### Fase 7 — nos computadores **[você]**

1. Atualize os dois para a **0.3.0** (atualização automática).
2. Nos dois: **Ajustes › Servidor da organização** → `https://seu-nome.duckdns.org` → **Salvar e reiniciar**.
3. No PC de casa: **Ajustes › Acessar computador sem supervisão › Configurar…** (veja a seção 4).
4. No notebook: **Prestar suporte › Sem supervisão** → ID do PC de casa + senha → **Conectar**.
   Em casa (mesmo Wi-Fi) a conexão vai pela rede local; fora, pelo servidor da Oracle.

---

## 4. Senha fixa por computador — como foi implementada

### No computador que será acessado (proprietário)

1. **Ativação local e deliberada.** Ajustes › *Acessar computador sem supervisão* › *Configurar…*.
   O diálogo explica que "conexões futuras poderão entrar sem que alguém aprove cada sessão" e só
   ativa com a caixa de confirmação marcada. O processo principal **recusa** ativar, trocar a senha,
   ampliar permissões ou desbloquear **enquanto houver qualquer sessão** — ninguém consegue ligar o
   recurso controlando o computador remotamente.
2. **Senha criada pela pessoa**, só para este computador, com regras (12+ caracteres, variedade ou
   frase de 16+, sem sequências óbvias, sem senhas comuns) e o aviso para **não reutilizar** senhas.
3. **Armazenamento.** A senha nunca é guardada. Guarda-se `K = scrypt(senha, salt aleatório de 16
   bytes, N=2^17, r=8, p=1)` (≈350 ms e 128 MB por tentativa, medido), com os parâmetros
   versionados, num arquivo cifrado pelo **cofre do sistema** (DPAPI/Keychain/libsecret) e com
   permissão `600`. Sem cofre disponível, a interface avisa.
4. **Identidade do computador.** Na ativação, gera-se um par de chaves **Ed25519**; o **ID de 9 dígitos
   deriva da chave pública**. Ao se registrar no servidor, o computador assina um desafio único da
   conexão: ninguém consegue se registrar com o ID de outro computador.
5. **Disponibilidade.** Enquanto ativado, o computador fica registrado no servidor embutido (alcançado
   pela rede local via TLS próprio + descoberta UDP) e, se configurado, no servidor da Oracle.

### Na conexão (técnico → computador)

1. O técnico informa ID, senha e nome. O app procura o computador **na rede local** (UDP); se não
   achar, usa o **servidor da internet**.
2. O servidor cria a sessão **sem nenhuma permissão** e avisa o computador, que abre uma janela e
   estabelece a conexão WebRTC cifrada — nada da tela é enviado ainda.
3. **Desafio-resposta dentro do canal cifrado:** o computador envia `{salt, parâmetros, nonce}`; o
   técnico calcula `HMAC(K, ID | nonce | ID do dispositivo | impressões digitais DTLS das duas pontas)`.
   - **A senha não trafega** (nem cifrada).
   - Amarrar as impressões digitais impede que um servidor ou alguém na rede se coloque no meio.
   - O desafio é de **uso único** e expira em 60 s.
4. O computador verifica (em tempo constante) e aplica **atraso progressivo** (1, 2, 4… até 60 s por
   dispositivo), **bloqueio de 15 min** após 5 falhas seguidas e **bloqueio até desbloqueio local**
   após 20 falhas em 24 h.
5. Com a senha correta, libera **só** as permissões que o proprietário definiu (∩ as pedidas), captura
   a tela principal sem seletor (liberado pelo processo principal apenas nesse caso), mostra o aviso
   vermelho e envia **notificação do sistema** de início; ao fim, notificação de término.

### Camada adicional, revogação e indicadores

- **Dispositivos autorizados**: cada técnico tem um ID de dispositivo; o 1º acesso com a senha correta
  o registra. Desligando **"Aceitar novos dispositivos"**, só os autorizados podem tentar a senha.
- **Revogar acesso** encerra na hora a sessão desse dispositivo. **Trocar senha** remove todos os
  dispositivos. **Desativar** apaga a senha e as chaves.
- Indicadores: "Sem supervisão: ativado" na barra lateral, ícone na área de notificação com o ID,
  aviso vermelho durante o controle, notificações de início/fim.
- **Registro de segurança** (`security-log.jsonl`, permissão 600): ativação, autenticações, falhas,
  bloqueios, revogações, trocas de senha — sem senha, chaves, tela ou arquivos.

---

## 5. Desafios e soluções

| Desafio | Solução |
|---|---|
| A Oracle pode parar VMs Always Free **ociosas** (uso baixo de CPU por 7 dias; o limite varia entre 10% e 20% conforme a versão da documentação) — o Ponte usa pouco | Converter a conta para **Pay As You Go**: a Oracle informa que isso evita a parada e que não há cobrança dentro dos limites Always Free (há relatos de uma autorização temporária no cartão na conversão). Uma VM parada pode ser religada. Alternativa: acompanhar os e-mails de aviso da Oracle. |
| Firewall duplo (Security List + iptables da imagem) | Passo 3 da Fase 6 + `install.sh` abre e salva as regras do iptables antes do `REJECT`. |
| Domínio e HTTPS sem custo | Subdomínio DuckDNS + Caddy com Let's Encrypt automático (renovação incluída). |
| Redes do trabalho que bloqueiam conexão direta | **coturn** na própria VM (UDP/TCP 3478), credenciais temporárias por HMAC, sem retransmitir para redes internas (proteção contra uso indevido). Se a empresa bloquear a 3478, o próximo passo é TURN sobre TLS na 443 (exige um 2º IP ou multiplexação no Caddy). |
| Reinício do servidor derruba sessões (estado em memória) | Sessões caem com mensagem clara; o computador de casa **se registra de novo sozinho** (reconexão com espera progressiva). |
| Windows com tela bloqueada | Limitação informada: o PC precisa estar desbloqueado. Resolver exige serviço do sistema com privilégios — etapa própria de revisão de segurança. |
| Captura sem gesto da pessoa | Usada só na janela de uma sessão **já autenticada por senha**; o processo principal nega a permissão em qualquer outro caso. |
| Descoberta na rede local sem senha | A resposta UDP não prova nada; quem a falsificar não passa do desafio-resposta (amarrado às impressões digitais). Risco residual: quem intercepta uma prova pode tentar adivinhar a senha *offline* — mitigado pelo custo do scrypt e pela política de senha. Evolução: PAKE (OPAQUE). |
| Senha comprometida | Trocar a senha (remove todos os dispositivos) ou desativar; bloquear novos dispositivos. |

---

## 6. Conformidade com boas práticas de segurança

| Prática | Como está atendida |
|---|---|
| Menor privilégio | Sessão nasce sem permissões; libera só o que o proprietário permitiu ∩ o que foi pedido; gravação desligada por padrão. |
| Senhas | scrypt com salt e parâmetros versionados; cofre do sistema; nunca em texto, log, erro ou histórico; sem senha padrão/mestra; política de força. |
| Autenticação | Desafio-resposta com nonce de uso único, comparação em tempo constante, amarrado ao canal cifrado. |
| Força bruta | Limites por IP e por computador no servidor; atraso progressivo, bloqueio temporário e bloqueio permanente até ação local no computador. |
| Identidade do servidor/computador | HTTPS (Let's Encrypt) no servidor; ID derivado de chave Ed25519 com prova de posse; TLS com certificado fixado na rede local. |
| Criptografia em trânsito | WSS/HTTPS na sinalização; DTLS-SRTP ponta a ponta na mídia/dados; TURN não enxerga o conteúdo. |
| Segredos de infraestrutura | Segredo do TURN gerado na VM (`.env` 600, `turnserver.conf` 600 para o usuário do contêiner), fora do repositório. |
| Transparência | Desativado por padrão, ativação explícita, ícone e indicadores permanentes, notificações, início com o sistema só por opção visível. |
| Revogação efetiva | Revogar/desativar encerram sessões em andamento; o servidor aceita do computador um motivo de encerramento de uma lista fechada. |
| Logs | Auditoria do servidor e log de segurança local sem segredos, tela ou arquivos (testado). |

---

## Validação realizada (neste ambiente)

| Verificação | Resultado |
|---|---|
| Testes unitários e de integração (`npm test`) | **99/99** — inclui registro com assinatura, ID falsificado recusado, sessão sem permissões, motivos de encerramento, cofre/bloqueios/política de senha |
| Ponta a ponta web (`npm run test:e2e`) | **20/20** etapas (fluxo assistido sem regressões) |
| App real, rede local (`npm run test:desktop`) | **22/22** etapas, 3 rodadas estáveis + executável empacotado: ativação com confirmação, senha errada recusada (via UDP + TLS validado), senha certa sem aprovação, captura automática, controle ativo, troca de senha bloqueada durante sessão, revogação encerrando a sessão, novos dispositivos bloqueados, desativação |
| App real, internet (`npm run test:internet`) | **2/2**: duas instâncias independentes via servidor externo (papel da Oracle), busca local forçada a falhar; também com o executável empacotado |
| `Caddyfile` | `caddy validate`: configuração válida |
| coturn com a configuração gerada | Sobe; **credencial gerada pelo servidor do Ponte aceita** numa alocação TURN real; senha errada recusada; retransmissão para endereço interno bloqueada |
| `install.sh` | Sintaxe verificada (`bash -n`); **não executado numa VM Oracle real** (depende da sua conta) |
| scrypt de produção | ≈350 ms e 128 MB por tentativa |

**Não validado aqui:** a VM real na Oracle (rede, Let's Encrypt, Security List), conexões através de
redes corporativas reais, e o comportamento no Windows/macOS reais do acesso sem supervisão.
