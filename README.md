# OpenCode Hub

App desktop (Tauri v2 + Rust) para o **OpenCode CLI v2**: todas as sessões em um só lugar, conversa ao vivo com o serviço, subagentes, raciocínio do modelo, diretório de trabalho e exportação.

## Funcionalidades

### Sessões
- Lista com busca, subagentes ocultos por padrão (botão `Sub`) e **seleção múltipla** para exclusão em lote — `Selecionar`, `Ctrl/Cmd + clique` para marcar sem trocar de sessão, `Todas` para o conjunto visível, com confirmação listando os títulos.
- Botão de excluir em **cada linha** da lista (não só no cabeçalho) e fixar/desafixar para o Paralelo.
- Barra lateral recolhível (`Ctrl+B`) para dar a largura inteira ao chat; o estado persiste.
- Árvore de subagentes por `parentID`, com total por sessão.

### Foco (chat)
- Mensagens com markdown (títulos, listas aninhadas, tabelas, citações, cercas de código), *reasoning* e ferramentas recolhidos por padrão.
- Texto longo do assistente é truncado com **"abrir para ler"**; saídas grandes de ferramenta com "ler mais N caracteres".
- Reasoning com quebras de linha reais (o servidor às vezes entrega `\n` literal).
- Troca de **agente** e **modelo** por popover com busca — o modelo mostra o provedor antes do nome e destaca o que está em uso.
- Estatísticas de tokens (entrada/saída/raciocínio/cache), custo, diretório e estado da sessão.
- Ações: interromper, compactar, bifurcar (histórico inteiro ou a partir de uma mensagem), **reverter até uma mensagem**, mover para outro diretório, diff de arquivos, exportar e excluir.
- Pedidos de permissão aparecem na hora, com Permitir / Sempre / Negar.
- Slash commands do diretório com autocompletar (`/review`, `/init`, …).
- Marcar sessão como vista quando ela fica ociosa.

### Paralelo
Grade de sessões fixadas com streaming ao vivo e campo de mensagem por card.

### Subagentes
Escopado à sessão selecionada por padrão, com alternância para **todas as orquestrações**; cada subagente mostra agente, tokens e tempo, e abre um resumo das mensagens.

### Eventos
Log do stream SSE com status do stream, contador de reconexões, filtro por tipo e pausa.

### Ferramentas e código
Cada ferramenta tem apresentação própria, no estilo do CLI:
- **`edit` / `patch`** — diff unificado com cabeçalho `@@ -a,b +c,d @@`, 3 linhas de contexto, fundo verde no que entra e vermelho no que sai, e chips `+n −n`.
- **`write`** — o conteúdo numerado, com chip `arquivo novo · N linhas`.
- **`read`** — numeração **real** do arquivo, com o caminho e o intervalo no cabeçalho.
- **`shell`** — o comando numa faixa com `❯` e a saída em bloco próprio.
- **`grep`** — contador de ocorrências e o arquivo em destaque.
- **Cercas de código** no texto do assistente, com número de linha e o rótulo da linguagem.

### Effort e thinking
No menu `⋯` da sessão: **Effort / thinking** lista os níveis do modelo em uso
(`none` desliga o raciocínio; `low`…`max` ligam). Trocar o nível troca a variante
do modelo — é assim que o OpenCode modela raciocínio.

### Navegação
- Links abrem no navegador padrão; **pastas citadas viram clicáveis** e abrem
  o Explorer na pasta exata (`C:\Users\...\project`, com espaços ou não).
- Barras de rolagem finas em toda a interface, com trilho invisível.

### Aparência
9 temas + 5 cores de destaque, toggle de raciocínio, tudo em `localStorage`. Sem emojis na interface.

## Como funciona

- O backend Rust lê `~/.local/state/opencode/service.json` (URL + senha) e autentica com **HTTP Basic** (`opencode:<senha>`).
- O diretório de trabalho é enviado no header **`x-opencode-directory`** em todas as chamadas — é assim que o OpenCode resolve commands, skills e o contexto do projeto.
- Um task consome o SSE `/api/event` e republica cada evento como `oc-event`. A conexão **não tem timeout** (reqwest trataria `timeout(0)` como expiração imediata) e reconecta com recuo curto, porque o servidor encerra a conexão ociosa.
- O estado de "rodando" é reconciliado por `GET /api/session/active`, que é a fonte autoritativa.

### Sobre subir o serviço

O app **sobe o serviço sozinho quando o registro não existe** — na primeira vez,
não é preciso abrir o CLI antes. Quem dispara `opencode service start` é o loop
de eventos, e só quando a leitura de `service.json` **falha**.

Isso deixa uma exceção: se `service.json` existe mas o processo morreu (o
computador reiniciou, por exemplo), a leitura passa e o app apenas tenta
reconectar. Aí o indicador de conexão mostra `offline — clique para iniciar` e é
preciso um clique — ou abrir o CLI uma vez.

## Documentação

**[CONTEXTO.md](./CONTEXTO.md)** é o documento de manutenção: arquitetura,
contrato com a API do OpenCode (e as peculiaridades que custaram tempo), mapa de
arquivos, tokens dos temas, receitas para adicionar coisas, armadilhas conhecidas
e o harness de testes.

## Endpoints usados

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

## Desenvolvimento

```powershell
npm install
npx tauri dev
```

## Build

```powershell
npx tauri build
```

Gera `src-tauri\target\release\opencode-hub.exe` (~1 min 30). Depois **copie**
para a área de trabalho — o `.exe` fica travado enquanto o app está rodando:

```powershell
Copy-Item src-tauri\target\release\opencode-hub.exe "C:\Users\Kelvin\Desktop\OpenCode Hub.exe" -Force
```

O ícone sai de `app-icon.svg`. Depois de mudar o ícone:

```powershell
npx tauri icon app-icon.svg
```

## Requisitos

- Windows 10/11 com WebView2
- Rust MSVC toolchain
- Node.js 18+
- OpenCode CLI v2 instalado **e no PATH** (o app chama `opencode service start`)
