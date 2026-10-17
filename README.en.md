<img src="https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri&logoColor=black" alt="Tauri 2">
<img src="https://img.shields.io/badge/Rust-2021-dea584?style=flat-square&logo=rust&logoColor=black" alt="Rust">
<img src="https://img.shields.io/badge/JavaScript-vanilla-f7df1e?style=flat-square&logo=javascript&logoColor=black" alt="Vanilla JS">
<img src="https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square&logo=windows&logoColor=white" alt="Windows">
<img src="https://img.shields.io/badge/OpenCode-CLI%20v2-6e56cf?style=flat-square" alt="OpenCode CLI v2">

# MegaAGT

Desktop client (Tauri v2 + Rust) for the OpenCode CLI v2. Brings into one window the parallel sessions, subagents, model reasoning, tool diffs, permissions, and session export that the CLI buries in logs.

## Problem / Why it exists

The OpenCode CLI v2 exposes its work through a local HTTP API and an SSE event stream, but has no graphical interface of its own. Keeping up with parallel sessions, subagents, cost and tokens per session, diffs, and permissions requires staying glued to the terminal and reading logs. MegaAGT consumes the OpenCode local API (HTTP Basic over service.json) and puts that work into a desktop app, to drive the CLI through a graphical interface instead of loose commands.

## What it does

