<div align="center">

<p>
  <img src="https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri&logoColor=black" alt="Tauri 2">
  <img src="https://img.shields.io/badge/Rust-2021-dea584?style=flat-square&logo=rust&logoColor=black" alt="Rust">
  <img src="https://img.shields.io/badge/JavaScript-vanilla-f7df1e?style=flat-square&logo=javascript&logoColor=black" alt="Vanilla JS">
  <img src="https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square&logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/OpenCode-CLI%20v2-6e56cf?style=flat-square" alt="OpenCode CLI v2">
</p>

# MegaAGT

**App desktop (Tauri v2 + Rust) para o OpenCode CLI v2: todas as sessoes em um so lugar, conversa ao vivo com o servico, subagentes, raciocinio do modelo, diretorio de trabalho e exportacao.**

</div>

---

## PT-BR

### O que e

O MegaAGT e um cliente de desktop para o **OpenCode CLI v2**. Ele le o servico
local do OpenCode (`~/.local/state/opencode/service.json`), autentica com HTTP
Basic e consome a API e o stream de eventos por SSE. O resultado e um unico
app para acompanhar e conduzir o trabalho do CLI: sessoes em lista e em
paralelo, subagentes, custo e tokens por sessao, filtros de arquivo, permissoes
e configuracoes que o CLI enterrava em logs.

Frontend em **JavaScript puro** (sem framework, sem build step), backend em
**Rust** com Tauri v2. A embalagem e pequena porque nao carrega runtime de UI.

### Funcionalidades

**Sessoes**
- Lista com busca, subagentes ocultos por padrao (botao `Sub`) e **selecao multipla** para exclusao em lote — `Selecionar`, `Ctrl/Cmd + clique` para marcar sem trocar de sessao, `Todas` para o conjunto visivel, com confirmacao listando os titulos.
- Botao de excluir em **cada linha** da lista (nao so no cabecalho) e fixar/desafixar para o Paralelo.
- Barra lateral recolhivel (`Ctrl+B`) para dar a largura inteira ao chat; o estado persiste.
- Arvore de subagentes por `parentID`, com total por sessao.

**Contexto, fila e entrega**
- **Circulo de contexto** no cabecalho: quanto da janela o modelo ocupa. Verde, aviso em 70%, erro em 90%. O detalhe mostra usado, restante e limite, e tem atalho para **compactar**.
- **Fila de mensagens**: com o modelo ocupado, a mensagem pode esperar. A faixa lista o que esta na fila e cada item pode ser **Cancelar** (errou a mensagem) ou **Steer** (manda agora, antes da vez do modelo).
- **Botao de entrega** no compositor: *automatico* (respeita o trabalho em andamento), *agora* (corta a vez do modelo) ou *na fila*.
- **Aviso de trabalho** no chat e nos cartoes do Paralelo, com tres pontos animados.

**Anexos**
- Arraste qualquer arquivo ou pasta para a janela, ou use o clipe no compositor (clique abre arquivos, botao direito abre pasta). Pasta funciona: o servidor expande o conteudo.
- No Paralelo, soltar sobre um cartao anexa nele; fora dos cartoes, o anexo vai para o Foco. Cada destino tem a sua faixa, com tamanho, remocao e "limpar", e o envio leva os arquivos junto com a mensagem.

**Camera**
- O botao no canto inferior direito trava a camera: as mensagens que chegam entram sozinhas na tela. Clique de novo e a visao fica onde voce deixar.
- Rolar para cima solta a camera sozinho — quem esta lendo nao e arrastado para o fim. Cada sessao guarda a sua, e cada cartao do Paralelo tem a sua.

**Foco (chat)**
- Mensagens com markdown (titulos, listas aninhadas, tabelas, citacoes, cercas de codigo), *reasoning* e ferramentas recolhidos por padrao.
- Texto longo do assistente e truncado com **"abrir para ler"**; saidas grandes de ferramenta com "ler mais N caracteres".
- Reasoning com quebras de linha reais (o servidor as vezes entrega `\n` literal).
- Troca de **agente** e **modelo** por popover com busca — o modelo mostra o provedor antes do nome e destaca o que esta em uso.
- Estatisticas de tokens (entrada/saida/raciocinio/cache), custo, diretorio e estado da sessao.
- Mensagens recem-enviadas nao somem mais quando o historico recarrega.
- Acoes: interromper, compactar, bifurcar (historia inteira ou a partir de uma mensagem), **reverter ate uma mensagem**, mover para outro diretorio, diff de arquivos, exportar e excluir.
- Pedidos de permissao aparecem na hora, com Permitir / Sempre / Negar.
- Slash commands do diretorio com autocompletar (`/review`, `/init`, ...).
- Marcar sessao como vista quando ela fica ociosa.

