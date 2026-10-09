# MegaAGT + Hermes — plano de integração

> Documento de planejamento. **Nada aqui foi implementado.** É a resposta a
> "como eu poderia ligar meu app ao Hermes", escrita com base no que eu
> verifiquei na sua máquina, não em suposição.

---

## 1. O que eu verifiquei (e como)

Rodei o Hermes instalado em `C:\Users\Kelvin\AppData\Local\hermes` (v0.21.6)
para conhecer a superfície real de integração.

**Os comandos que importam:**

| Comando | O que é |
|---|---|
| `hermes chat` | o agente. Tem `--format stream-json`, `--oneshot`, `-q`, `--query-file` |
| `hermes proxy start` | servidor HTTP local **OpenAI-compatível** para provedores OAuth |
| `hermes browser` | browsing com **perfil real** (o seu Chrome) |
| `hermes gateway` / `whatsapp` / `slack` / `send` | os **bots** |
| `hermes moa` | slots de Mixture of Agents |
| `hermes auth` / `fallback` | credenciais em pool, prioridade e reserva |
| `hermes model` | seleção de provedor/modelo (OAuth Nous) |

**O formato de stream — testado de verdade:**

```
$ hermes chat --oneshot -Q --format stream-json --pass-session-id -q "liste os .txt"

{"type":"system","subtype":"init","model":"nvidia/nemotron-3-ultra-550b-a55b:free","session_id":"20261009_175939_2198b1"}
{"type":"tool_use","name":"terminal","input":{"command":"find ..."}}
{"type":"tool_result","name":"terminal","output":"{\"output\":\"...\",\"exit_code\":0}","is_error":false,"duration_ms":5410}
{"type":"text","text":"…"}
{"type":"result","session_id":"20261009_175939_2198b1","exit_code":0,"tokens":{"input":…,"output":…,"total":…}}
```

Cinco tipos de evento: `system/init`, `tool_use`, `tool_result`, `text`, `result`.
O `session_id` sai no `init` e volta no `result` — dá para persistir conversa.

---

## 2. A boa notícia: os modelos kilo já estão no app

Verifiquei o seu `~/.config/opencode/opencode.jsonc`: **kilo1, kilo2, kilo3 e
kilo4 já são provedores do OpenCode**, com os nomes das suas contas.

Ou seja: `ling-3.1-flash`, `dots-3` etc. **já aparecem no seletor de modelo do
MegaAGT hoje**. Você não precisa "rotear" kilo pelo Hermes para usá-los no app.

O que o Hermes tem de diferente **não é acesso a modelo** — é capacidade:

| Só no Hermes | Para quê |
|---|---|
| `browser` com perfil real | automação web com a sua sessão logada |
| `gateway`/`whatsapp`/`slack`/`send` | bots e envio para plataformas |
| `moa` | vários modelos respondendo e um sintetizando (`/moa`) |
| `auth`/`fallback` | pool de credenciais com prioridade e reserva automática |
| `-t TOOLSETS` | ligar/desligar conjuntos de ferramentas |
| `--checkpoints`, `--worktree` | pontos de restauração e branches isoladas |
| `--run-budget`, `--max-turns` | teto de tempo e de turnos |
| `secrets`, `egress` | Bitwarden/1Password e firewall de saída |

---

## 3. Arquitetura recomendada: duas abas, um só app

```
┌──────────────────────────────────────────────────────────────┐
│ MegaAGT                                                    │
│  ┌──────────┐ ┌──────────┐ ┌──────┐ ┌──────┐ ┌──────────┐  │
│  │  Foco    │ │ Paralelo │ │ …    │ │Eventos│ │ Hermes  │◀─ nova
│  └──────────┘ └──────────┘ └──────┘ └──────┘ └──────────┘  │
│       │                                          │          │
│       │ serviço OpenCode (localhost:49374)       │ subprocesso
│       ▼                                          ▼          │
│  sessões, SSE                          hermes chat --format │
│                                        stream-json           │
└──────────────────────────────────────────────────────────────┘
```

**Regra que eu seguiria:** duas abas, dois backends, **uma só camada de
apresentação**.