- Session list with search, multi-selection (Ctrl + click), batch deletion with confirmation listing the titles, pin/unpin for Parallel and a delete button per row
- Collapsible sidebar (Ctrl + B); state persists
- Subagent tree by parentID, with total per session
- Context circle in the header: green, warning at 70%, error at 90%; shows used, remaining, and limit, with a shortcut to compact
- Message queue: while the model is busy, the message waits; each item can be Cancel or Steer (send now, before the model's turn)
- Delivery button in the composer: automatic (respects work in progress), now (cuts the model's turn), or queued
- Attachments: drag files or folders into the window or use the composer clip; folders work (the server expands content). In Parallel, dropping onto a card attaches to it; outside cards, it goes to Focus
- Camera: locks automatic scrolling; each session and each Parallel card keeps its own. Scrolling up releases the camera
- Focus (chat): markdown, reasoning, and tools collapsed by default; long text truncated with "open to read"; agent and model switches via popover with search; token statistics (input/output/reasoning/cache), cost, directory, and session state; actions: interrupt, compact, fork, revert to a message, move to another directory, file diff, export, delete; permission prompts on the spot (Allow / Always / Deny); slash commands with autocomplete
- Parallel: pinned sessions with live streaming and a message field per card; each card has model switch, context circle, and interrupt button; drag the header to reorder and the bottom-right corner to resize (size and order are saved)
- Events: SSE stream log with stream status, reconnection counter, filter by type, and pause
- Tools with their own presentation: edit/patch (unified diff with @@ header, 3 lines of context, green/red background, +n -n chips), write (numbered content with new file chip), read (real file line numbering), shell (command with ❯ and output block), grep (occurrence counter)
- Effort / thinking: levels none (disables reasoning) to max; changing the level switches the model variant
- Links open in the default browser; cited folders become clickable and open Explorer at the exact folder
- Composer drafts in localStorage: not lost when switching model, session, configuration, or view; each Parallel card has its own
- Settings in four sections: OpenCode Service (real status, toggle auto-start, connect, restart, stop), Appearance (9 themes, 6 accent colors, text size, round verbosity), Behavior (subagents in list, mark as seen, text cutoff, tool output limit, listed session count), Data (refresh, directory changes, clear preferences)
- Environment tab: session context (items, type, tokens, cost, compaction summary), MCP servers (connected and failures), saved permissions (with a revoke button per rule), configuration (section names, never values)
- In-session search with hit/total counter
- Subagents panel above the composer (and compact version on Parallel cards) with agent, title, tokens, and time for each; click goes straight to the subagent conversation
- Compaction summary as a collapsible block in the chat (reason, tokens, lines, markdown inside)
- Warnings: provider retry (429 or endpoint down), unhandled events (with received JSON on click), reasoning-only mode (warning on screen)
- Background service: the app starts OpenCode by itself when opening, with no console window

## Stack

- Frontend: vanilla JavaScript, no framework and no build step (dist/app.js, dist/styles.css, dist/index.html); @tauri-apps/api vendored in dist/tauri-api/
- Backend: Rust with Tauri v2 (src-tauri/src/main.rs: Tauri commands, SSE event loop; src-tauri/src/api.rs: HTTP client); dependencies reqwest, tokio, serde, base64
- Communication with OpenCode: HTTP Basic (opencode:<password>), x-opencode-directory header on every call, SSE on /api/event
- Runtime: WebView2 (Windows 10/11)
- Build: npx tauri build generates src-tauri\target\release\megaagt.exe (about 1 minute 30)

## How it works

The Rust backend reads ~/.local/state/opencode/service.json (URL and password) and authenticates with HTTP Basic (opencode:<password>). The working directory is sent in the x-opencode-directory header on every call, so OpenCode resolves commands, skills, and project context. One task consumes the SSE /api/event and republishes each event as oc-event; the connection has no timeout and reconnects with short backoff because the server closes idle connections. The "running" state is reconciled via GET /api/session/active, the authoritative source. When the service record does not exist, the app starts the service itself (opencode service start, with CREATE_NO_WINDOW, no console window); in npm installations the real executable is looked up inside the CLI's node_modules, since there is no opencode.exe — only .cmd and .ps1 shims.

## How to run

Requirements: Windows 10/11 with WebView2, Rust MSVC toolchain, Node.js 18+, OpenCode CLI v2 installed and in PATH.

Development:

```
npm install
npx tauri dev
```

Build:

```
npx tauri build
```

Generates src-tauri\target\release\megaagt.exe (about 1 minute 30). Then copy it to the desktop — the .exe is locked while the app is running; close MegaAGT before copying:

```
Copy-Item src-tauri\target\release\megaagt.exe "C:\Users\Kelvin\Desktop\MegaAGT.exe" -Force
```

The icon comes from app-icon.svg. After changing the icon:

```
npx tauri icon app-icon.svg
```

## Project structure

```
MegaAGT/
├── dist/                  frontend vanilla JS (app.js, styles.css, index.html, tauri-api/)
├── src-tauri/
│   ├── src/main.rs        Tauri commands, SSE event loop, Windows helpers
│   ├── src/api.rs         HTTP client with OpenCode (service discovery and startup)
│   ├── Cargo.toml         megaagt package
│   └── tauri.conf.json    productName MegaAGT, identifier dev.opencode.hub
├── app-icon.svg           application icon
├── CONTEXTO.md            maintenance document (architecture, API contract, pitfalls, test harness)
├── HERMES.md              unimplemented plan for a second tab with the Hermes Agent
├── package.json
└── package-lock.json
```

## Trade-offs and decisions

- Vanilla JS frontend, no framework: no build step; the whole app is three files that open in any text editor
- Rust only as an HTTP bridge: all presentation is JS, testable without recompiling; the most complex Rust command is opening a folder
- Client-side sorting: the API is incompatible with order together with cursor (InvalidCursorError)
- Actions only in the ⋯ menu: a header with six buttons becomes a wall
- Effort is the model variant: that is how OpenCode models reasoning; there is no separate endpoint
- No new crate for opening external links: rundll32 handles it; shell-open would pull a dependency tree
- Cutoff mask instead of gradient: an overlay always covers text; the mask sits in the padding, in the empty space
- Clickable folders with an explicit scanner instead of generic linkify: pure regex fails both ways (cuts paths with spaces and swallows the adjacent sentence)
- SSE without timeout: the server closes idle connections after about five seconds; fast reconnection is normal behavior, not a bug

## Known limitations

- Windows 10/11 with WebView2 only
- Requires OpenCode CLI v2 installed and in PATH; the app calls opencode service start
- npm installation: there is no opencode.exe, only .cmd and .ps1 shims; Windows does not resolve shims when spawning, so the app looks up the real executable inside the CLI's node_modules
- If service.json exists but the process died (computer rebooted, for example), the read passes and the app only tries to reconnect; you must click to start or open the CLI once
- The diff engine, above about 4 million cells (~2000 x 2000), falls back to "remove all / add all" instead of running out of memory; at most 400 lines of code displayed per block
- GET /api/session?search= matches content, not title; do not delete sessions in a loop by search
- Models that answer HTTP 402 (Insufficient account funds) are a transient error

## License

MIT — see the repository.

## Author

Kelvin Oliveira — https://github.com/KelvinOliveiraCode · https://kelvinoliveiracode.github.io/portfolio/