**Paralelo**
- Sessoes fixadas com streaming ao vivo e campo de mensagem por card. Cada cartao tem troca de modelo, circulo de contexto e botao de interromper. **Arraste o cabecalho para reordenar** e **o canto inferior direito para redimensionar** — tamanho e ordem ficam gravados.

**Subagentes**
- Escopado a sessao selecionada por padrao, com alternancia para **todas as orquestracoes**; cada subagente mostra agente, tokens e tempo, e abre um resumo das mensagens.

**Eventos**
- Log do stream SSE com status do stream, contador de reconexoes, filtro por tipo e pausa.

**Ferramentas e codigo**
- Cada ferramenta tem apresentacao propria, no estilo do CLI:
  - **`edit` / `patch`** — diff unificado com cabecalho `@@ -a,b +c,d @@`, 3 linhas de contexto, fundo verde no que entra e vermelho no que sai, e chips `+n -n`.
  - **`write`** — o conteudo numerado, com chip `arquivo novo · N linhas`.
  - **`read`** — numeracao **real** do arquivo, com o caminho e o intervalo no cabecalho.
  - **`shell`** — o comando numa faixa com `❯` e a saida em bloco proprio.
  - **`grep`** — contador de ocorrencias e o arquivo em destaque.
- Cercas de codigo no texto do assistente, com numero de linha e o rotulo da linguagem.

**Effort e thinking**
- No menu `...` da sessao: **Effort / thinking** lista os niveis do modelo em uso (`none` desliga o raciocinio; `low`...`max` ligam). Trocar o nivel troca a variante do modelo — e assim que o OpenCode modela raciocinio.

**Navegacao**
- Links abrem no navegador padrao; **pastas citadas viram clicaveis** e abrem o Explorer na pasta exata (`C:\Users\...\project`, com espacos ou nao).
- Barras de rolagem finas em toda a interface, com trilho invisivel.

**Rascunhos enquanto voce digita**
- O **rascunho do compositor nao se perde**: nem em evento do stream, nem ao trocar de modelo, sessao, configuracao ou view. Ele fica em `localStorage` e volta com o cursor onde parou e o foco de volta no campo.
- O mesmo vale para os campos das cartas do Paralelo, cada um com o seu rascunho.
- **Arrastar** um arquivo para a janela *anexa* o arquivo. Ele **nao** escreve o caminho no texto — escrevia os dois e o arquivo aparecia em dobro.

**Ajustes**
- Painel completo (icone de engrenagem na barra superior), em quatro secoes:
  - **Servico do OpenCode** — estado real (endereco, versao, caminho do executavel), ligar/desligar o inicio automatico, conectar, reiniciar e parar.
  - **Aparencia** — tema, cor de destaque, tamanho do texto e raciocinio. Em *detalhe das rodadas*: *Tudo* abre raciocinio, edicoes, shells e chamadas de ferramenta; *So raciocinio* mostra so o raciocinio e nem desenha o resto; *So ao abrir* e o comportamento anterior, nada abre sozinho.
  - **Comportamento** — subagentes na lista, marcar como vista, quanto texto recortar, limite de saida de ferramenta e quantas sessoes listar.
  - **Dados** — atualizar, alteracoes do diretorio e limpar preferencias.

**Aba Ambiente** — quatro cartoes que o app nao mostrava em lugar nenhum:
- **Contexto da sessao** — a composicao real (quantos itens, de que tipo, tokens e custo) e o resumo da compactacao, em vez de despejar os megabytes do historico.
- **Servidores MCP** — quais estao conectados e se algum falhou.
- **Permissoes salvas** — tudo que voce aprovou com *Sempre*, com botao para **revogar** cada regra. Antes disso era permanente e invisivel.
- **Configuracao** — os documentos de config e suas secoes (nunca os valores: o config guarda chave de API em texto puro).

**Busca dentro da sessao**
- Campo acima do chat que filtra as mensagens da sessao aberta, com contador `acertos/total`. Some sozinho quando nao ha nada digitado.