O que já existe e é reaproveitável tal como está:
- o compositor (rascunho, anexos, entrega)
- o renderizador de markdown
- o bloco de ferramenta (diff, `$ cmd`, linha de resultado)
- os avisos (subagentes rodando, nova tentativa, formulários)
- os temas, a busca, o controle de detalhe

O que muda é **de onde vêm as mensagens**: hoje é `state.messages[sid]`
abastecido pelo SSE; no Hermes seria `state.hermes[sid]` abastecido pelo
stdout do subprocesso.

---

## 4. Como ligar, no menor passo possível

### Passo 1 — provar o spawn (1 comando Rust)

```rust
#[tauri::command]
async fn hermes_run(prompt: String, dir: String) -> Result<Value, String> {
    // argv direto: NADA de shell. Assim -q aceita texto arbitrario
    // (quebra de linha, $, aspas) sem injeção.
    let mut c = Command::new("hermes");
    c.args(["chat", "--oneshot", "-Q", "--format", "stream-json",
            "--pass-session-id", "--max-turns", "6", "--in", &dir, "-q", &prompt])
     .stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)] { c.creation_flags(CREATE_NO_WINDOW); }
    // le linha a linha e emite "oc-hermes" como o event_loop faz com o SSE
}
```

**Atenção que descobri na prática:** `--format stream-json` **exige** `-q`.
`--query-file -` (que seria o caminho seguro para texto arbitrário) é recusado
com *"stream-json requires -q/--query"*. Como o spawn é por argv e não passa
por shell, `-q` com texto arbitrário continua seguro.

### Passo 2 — traduzir os 5 eventos para o que a UI já sabe

| Evento Hermes | Equivalente no app |
|---|---|
| `system/init` | modelo em uso + `session_id` |
| `text` | delta de texto → `state.live[sid].texts` |
| `tool_use` | bloco de ferramenta em estado `running` |
| `tool_result` | bloco concluído: `output`, `is_error`, `duration_ms` |
| `result` | fim: tokens, custo, duração |

Essa tradução é quase 1:1 com o `handleEvent` que já existe — o arquivo já tem
os casos `session.text.delta`, `session.tool.success`, `session.idle`.

### Passo 3 — uma view nova, o resto igual

Uma aba `Hermes` com a mesma casca do Foco (`focusShell`), mas o histórico em
`state.hermes[sid]` e um composer que chama `hermes_run`.

### Passo 4 — persistir conversa

`--resume SESSION_ID` continua uma sessão. Guardar o id (em `localStorage`,
prefixo `hermes.`) permite reabrir a conversa depois — que é o mesmo problema
que o rascunho já resolve hoje.

---

## 5. O que eu recomendaria **não** fazer

1. **Não unificar os dois backends num modelo de mensagem só.** Os formatos
   são parecidos mas não iguais (Hermes não tem "reasoning" separado no stream
   que testei; o OpenCode tem). Forçar a fusão cria um modelo que não
   representa nenhum dos dois.

2. **Não usar `--yolo`.** Ele aprova tudo sem perguntar. O app já tem o fluxo
   de permissão; o certo é expor a aprovação, não queimá-la.

3. **Não redirecionar kilo pelo `hermes proxy`.** O proxy encaminha para
   provedores OAuth (Nous Portal), não para kilo — e kilo já está no OpenCode.
   Seria trabalho para piorar.

4. **Não começar pelos bots.** WhatsApp/Slack/gateway são o passo mais caro e
   o menos ligado ao chat. Deixar para o fim.

---

## 6. Ordem que eu seguiria

1. `hermes_run` com um prompt besta → ver o JSON na aba Eventos (meia hora)
2. Renderizar `text` + `tool_use`/`tool_result` como blocos (o motor já existe)
3. Aba Hermes com o composer ligado
4. `--resume` para persistir conversa
5. Só então: `browser` (perfil real) e `moa`
6. Por último: `gateway`/`whatsapp`/`slack`

O passo 1 é o único que eu faria sem compromisso — ele não muda nada no app e
responde a única dúvida que resta: se o stdout chega linha a linha como eu vi
no teste manual.
