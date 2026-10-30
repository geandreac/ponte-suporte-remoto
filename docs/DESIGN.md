# Diretrizes visuais aplicadas

A interface usa os sistemas Apple (macOS, iOS, iPadOS) como **referência de qualidade** —
clareza, hierarquia, consistência — sem copiar marca, ícones, telas ou elementos exclusivos.
Identidade própria: cor de destaque verde-azulada, ícones de traço próprio, logotipo da ponte.
Tudo está em `public/css/app.css` (tokens no topo) e `public/index.html`.

## 1. Princípios e organização

- **Uma tarefa principal por tela**: Receber suporte, Prestar suporte, Histórico, Ajustes, Sessão.
- **Durante uma sessão a navegação fica presa a ela** (outros itens desabilitados): evita sair por
  engano no meio do atendimento.
- Computador: **barra lateral** de navegação + **barra de ferramentas** por tela, com título à
  esquerda e ações contextuais à direita. Sessão: área principal (tela) + painel lateral (inspetor).
- Celular: a mesma navegação vira **barra de abas inferior**; títulos grandes; botões principais
  em largura total; o painel da sessão vai para baixo da tela compartilhada.
- Formulários em **listas agrupadas** por seção (Convite, Você, Acesso solicitado).

## 2. Espaçamento e dimensões

| Token | Valor | Uso |
|---|---|---|
| `--space-1…7` | 4, 8, 12, 16, 24, 32, 48 px | escala única para margens e espaços |
| `--control-h` | 36 px (mouse) / 44 px (toque) | botões, campos, abas |
| `--row-min-h` | 44 px / 48 px (toque) | linhas de lista |
| `--radius-s/m/l` | 6, 10, 14 px | controles, grupos, cartões |

Ações destrutivas ficam separadas das demais (ex.: "Encerrar sessão" na ponta da barra).

## 3. Tipografia

- Fonte do sistema com alternativas: `system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto, …`.
- Escala curta: título de tela (20 px; 28 px no celular), destaque (17 px), corpo (15 px),
  nota (13 px). Texto essencial nunca abaixo de 13 px.
- Tamanhos em `rem`: o zoom do navegador e do app (**Visualizar › Aumentar**) amplia tudo sem perder conteúdo.

## 4. Cores e superfícies

Cores **por função** (`--c-text`, `--c-surface`, `--c-accent`, `--c-destructive`, `--c-warning`,
`--c-success`…), com tema claro e escuro (`prefers-color-scheme`). Destaque reservado para a ação
principal e para estados que pedem atenção. Superfícies com separadores finos e sombra mínima.

**Estado nunca só por cor**: o interruptor tem marca de "ligado" e a posição muda; permissões
mostram "Liberado/Bloqueado"; a faixa de sessão tem ícone + texto em cada item; status de conexão
tem texto descritivo.

## 5. Componentes

| Componente | Comportamento |
|---|---|
| Botões | principal (destaque), secundário (preenchimento neutro), destrutivo (vermelho), simples (texto). Nomes dizem o resultado: "Gerar convite", "Encerrar sessão", "Salvar e reiniciar". Estado de carregamento com indicador e texto ("Gerando convite…"). |
| Campos | rótulo visível, dica abaixo do grupo, erro **junto ao campo** explicando como corrigir; foco vai para o primeiro campo com erro. |
| Interruptores | `input type=checkbox role=switch` nativo, acessível por teclado e leitor de tela. |
| Abas segmentadas | `role=tablist`, setas/Home/End, aviso de mensagem nova no Chat (com rótulo acessível). |
| Diálogos | `<dialog>` modal nativo; Esc = opção segura (recusar/cancelar). **Um diálogo por vez**: a aprovação sai da tela enquanto se escolhe a tela a compartilhar. |
| Confirmações | só para ações destrutivas sem urgência de segurança: limpar histórico, encerrar (lado técnico), gravar. Enviar arquivo usa confirmação **no próprio painel**, sem abrir outro diálogo. |

Exceção deliberada: para quem compartilha a tela, **Encerrar sessão** e **Cancelar convite** são
imediatos. Parar de compartilhar precisa ser instantâneo, e nada se perde.

## 6. Ícones

Conjunto próprio em SVG (sprite em `index.html`): traço único de 1,75 px, cantos arredondados,
grade de 24 px. Sempre acompanhados de texto quando o significado não é óbvio. Nenhum símbolo
imita ícones de aplicativos da Apple.

## 7. Animações

- Troca de tela: aparecer + deslocar 6 px (200 ms). Diálogos: escala 0,96 → 1 (200 ms) e saída de 120 ms.
- Interruptores, abas e botões pressionados (escala 0,97) com transições de 120–200 ms.
- Movimento contínuo só em indicadores de atividade enquanto algo carrega.
- **Reduzir movimento** (`prefers-reduced-motion`): animações e transições viram instantâneas e o
  indicador de atividade deixa de girar; tudo continua funcionando (testado no e2e).

## 8. Estados e feedback

Foco (contorno de 3 px), passagem do cursor, pressionado, selecionado (`aria-current`,
`aria-selected`), desabilitado, carregando (`aria-busy`), sucesso, alerta e erro definidos.
Mudanças importantes **não dependem só de avisos temporários**: ficam na faixa da sessão, no status
de conexão e na aba Atividade.

## 9. Acessibilidade

Link "Pular para o conteúdo", rótulos em todos os campos (verificado no teste), foco movido para o
título ao trocar de tela, regiões `aria-live` para status e chat, ordem de navegação seguindo a
tela, alvos de 44 px em toque.

## 10. Plataforma

- App de computador com **janela e menus nativos do sistema** (Arquivo, Editar, Visualizar, Janela,
  Ajuda; menu do app no macOS com Ajustes… ⌘,), sem imitar botões de janela.
- No macOS 15+, a escolha da tela usa o **seletor do próprio sistema**; nos demais, o seletor do app
  lista telas e janelas reais.
- Fechar a janela durante uma sessão abre a confirmação nativa do sistema.
- Controle remoto: faixa vermelha própria, sempre por cima de todas as janelas, com texto e botão
  "Parar controle" e o atalho exibido. No app do técnico, o botão "Controlar" tem estado
  pressionado (`aria-pressed`) e a tela remota ganha contorno de destaque enquanto captura.
- Atualização: faixa discreta no topo ("Nova versão pronta"), com ação clara e sem reiniciar
  durante uma sessão.

## Checklist de revisão de tela

- [ ] A finalidade da tela fica clara pelo título e pela ação principal.
- [ ] Ação principal identificável; destrutivas separadas e em vermelho.
- [ ] Espaços e alturas vêm dos tokens; alinhamentos consistentes.
- [ ] No máximo 3–4 tamanhos de texto; nada essencial abaixo de 13 px.
- [ ] Todos os estados do controle definidos (foco, hover, pressionado, desabilitado, carregando, erro).
- [ ] Estado comunicado por texto/ícone além da cor.
- [ ] Funciona com "reduzir movimento", tema escuro, zoom de 200%, teclado e toque.
- [ ] Testada em 390 px (celular), ~1000 px e ≥ 1280 px.