**Subagentes rodando**
- Quando um modelo chama subagentes e fica esperando, aparece um painel acima do compositor (e uma versao compacta dentro de cada cartao do Paralelo) com: quantos estao rodando; o agente e o titulo de cada um; tokens de entrada/saida e ha quanto tempo; clique leva direto a conversa daquele subagente.
- Quando um subagente termina, o resultado volta pela **inbox** da sessao que o chamou (`session.inbox.delivered`, com `metadata.childID` e `state: "completed"`), e a conversa do pai e recarregada para exibi-lo.
- A lista sai de `childrenOf(sid)` cruzada com `/api/session/active`, que e a fonte autoritativa do que esta rodando. O painel do Paralelo se repinta a cada 2 s **sem recriar o grid**, para nao perder o foco nem o rascunho dos campos.

**Resumo da compactacao**
- Quando o contexto e compactado, o resumo aparece no chat como um bloco recolhivel — razao (`auto`), tokens e contagem de linhas no cabecalho, e o resumo em si renderizado como markdown por dentro. Funciona no Foco e nos cartoes do Paralelo, que usam o mesmo `messageNode`.

**Avisos que antes nao existiam**
- **Nova tentativa do provedor**: quando o modelo bate num 429 ou num endpoint fora, a sessao ficava parada por segundos sem sinal nenhum. Agora aparece a tentativa e o motivo.
- **Eventos sem tratamento**: a aba Eventos lista qualquer tipo de evento que o app nao saiba tratar, com contagem e o **JSON recebido** ao clicar. Antes eles caiam num `break` silencioso.
- **Modo so raciocinio**: as chamadas de ferramenta nao sao desenhadas nesse modo; agora ha um aviso na tela dizendo isso, em vez da sessao parecer vazia.

**Servico em segundo plano**
- O app **sobe o OpenCode sozinho ao abrir** — sem janela de console, e sem voce precisar abrir o CLI antes. Se o executavel nao for encontrado, o painel de ajustes diz qual foi o problema e por onde procurou.
- Detalhe que so aparece na instalacao via npm: existe `opencode.cmd` e `opencode.ps1` no PATH, mas **nao** existe `opencode.exe`. O Windows nao resolve shim ao spawnar, entao o app procura o executavel real dentro do proprio `node_modules` do CLI.

**Aparencia**
- 9 temas + 6 cores de destaque, toggle de raciocinio, tudo em `localStorage`. Sem emojis na interface.

### Como funciona

- O backend Rust le `~/.local/state/opencode/service.json` (URL + senha) e autentica com **HTTP Basic** (`opencode:<senha>`).
- O diretorio de trabalho e enviado no header **`x-opencode-directory`** em todas as chamadas — e assim que o OpenCode resolve commands, skills e o contexto do projeto.
- Um task consome o SSE `/api/event` e republica cada evento como `oc-event`. A conexao **nao tem timeout** (reqwest trataria `timeout(0)` como expiracao imediata) e reconecta com recuo curto, porque o servidor encerra a conexao ociosa.
- O estado de "rodando" e reconciliado por `GET /api/session/active`, que e a fonte autoritativa.
- O app **sobe o servico sozinho quando o registro nao existe** — na primeira vez, nao e preciso abrir o CLI antes. Quem dispara `opencode service start` e o loop de eventos, e so quando a leitura de `service.json` **falha**. Excecao: se `service.json` existe mas o processo morreu (o computador reiniciou, por exemplo), a leitura passa e o app apenas tenta reconectar — o indicador mostra `offline — clique para iniciar` e e preciso um clique, ou abrir o CLI uma vez.

### Integracao com o Hermes

[HERMES.md](./HERMES.md) e o plano (nao implementado) para uma segunda aba rodando o Hermes Agent, com o que eu verifiquei no CLI instalado e o passo a passo menor primeiro.

### Documentacao

[CONTEXTO.md](./CONTEXTO.md) e o documento de manutencao: arquitetura, contrato com a API do OpenCode (e as peculiaridades que custaram tempo), mapa de arquivos, tokens dos temas, receitas para adicionar coisas, armadilhas conhecidas e o harness de testes.

### Endpoints usados

