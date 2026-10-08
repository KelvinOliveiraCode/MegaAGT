# OpenCode Hub — contexto do projeto

Documento de referência para quem vai **manter ou estender** este app.
Descreve o que existe, por que existe assim, e onde mexer em cada coisa.

> Se você só quiser usar o app: abra `OpenCode Hub.exe`. Ele sobe o servidor
> sozinho. Veja [Servidor](#servidor-o-app-sobe-o-servidor-sozinho).

---

## 1. O que é

Hub desktop para o **OpenCode CLI v2**. Não é um cliente genérico de chat: ele
conversa com o serviço HTTP local que o próprio OpenCode publica e mostra o
que o CLI mostra — sessões paralelas, subagentes, raciocínio, diffs, uso de
tokens e custo.

- **Rust + Tauri 2** no backend (só uma ponte HTTP; nada de lógica de UI)
- **JS puro, sem framework** no frontend (sem build step, sem npm no runtime)
- **9 temas, 6 cores de destaque**

---

## 2. Rodar e publicar

```bash
cd C:\Users\Kelvin\Desktop\opencode-hub

npm run dev      # desenvolvimento com hot reload
npm run build    # release (~90 s)
```

Depois de `build`, **copie** o executável para a área de trabalho:

```bash
Copy-Item src-tauri\target\release\opencode-hub.exe "C:\Users\Kelvin\Desktop\OpenCode Hub.exe" -Force
```

O `.exe` fica travado enquanto o app está rodando — **feche o Hub antes de
copiar**, senão o `Copy-Item` falha.

### Depuração com CDP (opcional, útil para testes)

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
Start-Process "C:\Users\Kelvin\Desktop\OpenCode Hub.exe"
```

Só para testes automatizados. Não use no dia a dia.

### Ícone

`app-icon.svg` é a fonte. Qualquer mudança de ícone passa por ele:

```bash
npx tauri icon app-icon.svg    # regenera todos os tamanhos
```

O caminho do raio **precisa** ser o mesmo do sprite da interface
(`dist/index.html`, símbolo `i-bolt`). Foi assim que o ícone saiu espelhado
da interface uma vez — as duas versões divergiram.

---

## 3. Servidor: como o app se conecta

**O app sobe o serviço sozinho na abertura.** Ligado por padrão em *Iniciar o
serviço ao abrir o app*, dentro dos ajustes. O `init()` chama `ensure_service`
antes de qualquer outra chamada, porque sessão, modelo e evento dependem dele.

### O detalhe que custou tempo

`Command::new("opencode")` **não funciona** numa instalação via npm. O que existe
no PATH são os shims `opencode.cmd` e `opencode.ps1`, e o `CreateProcess` quer um
executável de verdade — o spawn falhava com `ENOENT`, e o "iniciar serviço" do
app nunca funcionou de fato.

`api::opencode_bin()` resolve na ordem:

1. `opencode.exe` no PATH (instalação nativa)
2. alvo do shim npm: `%APPDATA%\npm\node_modules\@opencode\cli\bin\opencode.exe`
3. desiste → o chamador usa `cmd /c opencode ...`

Todos os subcomandos passam por essa resolução, e o spawn leva
`CREATE_NO_WINDOW` para não piscar uma janela de console. O filho também não
herda os handles do app — segurá-los impede o processo de sair quando o Hub fecha.

### Comandos

| Comando | O que faz |
|---|---|
| `ensure_service` | Sobe só se preciso. É o que o `init()` chama |
| `start_service` | Sobe e espera ficar pronto |
| `restart_service` | Derruba e sobe |
| `stop_service` | Interrompe (o painel desliga o início automático junto) |
| `service_diagnostics` | Endereço, versão, caminho do registro, caminho do executável, se responde |
| `cli_version` | Versão do CLI. Executa de verdade — é o teste do spawn |

O painel de ajustes mostra o estado real e dá para corrigir à mão. Se
`cliPath` vier vazio, o app não achou o executável: reinstale o CLI ou abra o
OpenCode uma vez pelo terminal.

---

## 4. Arquitetura

```
┌──────────────────────────────────────────────────────────┐
│  OpenCode Hub.exe (Tauri 2)                              │
│                                                          │
│  dist/index.html ─┬─ sprite SVG + esqueleto              │
│                   ├─ styles.css   (tokens, temas)        │
│                   └─ app.js       (todo o frontend)      │
│         │  api(cmd, params)  ↓         ↑ oc-event        │
│  ┌──────┴──────────────────────────────────────┐         │
│  │  src-tauri/src/main.rs  (comandos Tauri)   │         │
│  │  src-tauri/src/api.rs    (cliente HTTP)    │         │
│  └──────────────────┬─────────────────────────┘         │
└─────────────────────┼───────────────────────────────────┘
                      │ HTTP Basic (opencode:<senha>)
                      │ + header x-opencode-directory
              ┌───────▼────────┐
              │ opencode serve │  (o CLI, processo separado)
              └────────────────┘
```

O Rust é **só uma ponte**: valida, injeta o diretório de trabalho, traduz
erros. Toda a apresentação é JS. Isso é deliberado — o comando mais complexo
do lado Rust é `open_folder`.

---

## 5. Mapa de arquivos

| Arquivo | Linhas | O que é |
|---|---:|---|
| `dist/app.js` | 3391 | **Tudo** o frontend: estado, markdown, ferramentas, vistas |
| `dist/styles.css` | 789 | Tokens, 9 temas, componentes, barras de rolagem |
| `dist/index.html` | 114 | Sprite SVG (ícones) + esqueleto do DOM |
| `src-tauri/src/main.rs` | 989 | Comandos Tauri, event loop SSE, auxiliar do Windows |
| `src-tauri/src/api.rs` | 230 | Cliente HTTP, descoberta e início do serviço |
| `app-icon.svg` | 1 | Fonte do ícone do aplicativo |
| `vendor.mjs` | — | Copia `@tauri-apps/api` para `dist/tauri-api/` |

`dist/tauri-api/` é **vendorizado** (não tem `node_modules` em produção).

---

## 6. Contrato com a API do OpenCode

A fonte da verdade é `GET /openapi.json` no serviço rodando. As peculiaridades
abaixo custaram tempo e **não mudam** sem um teste:

| Peculiaridade | Detalhe |
|---|---|
| `Model.Ref` | `{id, providerID, variant?}` — é **`id`**, não `model` |
| Mensagens | `content[]` com `type: text \| reasoning \| tool \| meta` — **não** `message.parts` / `info.role` |
| `POST /api/session` | O header `x-opencode-directory` é **ignorado**; tem que mandar `location: {directory}` no corpo |
| Lista de sessões | `?project=<id>` dá as sessões do projeto. `?directory=` também traz as `projectID: global` |
| `order` + `cursor` | São **incompatíveis** (`InvalidCursorError`). Por isso a ordenação é feita no cliente (`chronological()`) |
| Eventos | SSE em `/api/event`. O servidor **encerra** a conexão ociosa (~5 s) — reconexão rápida é o normal, não é bug |
| Effort | É a **variante** do modelo: `provider/id#variante`. `none` desliga o raciocínio. 125 dos 144 modelos têm variante |
| `session.json` | Falta quando o CLI nunca rodou → o app mostra o aviso "Abra o OpenCode uma vez" |
| Erros | `error.message`, **não** `error.data.message` |

Credenciais: `~/.local/state/opencode/service.json` (`url` + `password`).

### Models sem provedor válido
Alguns modelos respondem **HTTP 402 "Insufficient account funds"**
(ex.: `opencode/mistral-large-4`). É transitório. Para testar:
`opencode/ling-3.1-flash-free` e `kilo1/dots-studio/dots-3-note-preview:free`.

---

## 7. Backend — comandos Tauri

Todos em `main.rs`, registrados no `generate_handler!`. Convenções que valem
para todos:

- `rename_all = "snake_case"` — o nome vem do `#[tauri::command]`
- wrapped em `run(&state, |api| ...)` → injeta o diretório e **redescobre o
  serviço em 401** (quando o serviço reinicia e a senha muda)
- erro volta como `Err(String)` em português, com acentuação

| Grupo | Comandos |
|---|---|
| Serviço | `service_status`, `ensure_service`, `start_service`, `restart_service`, `stop_service`, `service_diagnostics`, `cli_version`, `set_directory`, `default_location` |
| Sessões | `list_sessions`, `get_session`, `create_session`, `rename_session`, `delete_session`, `delete_sessions`, `active_sessions`, `move_session`, `list_projects` |
| Mensagens | `list_messages`, `send_prompt`, `interrupt_session`, `mark_viewed`, `get_session_log` |
| Histórico | `compact_session`, `fork_session`, `stage_revert`, `commit_revert`, `clear_revert` |
| Modelo/agente | `list_models`, `list_agents`, `list_commands`, `list_skills`, `switch_model`, `switch_agent`, `run_command` |
| Diff/uso | `session_diff`, `session_stats`, `vcs_status` |
| Permissões | `session_permissions`, `reply_permission` |
| Sistema | `open_external`, `open_folder`, `reveal_in_explorer` |

### Auxiliares do Windows

```rust
open_external(url)    // rundll32 url.dll,FileProtocolHandler
                      // com allowlist: http, https, mailto.
                      // file:// e javascript: são recusados.
open_folder(path)     // explorer <path>. Se for arquivo, abre a pasta que o contém.
reveal_in_explorer(p) // explorer /select,<p>
```

`open_folder` **valida que o caminho existe** antes de chamar o Explorer —
o Explorer tem um comportamento bizarro com barras invertidas no caminho, e
aceitar qualquer string seria injetar entrada nele.

---

## 8. Frontend — o mapa do `app.js`

### Estado

```js
const state = {
  view: "foco",        // foco | paralelo | subagentes | eventos
  theme, accent, think, directory, pins, selectedId,
  sessions, messages,  // messages: sid -> array (já em ordem)
  live: {},            // sid -> Map(msgId -> {reasoning, texts, tools})
  busy, usage,
  models, agents, commands, projects, permissions,
  search, showSubs, sidebarCollapsed, listLimit, selectMode, selected,
  expanded: {},        // chave `sid|msgId|kind` -> bool (partes abertas)
  diffs: {},
  events, eventFilter, eventPaused,
  stream: { state, attempt, reconnects, since },
};
```

O que persiste em `localStorage` (prefixo `hub.`): `view`, `theme`, `accent`,
`think`, `directory`, `pins`, `selectedId`, `showSubs`, `sidebarCollapsed`,
`autostart`, `clampPx`, `outChars`, `listLimit`, `markViewed`, `fsize`.

`fsize` vira `--fs` em `:root` e multiplica os tokens `--t-*` e `--code`, então
a escala de texto vale para o app inteiro de uma vez.

### Funções que você vai querer conhecer

| Símbolo | Para quê |
|---|---|
| `api(cmd, params)` | Ponte para o Rust |
| `el(tag, props, ...kids)` | Criador de elemento |
| `esc(s)` | Escape de HTML |
| `md(src)` / `inline(src)` | Markdown. `inline` extrai código, autolinka URLs e pastas, e aplica ênfase |
| `matchWinPath` / `linkifyPaths` | Reconhece pastas do Windows |
| `chronological()` | Ordena mensagens (a API não aceita `order` com cursor) |
| `blockTool` / `toolBody` / `toolSubject` | Renderização de ferramenta |
| `diffLines` / `diffHunks` / `codeDom` | Motor de diff e de código numerado |
| `buildModelList` / `openModelPicker` | Seletor de modelo (compartilhado) |
| `openEffortPicker` | Menu de effort / thinking |
| `applyClamps` | Recolhe texto longo com "abrir para ler" |
| `openPopover` | Menu flutuante |
| `errorText` / `errorBlock` | Erros (leem `error.message`) |
| `refreshSessions` / `refreshMessages` / `renderSessionHeader` / `renderView` | Ciclo de render |
| `handleEvent` | Traduz os eventos SSE |

### Atalhos

| Tecla | Ação |
|---|---|
| `Enter` | Enviar |
| `Shift+Enter` | Nova linha |
| `Ctrl+B` | Recolher / abrir a barra de sessões |
| `Ctrl+clique` | Seleção múltipla na lista |
| `Esc` | Fecha popover, modal e edição de título |

---

## 9. Sistema visual

### Regras que não se negociam

1. **Nenhum emoji na interface.** Nem no rótulo, nem no título, nem no código.
   (O único glifo é o `❯` do prompt de shell — é tipografia de CLI, não emoji.)
2. **Sem duplicar ação.** Tudo que age sobre a sessão vive **só** no menu `⋯`,
   nunca também no cabeçalho.
3. **Acentos corretos em tudo que o usuário lê.** O backend e o frontend falam
   português. Comentários de código podem ficar em ASCII.
4. **Uma cor de destaque, o resto neutro.** Os temas só trocam tokens.
5. **Nada sobreposto.** Gradiente, overlay ou popover **nunca** por cima de
   texto legível.

### Tokens

Espaçamento em 4px (`--sp-1..6`), tipografia em 4 tamanhos (`--t-xs..lg`),
raio em 4 valores (`--r-sm..full`). Cores: `--bg`, `--surface`, `--raised`,
`--hover`, `--ink`, `--ink-2`, `--muted`, `--line`, `--line-2`, `--accent`,
`--accent-ink`, `--accent-soft`, `--ok`, `--warn`, `--err`, `--busy`,
`--think-ink`, `--think-bg`.

**Todo tema precisa definir a lista inteira.** Um token faltando vira
`transparent` e o elemento some.

Temas: `meia-noite` (padrão), `claro`, `nord`, `dracula`, `solarizado`,
`monokai`, `terminal`, `contraste`, `por-do-sol`.
Cores de destaque: `indigo` (padrão), `cyan`, `green`, `amber`, `rose`, `violet`.

### Camadas (z-index)

```
#popRoot   120  <- acima dos modais, senão o seletor abre atrás
#toastRoot  90
#modalRoot  80
popover    20
```

`#popRoot` tem `pointer-events: none`; só os popovers dentro capturam o clique.

### Barras de rolagem

Trilho invisível, polegar arredondado, acende no hover e vira `--accent` no
arrasto. 10px no geral, 8px dentro de código e na barra lateral.
`.code-scroll` usa `scrollbar-gutter: stable` para o código não pular quando
a barra aparece.

---

## 10. Ferramentas e código — como é renderizado

| Ferramenta | Apresentação |
|---|---|
| `edit`, `patch`, `multiedit` | Diff unificado com `@@ -a,b +c,d @@`, verde no que entra, vermelho no que sai, chips `+n −n`, contexto de 3 linhas |
| `write` | Conteúdo numerado + chip `arquivo novo · N linhas` (não é diff: arquivo novo não tem "antes") |
| `read` | Numeração **real** do arquivo (o `read` do OpenCode já manda `1690: …`) |
| `shell` | Comando numa faixa com `❯`, saída em bloco sem numeração (saída não é código) |
| `grep` | Contador de ocorrências, arquivo em destaque |
| outros | Genérico: `entrada` / `saída` em blocos de texto |
| cercas de código | Numeração de linha + rótulo da linguagem (`data-lang`) |

O cabeçalho é `ícone · ação · assunto`:
`editar  ~\Desktop\opencode-hub\src-tauri\src\main.rs  OK`

O assunto trunca **pelo meio** (o fim do caminho importa mais) e o texto
completo fica no `title`.

### Limites do motor de diff

- `diffLines` é LCS com matriz `Uint32Array`. Acima de **4 milhões de células**
  (~2000×2000) ele cai para "remove tudo / adiciona tudo" em vez de estourar memória.
- `MAX_CODE_ROWS = 400` linhas exibidas por bloco; o resto vira
  `… mais N linhas`.
- O `edit` **não** tem numeração absoluta — a API não envia o deslocamento da
  linha. O número é relativo ao trecho.

---

## 11. Como adicionar uma coisa

### Um item novo no menu ⋯

```js
// main.rs: registra o comando
#[tauri::command(rename_all = "snake_case")]
async fn minha_acao(state: State<'_, AppState>, session_id: String) -> Result<Value, String> {
    run(&state, |api| async move { api.post("/api/...", json!({ ... })).await }).await
}
// ...e adiciona ao generate_handler!

// app.js: item no menu, junto das outras ações de sessão
item("Minha ação", "i-bolt", async () => {
  try { await api("minha_acao", { session_id: s.id }); await refreshSessions(); }
  catch (e) { fail(e); }
});
```

Ícones disponíveis estão no sprite de `dist/index.html`. Para adicionar um
novo: `<symbol id="i-x" viewBox="0 0 24 24">…</symbol>`. Depois use
`icon("i-x")` — o SVG usa `fill: none; stroke: currentColor`, então é só
desenhar o traçado.

### Um tema novo

Copie um bloco `:root[data-theme="…"]` e defina **todos** os tokens. Teste nos
dois estados da barra lateral (selecionada e não) — é onde o contraste quebra.

### Uma view nova

Adicione o botão em `index.html`, um caso em `renderView`, e guarde o nome em
`state.view` (já persiste sozinho).

### Um campo na resposta de uma ferramenta

1. Descubra o nome real em `GET /openapi.json` — **não chute**.
2. Em `toolBody`, leia de `st.input` / `st.content`.
3. `toolOutputText()` já achata `{type:"text"}` e `{type:"file"}`.

---

## 12. Armadilhas

> Verifique esta lista antes de mexer em qualquer coisa.

1. **`Element.appendChild()` aceita um nó só.** Passar dois derruba conteúdo
   **em silêncio**. Use `el("div", {}, filho1, filho2)` ou `append(a, b)`.
   Rode `node checkappend.mjs` depois de editar JS.

2. **Nunca passar string do PowerShell por roundtrip em arquivo UTF-8.**
   `Get-Content`/`Set-Content` no PS 5.1 corrompe acentuação. Use as ferramentas
   de arquivo, ou `node`, ou `Get-Content -Encoding UTF8` / `[IO.File]::ReadAllText`.

3. **`order=asc` não funciona junto com cursor.** A API recusa. Ordene no
   cliente.

4. **`modelKey()` inclui `#variante`, o catálogo não tem variante.** Comparar os
   dois direto nunca casa. Use `modelBaseKey()` para buscas no catálogo.

5. **`content` de ferramenta** é `[{type:"text", text}]` ou uma string, não
   JSON cru. Use `toolOutputText()`.

6. **O SSE reconecta o tempo todo** (o servidor morre sozinho em ~5 s). Grite
   "reconectando" e pare. Estado de stream é derivado da **recência do último
   evento**, não do texto do status.

7. **O usuário pode estar trabalhando na sessão que você está testando.** Um
   script CDP que troca de sessão rouba a seleção e produz falso positivo.

8. **`window.location.reload()` preserva o `AppState` do Rust** — inclusive o
   diretório de trabalho. Para testar a detecção de diretório do zero, **reinicie
   o processo**.

---

## 13. Harness de testes

Em `%TEMP%\hubcheck` (fora do projeto, de propósito):

| Script | O que faz |
|---|---|
| `cdp.mjs` | Driver CDP. Conecta no import. Exporta `evaluate`, `send`, `shot` |
| `test.mjs` | 20 testes de markdown e normalização |
| `codediff.mjs` | 26 testes do motor de diff, hunk e numeração |
| `keytest.mjs` | 9 testes de `modelKey` / `modelBaseKey` / `modelVariants` |
| `pathtest.mjs` | 10 casos de reconhecimento de pasta vs URL vs data |
| `checkappend.mjs` | Caça `appendChild` com múltiplos argumentos |
| `scanenc.mjs` / `scanmoj.mjs` | Varredura de mojibake: pares de bytes e sequências suspeitas |
| `final-check.mjs` | 21 verificações de UI no app real |

```bash
cd "$env:TEMP\hubcheck"
node test.mjs        # markdown
node codediff.mjs    # diff
node keytest.mjs     # chaves de modelo
node checkappend.mjs # sempre depois de editar JS
```

Fluxo de verificação completo: testes unitários → `cargo check` → build →
subir com CDP → rodar `final-check.mjs`.

---

## 14. Decisões que já foram tomadas

| Decisão | Por quê |
|---|---|
| Frontend em JS puro, sem framework | Sem build step. O app inteiro é 3 arquivos que você abre num editor de texto |
| Rust só como ponte HTTP | Toda a apresentação é JS; testável sem recompilar |
| Sessões filtradas por `project` | É o que o CLI mostra. `directory` traz as globais junto |
| Ordenação no cliente | `order` é incompatível com cursor |
| Ações só no menu `⋯` | Cabeçalho com 6 botões vira parede |
| Effort = variante do modelo | É assim que o OpenCode modela raciocínio. Não existe endpoint separado |
| Sem crate novo para `open_external` | `rundll32` resolve; `shell-open` puxaria uma árvore de dependências |
| Gradiente do clamp vira máscara | Um overlay **sempre** cobre texto. A máscara fica no *padding*, no espaço vazio |
| Pastas clicáveis em vez de linkify genérico | Regex pura erra nos dois sentidos: corta em `C:\Meus Documentos\x` e engole a frase vizinha. O scanner resolve com regra explícita |
| Tabelas do shell sem numeração | Numeração em saída de comando é ruído; em código é informação |

---

## 15. Perguntas frequentes

**Preciso abrir o CLI?**
Não. O app sobe o serviço sozinho ao abrir (ajustável em *Iniciar o serviço ao
abrir o app*). Se o executável do CLI não for encontrado, o painel de ajustes
mostra o motivo. Ver [seção 3](#3-servidor-como-o-app-se-conecta).

**Trocar de modelo não funciona.**
Quase sempre é `Model.Ref` com `model` em vez de `id`, ou um modelo que
responde 402. Veja [seção 6](#6-contrato-com-a-api-do-opencode).

**A lista de sessões está vazia ou cheia demais.**
`list_sessions` filtra por `project`. Confira `default_location` — o
diretório de trabalho errado traz as sessões de outro projeto.

**Um bloco de texto ficou cortado sem "abrir para ler".**
`applyClamps` compara com `CLAMP_PX`. Se o texto couber, o botão não aparece
— está certo.

**Um emoji apareceu na interface.**
Não deveria. Se apareceu, veio de `<symbol>` novo ou de string nova.
`node emoji.mjs` no harness acusa.

**Troquei um token de cor e o elemento desapareceu.**
Faltou definir o token em um dos temas. Todo tema precisa da lista inteira.