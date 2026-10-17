<img src="https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri&logoColor=black" alt="Tauri 2">
<img src="https://img.shields.io/badge/Rust-2021-dea584?style=flat-square&logo=rust&logoColor=black" alt="Rust">
<img src="https://img.shields.io/badge/JavaScript-vanilla-f7df1e?style=flat-square&logo=javascript&logoColor=black" alt="Vanilla JS">
<img src="https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square&logo=windows&logoColor=white" alt="Windows">
<img src="https://img.shields.io/badge/OpenCode-CLI%20v2-6e56cf?style=flat-square" alt="OpenCode CLI v2">

# MegaAGT

Cliente de desktop (Tauri v2 + Rust) para o OpenCode CLI v2. Une em uma janela as sessões em paralelo, os subagentes, o raciocínio do modelo, os diffs de ferramentas, as permissões e a exportação de sessões que o CLI enterra em logs.

## Problema / Por que existe

O OpenCode CLI v2 expõe seu trabalho por uma API HTTP local e um stream de eventos SSE, mas não tem interface gráfica própria. Acompanhar sessões paralelas, subagentes, custo e tokens por sessão, diffs e permissões exige ficar colado no terminal e ler logs. O MegaAGT consome a API local do OpenCode (HTTP Basic sobre service.json) e coloca esse trabalho em um app de desktop, para conduzir o CLI com interface gráfica em vez de comandos soltos.

## O que faz

- Lista de sessões com busca, seleção múltipla (Ctrl + clique), exclusão em lote com confirmação listando os títulos, fixar/desafixar para o Paralelo e botão de excluir em cada linha
- Barra lateral recolhível (Ctrl + B); o estado persiste
- Árvore de subagentes por parentID, com total por sessão
- Círculo de contexto no cabeçalho: verde, aviso em 70%, erro em 90%; mostra usado, restante e limite, com atalho para compactar
- Fila de mensagens: com o modelo ocupado, a mensagem espera; cada item pode ser Cancelar ou Steer (enviar agora, antes da vez do modelo)
- Botão de entrega no compositor: automático (respeita o trabalho em andamento), agora (corta a vez do modelo) ou na fila
- Anexos: arraste arquivos ou pastas para a janela ou use o clipe do compositor; pastas funcionam (o servidor expande o conteúdo). No Paralelo, soltar sobre um card anexa nele; fora dos cards, vai para o Foco
- Câmera: trava a rolagem automática; cada sessão e cada card do Paralelo guarda a sua. Rolar para cima solta a câmera
- Foco (chat): markdown, reasoning e ferramentas recolhidos por padrão; texto longo truncado com "abrir para ler"; trocas de agente e modelo por popover com busca; estatísticas de tokens (entrada/saída/raciocínio/cache), custo, diretório e estado da sessão; ações: interromper, compactar, bifurcar, reverter até uma mensagem, mover para outro diretório, diff de arquivos, exportar e excluir; pedidos de permissão na hora (Permitir / Sempre / Negar); slash commands com autocompletar
- Paralelo: sessões fixadas com streaming ao vivo e campo de mensagem por card; cada card tem troca de modelo, círculo de contexto e botão de interromper; arraste o cabeçalho para reordenar e o canto inferior direito para redimensionar (tamanho e ordem gravam)
- Eventos: log do stream SSE com status do stream, contador de reconexões, filtro por tipo e pausa
- Ferramentas com apresentação própria: edit/patch (diff unificado com cabeçalho @@, 3 linhas de contexto, fundo verde/vermelho, chips +n -n), write (conteúdo numerado com chip arquivo novo), read (numeração real do arquivo), shell (comando com ❯ e saída em bloco), grep (contador de ocorrências)
- Effort / thinking: níveis none (desliga raciocínio) a max; trocar o nível troca a variante do modelo
- Links abrem no navegador padrão; pastas citadas viram clicáveis e abrem o Explorer na pasta exata
- Rascunhos do compositor em localStorage: não se perdem ao trocar de modelo, sessão, configuração ou view; cada card do Paralelo tem o seu
- Ajustes em quatro seções: Serviço do OpenCode (estado real, ligar/desligar início automático, conectar, reiniciar, parar), Aparência (9 temas, 6 cores de destaque, tamanho do texto, detalhamento de rodadas), Comportamento (subagentes na lista, marcar como vista, corte de texto, limite de saída de ferramenta, quantidade de sessões listadas), Dados (atualizar, alterações de diretório, limpar preferências)
- Aba Ambiente: contexto da sessão (itens, tipo, tokens, custo, resumo da compactação), servidores MCP (conectados e falhas), permissões salvas (com botão revogar para cada regra), configuração (nomes de seção, nunca os valores)
- Busca dentro da sessão com contador acertos/total
- Painel de subagentes rodando acima do compositor (e versão compacta nos cards do Paralelo) com agente, título, tokens e tempo de cada um; clique leva direto à conversa do subagente
- Resumo da compactação como bloco recolhível no chat (razão, tokens, linhas, markdown por dentro)
- Avisos: nova tentativa do provedor (429 ou endpoint fora), eventos sem tratamento (com JSON recebido ao clicar), modo só raciocínio (aviso na tela)
- Serviço em segundo plano: o app sobe o OpenCode sozinho ao abrir, sem janela de console