```
GET    /api/info · /api/project · /api/session/{id}/view
GET    /api/session · /api/session/active · /api/session/{id}/message
POST   /api/session · /api/session/{id}/prompt · /api/session/{id}/command
POST   /api/session/{id}/interrupt · /compact · /fork · /model · /agent · /move
POST   /api/session/{id}/revert/stage · /revert/commit
DELETE /api/session/{id} · /api/session/{id}/revert
GET    /api/session/{id}/permission · POST /api/session/{id}/permission/{rid}/reply
GET    /api/session/{id}/diff · /api/model · /api/agent · /api/command · /api/skill
GET    /api/vcs/status · /api/event (SSE)
GET    /api/experimental/session/{id}/export
```

### Desenvolvimento

```powershell
npm install
npx tauri dev
```

### Build

```powershell
npx tauri build
```

Gera `src-tauri\target\release\megaagt.exe` (~1 min 30). Depois **copie** para a
area de trabalho — o `.exe` fica travado enquanto o app esta rodando:

```powershell
Copy-Item src-tauri\target\release\megaagt.exe "C:\Users\Kelvin\Desktop\MegaAGT.exe" -Force
```

O icone sai de `app-icon.svg`. Depois de mudar o icone:

```powershell
npx tauri icon app-icon.svg
```

### Requisitos

- Windows 10/11 com WebView2
- Rust MSVC toolchain
- Node.js 18+
- OpenCode CLI v2 instalado **e no PATH** (o app chama `opencode service start`)

---

## EN

### What it is

MegaAGT is a desktop client for the **OpenCode CLI v2**. It reads the local
OpenCode service (`~/.local/state/opencode/service.json`), authenticates with
HTTP Basic and consumes both the REST API and the SSE event stream. The result
is a single app to follow and drive the CLI's work: sessions in a list and in
parallel, subagents, cost and tokens per session, file diffs, permissions and
settings the CLI used to bury in logs.

The frontend is **vanilla JavaScript** (no framework, no build step), the
backend is **Rust** with Tauri v2. The package stays small because it carries
no UI runtime.

### Features

**Sessions**
- List with search, subagents hidden by default (`Sub` button) and **multi-select** for batch deletion — `Selecionar`, `Ctrl/Cmd + click` to mark without switching sessions, `Todas` for the visible set, with a confirmation listing the titles.
- Delete button on **every row** of the list (not just the header) and pin/unpin for the Parallel view.
- Collapsible sidebar (`Ctrl+B`) to give the chat full width; the state persists.
- Subagent tree by `parentID`, with a total per session.

