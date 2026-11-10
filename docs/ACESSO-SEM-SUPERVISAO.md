# Acessar computador sem supervisão — especificação

> **Situação (0.3.0): implementado no app de computador**, na rede local e pela internet.
> Detalhes da implementação, implantação na Oracle e validação: [MIGRACAO-ORACLE.md](MIGRACAO-ORACLE.md).
>
> **Diferenças em relação ao plano abaixo:**
> - **TOTP (app autenticador) não foi implementado.** A camada adicional disponível é a lista de
>   **dispositivos autorizados** com a opção "Aceitar novos dispositivos" (desligada, só os já
>   autorizados podem tentar a senha).
> - Confirmação com Touch ID no macOS não foi implementada; a proteção é bloquear qualquer
>   mudança de segurança enquanto houver sessão.
> - O ID e a senha valem para conexões pela rede local (descoberta UDP + TLS com certificado fixado)
>   e pelo servidor da internet; a prova de senha é a mesma nos dois caminhos.
> - Na versão web (navegador) só existe o fluxo assistido.

## Objetivo

Permitir que o **proprietário** configure o próprio computador (ex.: o de casa) para aceitar
conexões autorizadas sem aprovar cada sessão, com segurança equivalente ou superior ao fluxo
assistido.

## Requisitos e como serão atendidos

| Requisito | Solução planejada |
|---|---|
| Desativado por padrão | Opção em **Ajustes › Acessar computador sem supervisão**, desligada em toda instalação. |
| Só habilitar com acesso local/autenticado | Ativar, trocar senha, autorizar dispositivos e reativar ficam **bloqueados enquanto houver qualquer sessão remota** (ninguém consegue ligar o recurso controlando o computador). No macOS, confirmação adicional com Touch ID/senha do sistema quando disponível. |
| Explicar e pedir confirmação explícita | Tela de configuração em etapas: o que o recurso faz ("conexões futuras sem aprovação a cada sessão"), riscos, requisitos; caixa "Entendo e quero ativar" + botão destrutivo "Ativar acesso sem supervisão". |
| Senha dedicada, sem reutilização | Campo próprio com mínimo de 12 caracteres, verificação contra senhas comuns e aviso explícito para **não reutilizar** senhas de outras contas ou dispositivos. |
| Sem senha padrão/compartilhada/gerada pelo sistema | A senha é sempre criada pela pessoa; não existe valor inicial, senha mestra nem senha comum a várias instalações. |
| Nunca guardar em texto puro | Guarda só o resultado de **scrypt** (N=2^17, r=8, p=1, chave de 32 bytes) com **salt aleatório de 16 bytes** por computador, parâmetros versionados, cifrado ainda pelo cofre do sistema (`safeStorage`: DPAPI no Windows, Keychain no macOS, libsecret no Linux). |
| Credenciais só por canal protegido, nunca em logs | A senha **não trafega**: o técnico prova que a conhece por desafio-resposta (abaixo) dentro do canal WebRTC cifrado. Logs, erros e histórico registram apenas "senha incorreta", nunca o valor. |
| Força bruta | No computador de casa, por dispositivo e no total: atraso progressivo (1, 2, 4, 8, 16 s…), bloqueio temporário de 15 min após 5 falhas, bloqueio até ação local após 20 falhas no dia. No servidor: limite por IP e por dispositivo. |
| Camada adicional | **Dispositivos autorizados**: cada computador do técnico tem um par de chaves próprio; só dispositivos aprovados podem tentar a senha. A 1ª aprovação exige **código TOTP** (app autenticador configurado na ativação). Opcional, mas recomendado: TOTP em todo acesso. |
| Ver, revogar, trocar senha, desativar | Ajustes listam dispositivos autorizados (nome, data, último acesso). "Revogar acesso" encerra na hora qualquer sessão desse dispositivo. Trocar a senha ou desativar invalida todos os dispositivos e sessões. |
| Indicador visível e notificações | Ícone permanente na área de notificação ("Acesso sem supervisão ativado"), faixa em Ajustes e no início do app. Notificação do sistema ao **iniciar** e **terminar** cada sessão, além do aviso vermelho de controle já existente. |
| Registro de eventos essenciais | Log de segurança local: ativação/desativação, autenticações (sucesso/falha, dispositivo, IP aproximado), bloqueios, revogações, troca de senha. Sem senhas, tela ou arquivos. |
| Nada oculto | Início automático só pela opção visível do sistema ("Iniciar com o computador"), ícone sempre visível, sem contornar avisos ou permissões do sistema operacional. |
| Senha vale só para aquele computador | Salt, chaves e lista de dispositivos são locais e únicos por computador; não existe credencial que abra vários dispositivos. |

## Autenticação sem enviar a senha

1. O computador de casa fica conectado ao servidor de conexão, identificado por um ID de
   dispositivo e uma chave pública (gerada localmente na ativação).
2. O técnico escolhe o computador e o servidor apenas aproxima os dois; a conexão WebRTC é
   estabelecida **antes** de qualquer acesso à tela ou ao controle (nada é compartilhado ainda).
3. O computador de casa envia `{salt, parâmetros, nonce}`. O técnico deriva
   `K = scrypt(senha, salt)` e responde `HMAC(K, nonce | impressões digitais DTLS dos dois lados | id do dispositivo)`.
   - Amarrar as impressões digitais impede que um servidor de sinalização malicioso se coloque no meio.
   - O nonce impede reaproveitar respostas.
4. Só com prova válida, dispositivo autorizado (e TOTP, se exigido) a sessão começa, com as
   **mesmas permissões e indicadores** do fluxo assistido. As permissões máximas são definidas pelo
   proprietário (ex.: sem gravação).
5. Melhoria futura: trocar o desafio-resposta por um PAKE (OPAQUE), que também protege contra
   ataque de dicionário por quem obtiver o arquivo protegido.

## Limitações de plataforma (serão informadas, não simuladas)

- **Windows**: o app roda como usuário comum. Com a **tela bloqueada**, ou em telas de UAC/Ctrl+Alt+Del,
  o Windows não deixa um app comum capturar nem controlar. O computador precisa estar ligado,
  **desbloqueado** e fora de suspensão. Suportar tela bloqueada exigiria um serviço do sistema
  instalado com privilégios de administrador, o que fica para uma etapa própria de revisão de segurança.
- **macOS**: exige que a pessoa conceda "Gravação de Tela" e "Acessibilidade" ao Ponte; sem isso
  o recurso aparece como indisponível. App sem assinatura pode perder essas permissões a cada atualização.
- **Linux**: só sessões X11; no Wayland o recurso fica indisponível.
- **Servidor**: precisa de um servidor de conexão sempre disponível (ex.: Render gratuito, que pode
  "dormir"; o computador de casa mantém a conexão com sinais periódicos).

## Etapas de implementação previstas

1. Armazenamento seguro (scrypt + `safeStorage`), tela de ativação, indicador e log local.
2. Registro do computador no servidor, lista de computadores do técnico, desafio-resposta.
3. Dispositivos autorizados + TOTP, bloqueios progressivos, revogação em sessões ativas.
4. Notificações do sistema, início automático visível, testes de segurança dedicados.