## Stack

- Frontend: JavaScript puro, sem framework e sem build step (dist/app.js, dist/styles.css, dist/index.html); @tauri-apps/api vendorizado em dist/tauri-api/
- Backend: Rust com Tauri v2 (src-tauri/src/main.rs: comandos Tauri, event loop SSE; src-tauri/src/api.rs: cliente HTTP); dependências reqwest, tokio, serde, base64
- Comunicação com o OpenCode: HTTP Basic (opencode:<senha>), header x-opencode-directory em todas as chamadas, SSE em /api/event
- Runtime: WebView2 (Windows 10/11)
- Build: npx tauri build gera src-tauri\target\release\megaagt.exe (cerca de 1 minuto 30)

## Como funciona

O backend Rust lê ~/.local/state/opencode/service.json (URL e senha) e autentica com HTTP Basic (opencode:<senha>). O diretório de trabalho é enviado no header x-opencode-directory em todas as chamadas, assim o OpenCode resolve commands, skills e o contexto do projeto. Uma tarefa consome o SSE /api/event e republica cada evento como oc-event; a conexão não tem timeout e reconecta com recuo curto, porque o servidor encerra conexões ociosas. O estado de "rodando" é reconciliado por GET /api/session/active, a fonte autoritativa. Quando o registro do serviço não existe, o app sobe o serviço sozinho (opencode service start, com CREATE_NO_WINDOW, sem janela de console); em instalações via npm o executável real é procurado dentro do node_modules do CLI, pois não existe opencode.exe — apenas shims .cmd e .ps1.

## Como rodar

Requisitos: Windows 10/11 com WebView2, Rust MSVC toolchain, Node.js 18+, OpenCode CLI v2 instalado e no PATH.

Desenvolvimento:

```
npm install
npx tauri dev
```

Build:

```
npx tauri build
```

Gera src-tauri\target\release\megaagt.exe. Depois copie para a área de trabalho — o .exe fica travado enquanto o app está rodando, feche o MegaAGT antes de copiar:

```
Copy-Item src-tauri\target\release\megaagt.exe "C:\Users\Kelvin\Desktop\MegaAGT.exe" -Force
```

O ícone vem de app-icon.svg. Depois de mudar o ícone:

```
npx tauri icon app-icon.svg
```

## Estrutura do projeto

```
MegaAGT/
├── dist/                  frontend vanilla JS (app.js, styles.css, index.html, tauri-api/)
├── src-tauri/
│   ├── src/main.rs        comandos Tauri, event loop SSE, auxiliares do Windows
│   ├── src/api.rs         cliente HTTP com o OpenCode (descoberta e início do serviço)
│   ├── Cargo.toml         pacote megaagt
│   └── tauri.conf.json    productName MegaAGT, identifier dev.opencode.hub
├── app-icon.svg           ícone do aplicativo
├── CONTEXTO.md            documento de manutenção (arquitetura, contrato da API, armadilhas, harness de testes)
├── HERMES.md              plano não implementado de segunda aba com o Hermes Agent
├── package.json
└── package-lock.json
```

## Trade-offs e decisões

- Frontend em JS puro, sem framework: sem build step; todo o app são três arquivos que abrem em qualquer editor de texto
- Rust só como ponte HTTP: toda a apresentação é JS, testável sem recompilar; o comando mais complexo do lado Rust é abrir pasta
- Ordenação feita no cliente: a API é incompatível com order junto com cursor (InvalidCursorError)
- Ações só no menu ⋯: um cabeçalho com seis botões vira parede
- Effort é a variante do modelo: é assim que o OpenCode modela raciocínio; não existe endpoint separado
- Sem crate novo para abrir links externos: rundll32 resolve; shell-open puxaria uma árvore de dependências
- Máscara de corte em vez de gradiente: um overlay sempre cobre texto; a máscara fica no padding, no espaço vazio
- Pastas clicáveis com scanner explícito em vez de linkify genérico: regex pura erra nos dois sentidos (corta caminhos com espaços e engole a frase vizinha)
- SSE sem timeout: o servidor encerra conexões ociosas em cerca de cinco segundos; reconexão rápida é o comportamento normal, não um bug

## Limitações conhecidas

- Apenas Windows 10/11 com WebView2
- Requer OpenCode CLI v2 instalado e no PATH; o app chama opencode service start
- Instalação via npm: não existe opencode.exe, apenas shims .cmd e .ps1; o Windows não resolve shims ao spawnar, então o app procura o executável real dentro do node_modules do CLI
- Se service.json existe mas o processo morreu (computador reiniciou, por exemplo), a leitura passa e o app apenas tenta reconectar; é preciso clicar para iniciar ou abrir o CLI uma vez
- O motor de diff, acima de cerca de 4 milhões de células (~2000 × 2000), cai para "remove tudo / adiciona tudo" em vez de estourar memória; no máximo 400 linhas de código exibidas por bloco
- GET /api/session?search= casa por conteúdo, não por título; não apague sessões em loop por busca
- Modelos que respondem HTTP 402 (Insufficient account funds) são um erro transitório

## Licença

MIT — consulte o repositório.

## Autor

Kelvin Oliveira — https://github.com/KelvinOliveiraCode · https://kelvinoliveiracode.github.io/portfolio/