**Context, queue and delivery**
- **Context circle** in the header: how much of the window the model occupies. Green, warning at 70%, error at 90%. The detail shows used, remaining and limit, with a shortcut to **compact**.
- **Message queue**: with the model busy, a message can wait. The strip lists what is queued and each item can be **Cancelar** (wrong message) or **Steer** (send now, ahead of the model's turn).
- **Delivery button** in the composer: *automatic* (respects work in progress), *now* (cuts the model's turn) or *queued*.
- **Working notice** in the chat and on Parallel cards, with three animated dots.

**Attachments**
- Drag any file or folder onto the window, or use the clip in the composer (click opens files, right-click opens folders). Folders work: the server expands the content.
- In Parallel, dropping onto a card attaches to it; outside the cards, the attachment goes to Focus. Each destination has its own strip, with size, removal and "clear", and sending carries the files along with the message.

**Camera**
- The button in the bottom-right corner locks the camera: incoming messages scroll into view by themselves. Click again and the view stays where you left it.
- Scrolling up releases the camera by itself — whoever is reading is not dragged to the end. Each session keeps its own, and each Parallel card has its own.

**Focus (chat)**
- Messages with markdown (headings, nested lists, tables, quotes, code fences), *reasoning* and tools collapsed by default.
- Long assistant text is truncated with **"abrir para ler"**; large tool outputs with "ler mais N caracteres".
- Reasoning with real line breaks (the server sometimes delivers literal `\n`).
- **Agent** and **model** switching via searchable popover — the model shows the provider before the name and highlights the one in use.
- Token statistics (input/output/reasoning/cache), cost, directory and session state.
- Freshly sent messages no longer vanish when the history reloads.
- Actions: interrupt, compact, fork (whole history or from a message), **revert to a message**, move to another directory, file diff, export and delete.
- Permission requests appear immediately, with Allow / Always / Deny.
- Directory slash commands with autocomplete (`/review`, `/init`, ...).
- Mark a session as viewed when it goes idle.

**Parallel**
- Pinned sessions with live streaming and a message field per card. Each card has model switching, a context circle and an interrupt button. **Drag the header to reorder** and **the bottom-right corner to resize** — size and order are saved.

**Subagents**
- Scoped to the selected session by default, with a toggle for **all orchestrations**; each subagent shows agent, tokens and time, and opens a summary of the messages.

**Events**
- SSE stream log with stream status, reconnect counter, filter by type and pause.

**Tools and code**
- Each tool gets its own presentation, in the CLI's style:
  - **`edit` / `patch`** — unified diff with `@@ -a,b +c,d @@` header, 3 lines of context, green background on what comes in and red on what goes out, and `+n -n` chips.
  - **`write`** — numbered content, with an `arquivo novo · N linhas` chip.
  - **`read`** — the file's **real** line numbers, with the path and the range in the header.
  - **`shell`** — the command in a strip with `❯` and the output in its own block.
  - **`grep`** — occurrence counter and the file highlighted.
- Code fences in assistant text, with line numbers and the language label.

**Effort and thinking**
- In the session's `...` menu: **Effort / thinking** lists the levels of the model in use (`none` turns reasoning off; `low`...`max` turn it on). Changing the level changes the model variant — that is how OpenCode models reasoning.

**Navigation**
- Links open in the default browser; **cited folders become clickable** and open Explorer at the exact folder (`C:\Users\...\project`, with spaces or not).
- Thin scrollbars across the interface, with an invisible track.

**Drafts while you type**
- The **composer draft is never lost**: not on a stream event, not when switching model, session, settings or view. It lives in `localStorage` and comes back with the cursor where it stopped and focus back in the field.
- The same holds for the Parallel card fields, each with its own draft.
- **Dragging** a file onto the window *attaches* the file. It does **not** write the path into the text — it used to write both and the file showed up twice.

**Settings**
- Full panel (gear icon in the top bar), in four sections:
  - **OpenCode service** — real state (address, version, executable path), toggle auto-start, connect, restart and stop.
  - **Appearance** — theme, accent color, text size and reasoning. Under *round detail*: *Everything* opens reasoning, edits, shells and tool calls; *Reasoning only* shows just the reasoning and does not even draw the rest; *On open only* is the previous behaviour, nothing opens by itself.
  - **Behaviour** — subagents in the list, mark as viewed, how much text to trim, tool output limit and how many sessions to list.
  - **Data** — refresh, directory changes and clear preferences.

**Environment tab** — four cards the app showed nowhere else:
- **Session context** — the real composition (how many items, of what type, tokens and cost) and the compaction summary, instead of dumping the history's megabytes.
- **MCP servers** — which ones are connected and whether any failed.
- **Saved permissions** — everything you approved with *Always*, with a button to **revoke** each rule. It used to be permanent and invisible.
- **Configuration** — the config documents and their sections (never the values: the config stores API keys in plain text).

**Search within the session**
- Field above the chat that filters the messages of the open session, with an `hits/total` counter. It disappears by itself when nothing is typed.

**Running subagents**
- When a model calls subagents and waits, a panel appears above the composer (and a compact version inside each Parallel card) with: how many are running; each one's agent and title; input/output tokens and how long they have been running; clicking takes you straight to that subagent's conversation.
- When a subagent finishes, the result comes back through the **inbox** of the session that called it (`session.inbox.delivered`, with `metadata.childID` and `state: "completed"`), and the parent's conversation is reloaded to display it.
- The list comes from `childrenOf(sid)` crossed with `/api/session/active`, the authoritative source of what is running. The Parallel panel repaints every 2 s **without recreating the grid**, so focus and field drafts are not lost.

**Compaction summary**
- When the context is compacted, the summary appears in the chat as a collapsible block — reason (`auto`), tokens and line count in the header, and the summary itself rendered as markdown inside. It works in Focus and on the Parallel cards, which share the same `messageNode`.

**Warnings that did not exist before**
- **Provider retry**: when the model hits a 429 or a dead endpoint, the session sat still for seconds with no sign at all. Now the attempt and the reason show up.
- **Unhandled events**: the Events tab lists any event type the app cannot handle, with a count and the **received JSON** on click. They used to fall into a silent `break`.
- **Reasoning-only mode**: tool calls are not drawn in this mode; now there is an on-screen notice saying so, instead of the session looking empty.

**Background service**
- The app **starts OpenCode by itself on open** — no console window, and no need to open the CLI first. If the executable is not found, the settings panel says what the problem was and where it looked.
- A detail that only shows up in the npm installation: `opencode.cmd` and `opencode.ps1` exist on PATH, but **`opencode.exe` does not**. Windows does not resolve shims when spawning, so the app looks for the real executable inside the CLI's own `node_modules`.

**Appearance**
- 9 themes + 6 accent colors, reasoning toggle, all in `localStorage`. No emojis in the interface.

### How it works

- The Rust backend reads `~/.local/state/opencode/service.json` (URL + password) and authenticates with **HTTP Basic** (`opencode:<password>`).
- The working directory is sent in the **`x-opencode-directory`** header on every call — that is how OpenCode resolves commands, skills and the project context.
- A task consumes the `/api/event` SSE stream and republishes each event as `oc-event`. The connection has **no timeout** (reqwest would treat `timeout(0)` as immediate expiry) and reconnects with a short backoff, because the server closes idle connections.
- The "running" state is reconciled by `GET /api/session/active`, the authoritative source.
- The app **starts the service by itself when the record does not exist** — the first time, the CLI does not need to be opened first. What triggers `opencode service start` is the event loop, and only when reading `service.json` **fails**. One exception: if `service.json` exists but the process died (the machine rebooted, say), the read succeeds and the app only tries to reconnect — the indicator shows `offline — clique para iniciar` and one click is needed, or opening the CLI once.

### Hermes integration

[HERMES.md](./HERMES.md) is the (unimplemented) plan for a second tab running the Hermes Agent, with what I verified in the installed CLI and the smallest-first step by step.

### Documentation

[CONTEXTO.md](./CONTEXTO.md) is the maintenance document: architecture, the contract with the OpenCode API (and the peculiarities that cost time), the file map, theme tokens, recipes for adding things, known traps and the test harness.

### Endpoints used

```
GET    /api/info · /api/project · /api/session/{id}/view
GET    /api/session · /api/session/active · /api/session/{id}/message
POST   /api/session · /api/session/{id}/prompt · /api/session/{id}/command
POST   /api/session/{id}/interrupt · /compact · /fork · /model · /agent · /move
POST   /api/session/{id}/revert/stage · /revert/commit
DELETE /api/session/{id} · /api/session/{id}/revert
GET    /api/session/{id}/permission · POST /api/session/{id}/permission/{rid}/reply
GET    /api/session/{id}/diff · /api/model · /api/agent · /api/command · /api/skill
GET    /api/vcs/status · /api/event (SSE)
GET    /api/experimental/session/{id}/export
```

### Development

```powershell
npm install
npx tauri dev
```

### Build

```powershell
npx tauri build
```

Produces `src-tauri\target\release\megaagt.exe` (~1 min 30). Then **copy** it to
the desktop — the `.exe` stays locked while the app is running:

```powershell
Copy-Item src-tauri\target\release\megaagt.exe "C:\Users\Kelvin\Desktop\MegaAGT.exe" -Force
```

The icon comes from `app-icon.svg`. After changing the icon:

```powershell
npx tauri icon app-icon.svg
```

### Requirements

- Windows 10/11 with WebView2
- Rust MSVC toolchain
- Node.js 18+
- OpenCode CLI v2 installed **and on PATH** (the app calls `opencode service start`)

---

## Estrutura / Structure

```
MegaAGT/
├── dist/                  frontend vanilla JS (app.js ~219 KB, styles.css, index.html)
├── src-tauri/
│   ├── src/main.rs        backend Rust: API, SSE, service lifecycle
│   ├── src/api.rs         contrato HTTP com o OpenCode
│   ├── Cargo.toml         pacote `megaagt`
│   └── tauri.conf.json    productName MegaAGT, identifier dev.opencode.hub
├── app-icon.svg
├── CONTEXTO.md            documento de manutencao
├── HERMES.md              plano da segunda aba (Hermes Agent)
└── package.json
```

## Licenca / License

MIT &mdash; consulte o repositorio.

---

<div align="center">
  <sub>Por <a href="https://github.com/KelvinOliveiraCode">Kelvin Oliveira</a> &middot;
  <a href="https://kelvinoliveiracode.github.io/portfolio/">portfolio</a></sub>
</div>
