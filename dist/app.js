/* ============================================================
   OpenCode Hub — frontend
   Contrato de dados (OpenCode v2):
     sessão  { id, title, agent, model{providerID,id,variant}, parentID, outcome,
               cost, tokens{input,output,reasoning,cache{read,write}},
               time{created,updated,idle,viewed}, location{directory}, projectID }
     mensagem{ id, time, type: user|assistant|system|skill|shell|synthetic|idle|
                        agentSelected|locationSwitched|compaction, ... }
       user       -> text
       assistant  -> content[] (text | reasoning | tool)
   Eventos: session.{reasoning,text}.{started,delta,ended} com `ordinal`,
            session.tool.{input.started,input.ended,called,success,error},
            session.step.*, session.usage.updated, session.idle, session.error.
   ============================================================ */

import { invoke } from "./tauri-api/core.js";
import { listen } from "./tauri-api/event.js";

/* ---------------- IPC ---------------- */
async function api(cmd, args = {}) {
  try {
    return await invoke(cmd, args);
  } catch (e) {
    throw new Error((e && e.message) || String(e));
  }
}

/* ---------------- constantes ---------------- */
const THEMES = [
  ["meia-noite", "Meia-Noite"],
  ["claro", "Claro"],
  ["nord", "Nord"],
  ["dracula", "Dracula"],
  ["solarizado", "Solarizado"],
  ["monokai", "Monokai"],
  ["terminal", "Terminal"],
  ["contraste", "Alto Contraste"],
  ["por-do-sol", "Por do Sol"],
];
const ACCENTS = [
  ["indigo", "#6b7cff"],
  ["cyan", "#2a9fd6"],
  ["green", "#2ba36b"],
  ["amber", "#c07c1e"],
  ["rose", "#d1457a"],
  ["violet", "#8b5cd6"],
];

const CLAMP_PX = 340; // altura acima da qual o texto do assistente e' recolhido
const OUT_CHARS = 1600; // limite de exibicao de saída de ferramenta

/* ---------------- persistencia ---------------- */
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem("hub." + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("hub." + k, JSON.stringify(v));
    } catch {}
  },
};

/* ---------------- estado ---------------- */
const state = {
  view: store.get("view", "foco"),
  theme: store.get("theme", "meia-noite"),
  accent: store.get("accent", null),
  think: store.get("think", true),
  directory: store.get("directory", null),
  pins: store.get("pins", []),
  selectedId: store.get("selectedId", null),

  sessions: [],
  messages: {}, // sid -> array
  live: {}, // sid -> Map(msgId -> {reasoning:Map, texts:Map, tools:Map})
  busy: {}, // sid -> bool
  usage: {}, // sid -> {cost, tokens} atualizado por session.usage.updated

  models: [],
  agents: [],
  commands: [],
  projects: [],
  permissions: {}, // sid -> array

  search: "",
  showSubs: store.get("showSubs", false),
  sidebarCollapsed: store.get("sidebarCollapsed", false),
  listLimit: 300,
  selectMode: false,
  selected: new Set(),
  expanded: {}, // chave -> bool (partes abertas)
  expandedKids: new Set(),
  subagentsAll: false,
  diffs: {},

  events: [],
  eventFilter: "",
  eventPaused: false,
  stream: { state: "connecting", attempt: 0, reconnects: 0, since: 0 },
  lastEventAt: 0,

  viewRoot: null,
};

/* ---------------- DOM ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "text") n.textContent = v;
    else if (k === "style") n.setAttribute("style", v);
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return n;
}

function icon(id, cls) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  if (cls) svg.setAttribute("class", cls);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#" + id);
  svg.appendChild(use);
  return svg;
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/* ---------------- avisos ---------------- */
/**
 * Extrai mensagem legivel de um erro do OpenCode.
 * O formato real e' `{ type, message, status, response }` — sem o envelope
 * `data`, que e' o que fazia a UI mostrar apenas "erro".
 */
function errorText(err, fallback = "erro") {
  if (!err) return fallback;
  if (typeof err === "string") return err;
  return err.message || err.data?.message || err.name || fallback;
}

/** Linha de erro com HTTP/status quando disponível. */
function errorBlock(err) {
  const status = err?.status;
  return el("div", { class: "msg-note", style: "color:var(--err);align-items:flex-start" },
    icon("i-alert"),
    el("span", { class: "grow" },
      el("div", { text: errorText(err) }),
      status || err?.type
        ? el("div", { class: "dim", style: "font-size:10.5px", text: [status ? `HTTP ${status}` : null, err?.type].filter(Boolean).join(" · ") })
        : null
    )
  );
}

function toast(msg, kind = "") {
  const t = el("div", { class: "toast " + kind });
  // a mensagem vai em um no' proprio: assim o gap do flex vale mesmo quando
  // ha um botao de acao ao lado
  t.appendChild(el("span", { class: "grow", text: msg }));
  $("#toastRoot").appendChild(t);
  setTimeout(() => t.remove(), kind === "err" ? 6500 : 3600);
  return t;
}
function fail(e) {
  console.error(e);
  toast(e && e.message ? e.message : String(e), "err");
}

/* ---------------- links ---------------- */
/**
 * Links de respostas vao para o navegador padrão.
 * O WebView2 do Tauri nao navega para fora, entao delegamos ao sistema —
 * e cancelamos a navegacao para o app nao tentar abrir por cima.
 */
function isExternalUrl(url) {
  return /^(https?:|mailto:)/i.test(String(url || "").trim());
}
document.addEventListener("click", (e) => {
  const a = e.target instanceof Element ? e.target.closest("a[href], a[data-path]") : null;
  if (!a) return;

  // pasta citada na resposta -> abre no Explorador de Arquivos
  const dir = a.getAttribute("data-path");
  if (dir) {
    e.preventDefault();
    e.stopPropagation();
    api("open_folder", { path: dir }).catch((err) => toast(err?.message || String(err), "err"));
    return;
  }

  const href = a.getAttribute("href") || "";
  if (!isExternalUrl(href)) return;
  e.preventDefault();
  e.stopPropagation();
  api("open_external", { url: href }).catch((err) => toast(err?.message || String(err), "err"));
});

function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return "agora";
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  if (s < 2592000) return `${Math.round(s / 86400)} d`;
  return new Date(ts).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
function fmtClock(ts) {
  if (!ts) return "--:--:--";
  return new Date(ts).toLocaleTimeString("pt-BR", { hour12: false });
}
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(".", ",") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(".", ",") + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace(".", ",") + "k";
  return n.toLocaleString("pt-BR");
}
function fmtCost(v) {
  const n = Number(v) || 0;
  return n < 0.01 ? "$" + n.toFixed(4) : "$" + n.toFixed(3);
}
function shortPath(p) {
  if (!p) return "";
  const home = "C:\\Users\\Kelvin";
  let s = String(p);
  if (s.toLowerCase().startsWith(home.toLowerCase())) s = "~" + s.slice(home.length);
  return s;
}
function lastSegment(p) {
  const parts = String(p || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || String(p || "");
}

/**
 * Alguns campos de texto chegam com sequencias de escape literais
 * ("a\nb" em vez de quebra real). Converte quando o texto nao contem
 * nenhuma quebra real — caso contrario e' conteudo legitimo.
 */
function normalizeText(t) {
  if (typeof t !== "string") return t == null ? "" : String(t);
  let s = t;
  if (s.includes("\\n") && !s.includes("\n")) {
    s = s.replace(/\\r\\n|\\r|\\n/g, "\n").replace(/\\t/g, "\t");
  }
  return s;
}

/**
 * Chave de busca insensivel a pontuacao: o usuário digita "ling-3.1-flash"
 * mas o modelo se chama "Ling 3.1 Flash Free". Comparando so' letras e
 * numeros os dois casam.
 */
function searchKey(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}
function matchesModel(m, q) {
  if (!q) return true;
  return searchKey(m.name).includes(q) || searchKey(m.providerID).includes(q) || searchKey(m.modelID).includes(q);
}

function modelKey(m) {
  if (!m) return "";
  const id = m.modelID || String(m.id || "").split("/").pop();
  const base = `${m.providerID || ""}/${id}`;
  return m.variant ? `${base}#${m.variant}` : base;
}
/**
 * Chave sem a variante. `modelKey` inclui o `#variante` quando existe, e o
 * catalogo de /api/model nunca traz variante — comparar as duas coisas
 * direto nunca casaria.
 */
function modelBaseKey(m) {
  return modelKey(m).split("#")[0];
}
/** Variantes de um modelo, tolerando entrada como string ou objeto. */
function modelVariants(m) {
  const lista = m?.variants || [];
  return [...new Set(lista.map((v) => (typeof v === "string" ? v : v?.id)).filter(Boolean))];
}
function modelName(m) {
  if (!m) return "";
  const id = m.modelID || String(m.id || "").split("/").pop();
  return m.name || id || "?";
}
function agentLabel(a) {
  if (!a) return "";
  return a.name || a.id || "";
}

/* ---------------- markdown ---------------- */
/**
 * Reconhece pastas do Windows a partir de um indice.
 *
 * Uma regex pura errava nos dois sentidos: cortava "C:\Meus Documentos\x"
 * no primeiro espaco e, no lado POSIX, engolia a frase inteira. Aqui as
 * regras sao explicitas:
 *  - espacos valem nos segmentos INTERMEDIARIOS;
 *  - o ultimo segmento para no primeiro espaco, senao "rodei em C:\app
 *    aqui" viraria "C:\app aqui".
 */
function matchWinPath(text, start) {
  const base = /^(?:[A-Za-z]:\\|\\\\)/.exec(text.slice(start));
  if (!base) return null;
  let i = start + base[0].length;
  let end = i;
  const stop = /[<>"\x60\r\n]/;
  while (i < text.length) {
    let seg = "";
    while (i < text.length && !/[\/\\]/.test(text[i]) && !stop.test(text[i])) seg += text[i++];
    if (!seg.trim()) break;
    if (/[\/\\]/.test(text[i] || "")) {
      i++;
      end = i;
      continue;
    }
    const corte = seg.search(/\s/);
    let ultimo = corte >= 0 ? seg.slice(0, corte) : seg;
    ultimo = ultimo.replace(/[.,;:!?)\]}]+$/, "");
    if (!ultimo) break;
    end = i - seg.length + ultimo.length;
    break;
  }
  return end > start + base[0].length ? text.slice(start, end) : null;
}

/** Caminho POSIX sem espacos, para nao engolir a frase vizinha. */
const POSIX_PATH = /(?<![\w/.\-])\/(?:[\w.@%+-]+\/)+[\w.@%+-]*/g;

function pathTag(p) {
  return `<a class="fs-path" data-path="${esc(p)}" title="Abrir pasta">${esc(p)}</a>`;
}

function linkifyPaths(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const janela = text.slice(i, i + 3);
    const inicio = /[A-Za-z]:\\/.test(janela) ? i : /\\\\/.test(text.slice(i, i + 2)) ? i : -1;
    if (inicio > -1 && (i === 0 || !/[\w\\/]/.test(text[i - 1]))) {
      const hit = matchWinPath(text, i);
      if (hit) {
        out += pathTag(hit);
        i += hit.length;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out.replace(POSIX_PATH, (p) => pathTag(p));
}


function inline(src) {
  const codes = [];
  let s = String(src).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  s = linkifyPaths(s);
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<b><i>$1</i></b>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, "$1<i>$2</i>");
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  return s;
}

function md(src) {
  if (src == null) return "";
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  const flushPara = (buf) => {
    if (buf.length) out.push(`<p>${inline(buf.join("\n"))}</p>`);
    return [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // cerca de código
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
    if (fence) {
      const marker = fence[1][0];
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) buf.push(lines[i++]);
      i++;
      const lang = fence[2] ? ` data-lang="${esc(fence[2])}"` : "";
      const nums = buf
        .map((t, k) => `<div class="ln"><span class="n">${k + 1}</span><span class="tx">${esc(t)}</span></div>`)
        .join("");
      out.push(`<div class="code fence"${lang}><div class="code-scroll">${nums}</div></div>`);
      continue;
    }

    // linha em branco
    if (!line.trim()) {
      i++;
      continue;
    }

    // título
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = Math.min(h[1].length + 1, 5);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // separador
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // citacao
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${md(buf.join("\n"))}</blockquote>`);
      continue;
    }

    // tabela
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const cells = (l) =>
        l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
      const head = cells(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
          `</tbody></table>`
      );
      continue;
    }

    // listas (com um nível de indentacao)
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const base = li[1].length;
      const ordered = /\d/.test(li[2]);
      let items = [];
      const flush = () => {
        if (!items.length) return;
        const tag = ordered ? "ol" : "ul";
        out.push(`<${tag}>${items.join("")}</${tag}>`);
        items = [];
      };
      const appendToLast = (html) => {
        if (items.length) items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, html + "</li>");
        else items.push(`<li>${html}</li>`);
      };
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) {
          // continuacao do item anterior (linha indentada sem marcador)
          const indent = lines[i].match(/^\s*/)[0].length;
          if (lines[i].trim() && indent >= base && items.length) {
            appendToLast(" " + inline(lines[i].trim()));
            i++;
            continue;
          }
          break;
        }
        if (m[1].length < base) break;
        if (m[1].length > base) {
          // subitem: renderiza como lista aninhada dentro do ultimo item
          const sub = [];
          while (i < lines.length) {
            const sm = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
            if (!sm || sm[1].length <= base) break;
            sub.push(sm[3]);
            i++;
          }
          if (sub.length) appendToLast(md(sub.map((t) => "- " + t).join("\n")));
          continue;
        }
        items.push(`<li>${inline(m[3])}</li>`);
        i++;
      }
      flush();
      continue;
    }

    // paragrafo
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(`{3,}|~{3,})/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(lines[i]) &&
      !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    // em prosa de chat, quebra simples vira quebra visual
    out.push(`<p>${inline(buf.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }
  return out.join("");
}

/* ============================================================
   Dados
   ============================================================ */
function sessionById(id) {
  return state.sessions.find((s) => s.id === id) || null;
}
function childrenOf(pid) {
  return state.sessions.filter((s) => s.parentID === pid);
}
function descendantIds(pid) {
  const ids = new Set();
  const walk = (p) => {
    for (const c of childrenOf(p)) {
      if (ids.has(c.id)) continue;
      ids.add(c.id);
      walk(c.id);
    }
  };
  walk(pid);
  return ids;
}
function orchestrations() {
  const byParent = new Map();
  for (const s of state.sessions) {
    if (!s.parentID) continue;
    if (!byParent.has(s.parentID)) byParent.set(s.parentID, []);
    byParent.get(s.parentID).push(s);
  }
  return [...byParent.entries()]
    .map(([pid, kids]) => ({
      pid,
      kids: kids.sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0)),
      parent: sessionById(pid),
      updated: Math.max(...kids.map((k) => k.time?.updated || 0)),
    }))
    .sort((a, b) => b.updated - a.updated);
}
function isBusy(sid) {
  return !!state.busy[sid];
}
function sessionState(s) {
  if (!s) return "idle";
  if (s.time?.idle && !isBusy(s.id)) return s.outcome || "idle";
  return isBusy(s.id) ? "running" : s.outcome || "idle";
}
function statsOf(s) {
  const u = state.usage[s.id];
  return {
    tokens: u?.tokens || s.tokens || {},
    cost: u?.cost ?? s.cost ?? 0,
  };
}

let refreshingSessions = false;
async function refreshSessions() {
  if (refreshingSessions) return;
  refreshingSessions = true;
  try {
    const r = await api("list_sessions");
    const prev = state.sessions;
    state.sessions = r?.data || [];
    // ids que sumiram da lista foram removidos (ou trocaram de projeto)
    for (const id of [...state.selected]) {
      if (!state.sessions.some((s) => s.id === id)) state.selected.delete(id);
    }
    let selectionChanged = false;
    if (state.selectedId && !state.sessions.some((s) => s.id === state.selectedId)) {
      state.selectedId = null;
      store.set("selectedId", null);
      selectionChanged = true;
    }
    // sem selecao (ou apos trocar de projeto), aponta para a mais recente em
    // vez de deixar a tela vazia
    if (!state.selectedId && state.sessions.length) {
      const top = [...state.sessions].sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))[0];
      if (top) {
        state.selectedId = top.id;
        store.set("selectedId", top.id);
        selectionChanged = true;
      }
    }
    if (selectionChanged && state.view === "foco") {
      // reconstrui a tela inteira: a sessão anterior nao pertence a este projeto
      state.messages[state.selectedId] = state.messages[state.selectedId] || [];
      renderView();
      refreshMessages(state.selectedId, { force: true }).then(renderMessages);
    }
    renderSidebar();
    updateCounts();
    if (state.view !== "foco" && sig(state.sessions) !== sig(prev)) renderView();
    else if (state.view === "foco" && !selectionChanged) renderSessionHeader();
  } catch (e) {
    console.error(e);
  } finally {
    refreshingSessions = false;
  }
}

/** `/api/session/active` e' a fonte autoritativa do que esta rodando. */
async function refreshActive() {
  try {
    const r = await api("active_sessions");
    const map = r?.data || {};
    const running = new Set(Object.keys(map));
    for (const sid of Object.keys(state.busy)) {
      if (state.busy[sid] && !running.has(sid)) state.busy[sid] = false;
    }
    let changed = false;
    for (const sid of running) {
      if (!state.busy[sid]) {
        state.busy[sid] = true;
        changed = true;
      }
    }
    if (changed) {
      renderSidebar();
      if (state.view === "foco") renderSessionHeader();
      if (state.view === "paralelo") renderParalelo();
    }
  } catch {
    /* o endpoint e' opcional: o stream SSE continuadefinindo o estado */
  }
}
function sig(list) {
  return list.map((s) => `${s.id}:${s.time?.updated || 0}:${s.outcome || ""}`).join("|");
}

/**
 * Ordem cronologica: mais antiga em cima, mais nova embaixo.
 *
 * O backend ja pede `order=asc`, mas isso nao e' suficiente — respostas
 * paginadas ou um eco local inserido no meio podem sair fora de ordem, e o
 * sintoma (chat invertido) e' muito desconcertante. Ordenar aqui deixa a
 * invariante garantida em qualquer caminho.
 */
function chronological(list) {
  return [...(list || [])].sort((a, b) => {
    const ta = a?.time?.created ?? a?.time?.streamed ?? 0;
    const tb = b?.time?.created ?? b?.time?.streamed ?? 0;
    if (ta !== tb) return ta - tb;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

async function refreshMessages(sid, { force = false } = {}) {
  if (!sid) return [];
  if (!force && state.messages[sid]) return state.messages[sid];
  try {
    const r = await api("list_messages", { session_id: sid });
    // descarta o eco otimista: a mensagem real ja veio do servidor e mostra-la
    // junto com o eco duplica a mensagem do usuário
    state.messages[sid] = chronological((r?.data || []).filter((m) => !String(m.id || "").startsWith("local-")));
    return state.messages[sid];
  } catch (e) {
    console.error(e);
    state.messages[sid] = state.messages[sid] || [];
    return state.messages[sid];
  }
}

async function refreshMeta() {
  // cada chamada e' independente: uma falha nao pode derrubar as outras, mas
  // precisa ficar visivel no console em vez de sumir.
  const settle = async (cmd, pick) => {
    try {
      const r = await api(cmd);
      const v = pick(r);
      if (cmd === "list_agents" && !v.length) console.warn(cmd + ": servidor devolveu lista vazia");
      return v;
    } catch (e) {
      console.warn(cmd + " falhou: " + (e?.message || e));
      return [];
    }
  };
  const [models, agents, commands] = await Promise.all([
    settle("list_models", (r) => r?.data || []),
    settle("list_agents", (r) => r?.data || []),
    settle("list_commands", (r) => r?.data || []),
  ]);
  state.models = models;
  state.agents = agents;
  state.commands = commands;
}

async function refreshProjects() {
  try {
    const r = await api("list_projects");
    state.projects = (r?.data || []).map((p) => p.canonical).filter(Boolean);
  } catch {
    state.projects = [];
  }
}

/* ============================================================
   Camada live (streaming)
   ============================================================ */
function liveOf(sid) {
  if (!state.live[sid]) state.live[sid] = new Map();
  return state.live[sid];
}
function liveMsg(sid, mid) {
  const m = liveOf(sid);
  if (!m.has(mid)) m.set(mid, { reasoning: new Map(), texts: new Map(), tools: new Map() });
  return m.get(mid);
}
function clearLive(sid, mid) {
  if (sid && mid) {
    state.live[sid]?.delete(mid);
    if (state.live[sid]?.size === 0) delete state.live[sid];
  } else if (sid) {
    delete state.live[sid];
  } else {
    state.live = {};
  }
}

const refetchTimers = {};
const refetchTries = {};

/**
 * Refaz o histórico de uma sessão depois que o streaming termina.
 * Um overlay "live" orfao (quando o provedor falha, os eventos *.started
 * chegam mas os *.ended nunca chegam) mantinha a sessão presa em estado de
 * streaming e a mensagem final nunca aparecia. Por isso ha um limite de
 * tentativas: depois dele o overlay e' descartado de qualquer forma.
 */
function scheduleRefetch(sid) {
  clearTimeout(refetchTimers[sid]);
  refetchTimers[sid] = setTimeout(async () => {
    delete refetchTimers[sid];
    const orphan = state.live[sid]?.size || 0;
    if (orphan && (refetchTries[sid] || 0) < 6) {
      refetchTries[sid] = (refetchTries[sid] || 0) + 1;
      scheduleRefetch(sid);
      return;
    }
    delete refetchTries[sid];
    clearLive(sid);
    if (sid === state.selectedId) {
      await refreshMessages(sid, { force: true });
      renderMessages();
      renderSessionHeader();
      refreshPermissions(sid);
    }
    if (state.view === "paralelo") renderView();
    if (state.view === "subagentes") renderSubagentLists();
  }, 600);
}

/* ============================================================
   Stream de eventos
   ============================================================ */
async function connectEvents() {
  try {
    await listen("oc-stream", (e) => {
      try {
        const d = JSON.parse(e.payload);
        if (d.state === "connected") {
          state.stream.since = d.at;
          if (state.stream.state === "reconnecting") state.stream.reconnects++;
        }
        state.stream.state = d.state;
        state.stream.attempt = d.attempt;
        state.stream.detail = d.detail;
        updateEventStatus();
      } catch {}
    });
    await listen("oc-event", (e) => {
      if (state.eventPaused) return;
      try {
        handleEvent(JSON.parse(e.payload));
      } catch (err) {
        console.error(err);
      }
    });
  } catch (e) {
    toast("falha ao assinar o stream de eventos: " + e.message, "err");
  }
}

function toolOutputText(content) {
  if (content == null) return null;
  if (typeof content === "string") return normalizeText(content);
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (!c) return "";
        if (c.type === "text") return c.text || "";
        if (c.type === "file") return `[arquivo] ${c.name || c.uri || ""}`;
        return JSON.stringify(c);
      })
      .join("\n");
  }
  if (typeof content === "object") return JSON.stringify(content, null, 1);
  return String(content);
}

function handleEvent(ev) {
  const d = ev.data || {};
  const sid = d.sessionID;
  state.lastEventAt = Date.now();
  if (!state.stream.since) state.stream.since = state.lastEventAt;

  state.events.unshift({ t: ev.created || Date.now(), type: ev.type, sid, d, loc: ev.location?.directory });
  if (state.events.length > 500) state.events.length = 500;

  if (ev.type === "session.created" || ev.type === "session.updated" || ev.type === "session.deleted") {
    queueSessionRefresh();
  }

  if (ev.type === "server.connected") {
    updateEventStatus();
    return;
  }

  if (!sid) {
    updateEventStatus();
    return;
  }

  const mid = d.assistantMessageID;
  const ord = d.ordinal ?? 0;

  switch (ev.type) {
    case "session.reasoning.started":
    case "session.text.started": {
      state.busy[sid] = true;
      liveMsg(sid, mid);
      patchStream(sid, mid);
      break;
    }
    case "session.reasoning.delta": {
      state.busy[sid] = true;
      const lm = liveMsg(sid, mid);
      lm.reasoning.set(ord, (lm.reasoning.get(ord) || "") + (d.delta || ""));
      patchStream(sid, mid);
      break;
    }
    case "session.reasoning.ended": {
      const lm = liveMsg(sid, mid);
      if (typeof d.text === "string") lm.reasoning.set(ord, d.text);
      patchStream(sid, mid);
      scheduleRefetch(sid);
      break;
    }
    case "session.text.delta": {
      state.busy[sid] = true;
      const lm = liveMsg(sid, mid);
      lm.texts.set(ord, (lm.texts.get(ord) || "") + (d.delta || ""));
      patchStream(sid, mid);
      break;
    }
    case "session.text.ended": {
      const lm = liveMsg(sid, mid);
      if (typeof d.text === "string") lm.texts.set(ord, d.text);
      patchStream(sid, mid);
      scheduleRefetch(sid);
      break;
    }
    case "session.tool.input.started": {
      state.busy[sid] = true;
      const lm = liveMsg(sid, mid);
      lm.tools.set(d.id, { name: d.name, status: "streaming", input: null, output: null });
      patchStream(sid, mid);
      break;
    }
    case "session.tool.input.ended": {
      const lm = liveMsg(sid, mid);
      const t = lm.tools.get(d.id) || { name: "tool", status: "running" };
      t.input = parseMaybe(d.text);
      t.status = "running";
      lm.tools.set(d.id, t);
      patchStream(sid, mid);
      break;
    }
    case "session.tool.called": {
      state.busy[sid] = true;
      const lm = liveMsg(sid, mid);
      const t = lm.tools.get(d.id) || { name: d.name || "tool", status: "running" };
      if (d.name) t.name = d.name;
      if (d.input !== undefined) t.input = d.input;
      t.executed = d.executed;
      t.status = "running";
      lm.tools.set(d.id, t);
      patchStream(sid, mid);
      break;
    }
    case "session.tool.success": {
      const lm = liveMsg(sid, mid);
      const t = lm.tools.get(d.id) || { name: "tool", status: "completed" };
      t.status = "completed";
      t.output = toolOutputText(d.content ?? d.output);
      lm.tools.set(d.id, t);
      patchStream(sid, mid);
      scheduleRefetch(sid);
      break;
    }
    case "session.tool.error": {
      const lm = liveMsg(sid, mid);
      const t = lm.tools.get(d.id) || { name: "tool", status: "error" };
      t.status = "error";
      t.error = d.error;
      lm.tools.set(d.id, t);
      patchStream(sid, mid);
      scheduleRefetch(sid);
      break;
    }
    case "session.step.started": {
      state.busy[sid] = true;
      patchStream(sid, mid);
      break;
    }
    case "session.step.streamed":
    case "session.step.ended": {
      if (d.tokens || d.cost !== undefined) {
        state.usage[sid] = { tokens: d.tokens, cost: d.cost ?? state.usage[sid]?.cost ?? 0 };
        if (sid === state.selectedId) renderSessionHeader();
      }
      scheduleRefetch(sid);
      break;
    }
    case "session.usage.updated": {
      state.usage[sid] = { tokens: d.tokens, cost: d.cost ?? 0 };
      if (sid === state.selectedId) renderSessionHeader();
      break;
    }
    case "session.idle": {
      // a sessão terminou: o overlay live e' invalido por definicao
      clearLive(sid);
      delete refetchTries[sid];
      state.busy[sid] = false;
      scheduleRefetch(sid);
      queueSessionRefresh();
      markViewed(sid, d.idle);
      break;
    }
    case "session.error": {
      clearLive(sid);
      delete refetchTries[sid];
      state.busy[sid] = false;
      scheduleRefetch(sid);
      queueSessionRefresh();
      if (sid === state.selectedId) toast(errorText(d.error, "erro na sessão"), "err");
      break;
    }
    default:
      break;
  }

  updateEventStatus();
}

function parseMaybe(text) {
  if (text == null) return null;
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return normalizeText(text);
  }
}

function markViewed(sid, idle) {
  if (!idle) return;
  api("mark_viewed", { session_id: sid, idle }).catch(() => {});
}

/** Chave segura para seletores: ids sao [A-Za-z0-9_-], "|" so' dentro de string. */
const msgKey = (sid, mid) => `${sid}|${mid}`;

/** Atualiza so' o no' DOM da mensagem em streaming. */
function patchStream(sid, mid) {
  if (!mid) return;
  const node = document.querySelector(`[data-msg="${msgKey(sid, mid)}"]`);
  const live = state.live[sid]?.get(mid);
  if (node && live) {
    const body = $(".msg-body", node);
    if (body) {
      const fresh = buildBody(sid, { id: mid, type: "assistant", content: [] }, live, true);
      body.replaceWith(fresh);
      const sc = node.closest(".msg-scroll, .p-body");
      if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160) sc.scrollTop = sc.scrollHeight;
    }
    return;
  }
  if (sid === state.selectedId && state.view === "foco" && live) {
    appendStreaming(sid, mid, live);
    return;
  }
  if (state.view === "paralelo") {
    const card = document.querySelector(`.p-card[data-sid="${sid}"]`);
    const body = card && $(".p-body", card);
    if (body) {
      let inner = $(".msg-inner", body);
      if (!inner) {
        inner = el("div", { class: "msg-inner" });
        body.appendChild(inner);
      }
      let node = $(`[data-msg="${msgKey(sid, mid)}"]`, inner);
      if (!node) {
        node = el("div", { class: "msg assistant" });
        node.dataset.msg = msgKey(sid, mid);
        node.appendChild(el("div", { class: "msg-body" }));
        inner.appendChild(node);
      }
      const fresh = buildBody(sid, { id: mid, type: "assistant", content: [] }, live, true);
      $(".msg-body", node)?.replaceWith(fresh);
      if (body.scrollHeight - body.scrollTop - body.clientHeight < 160) body.scrollTop = body.scrollHeight;
    }
  }
}

/** Mensagem em streaming ainda nao presente no histórico. */
function appendStreaming(sid, mid, live) {
  const scroll = $("#msgScroll");
  if (!scroll) return;
  let inner = $(".msg-inner", scroll);
  if (!inner) {
    inner = el("div", { class: "msg-inner" });
    scroll.appendChild(inner);
  }
  const key = msgKey(sid, mid);
  let node = $(`[data-msg="${key}"]`, inner);
  if (!node) {
    node = el("div", { class: "msg assistant" });
    node.dataset.msg = key;
    inner.appendChild(node);
  }
  $(".msg-body", node)?.replaceWith(buildBody(sid, { id: mid, type: "assistant", content: [] }, live, true));
  scroll.scrollTop = scroll.scrollHeight;
}

let refreshQueued = false;
function queueSessionRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    refreshSessions();
  }, 800);
}

/* ============================================================
   Barra lateral
   ============================================================ */
function renderSidebar() {
  const list = $("#sessionList");
  const q = state.search.trim().toLowerCase();
  let items = [...state.sessions].sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
  if (q) {
    items = items.filter(
      (s) =>
        (s.title || "").toLowerCase().includes(q) ||
        (s.id || "").toLowerCase().includes(q) ||
        (s.agent || "").toLowerCase().includes(q)
    );
  }
  if (!state.showSubs) items = items.filter((s) => !s.parentID);

  list.textContent = "";

  if (!items.length) {
    list.appendChild(
      el("div", { class: "empty" },
        el("h3", { text: q ? "Nada encontrado" : "Nenhuma sessão" }),
        el("p", { text: q ? "Ajuste a busca." : "Crie uma sessão ou envie uma mensagem pelo CLI do OpenCode." })
      )
    );
    return;
  }

  const frag = document.createDocumentFragment();
  const LIMIT = state.listLimit;
  for (const s of items.slice(0, LIMIT)) frag.appendChild(sessionRow(s));
  list.appendChild(frag);

  if (items.length > LIMIT) {
    const more = el("button", { class: "ghost-btn", style: "width:100%;padding:8px" },
      el("span", { text: `Mostrar mais ${fmtNum(items.length - LIMIT)} (de ${fmtNum(items.length)})` }));
    more.onclick = () => {
      state.listLimit += 500;
      renderSidebar();
    };
    list.appendChild(more);
  }

  syncSelectionUi();
}

function sessionRow(s) {
  const subs = childrenOf(s.id).length;
  const outcome = sessionState(s);
  const pinned = state.pins.includes(s.id);
  const checked = state.selected.has(s.id);
  const row = el("div", {
    class: "s-item" + (s.id === state.selectedId ? " active" : "") + (pinned ? " pinned" : "") + (checked ? " checked" : ""),
    role: "option",
    "aria-selected": s.id === state.selectedId ? "true" : "false",
  });
  row.dataset.sid = s.id;

  if (state.selectMode) {
    const cb = el("input", { type: "checkbox", class: "s-sel", "aria-label": "Selecionar " + (s.title || s.id) });
    cb.checked = checked;
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => toggleSelect(s.id, cb.checked);
    row.appendChild(cb);
  } else {
    row.appendChild(el("span", { class: "s-dot " + outcome, title: outcome }));
  }

  const meta = el("div", { class: "s-meta" },
    el("span", { class: "grow", text: s.agent || "—" }),
    subs ? el("span", { class: "tag subs", text: `${subs} sub` }) : null,
    el("span", { class: "s-when", text: timeAgo(s.time?.updated) })
  );

  row.appendChild(
    el("div", { class: "s-main" },
      el("div", { class: "s-title", text: s.title || s.id, title: s.title || s.id }),
      meta
    )
  );

  if (!state.selectMode) {
    const tools = el("div", { class: "s-tools" });
    const pin = el("button", { class: "icon-btn" + (pinned ? " on" : ""), title: pinned ? "Desafixar do Paralelo" : "Fixar no Paralelo" });
    pin.appendChild(icon("i-pin"));
    pin.onclick = (e) => {
      e.stopPropagation();
      togglePin(s.id);
    };
    const del = el("button", { class: "icon-btn danger", title: "Excluir sessão" });
    del.appendChild(icon("i-trash"));
    del.onclick = (e) => {
      e.stopPropagation();
      confirmDelete([s.id]);
    };
    tools.append(pin, del);
    row.appendChild(tools);
  }

  row.onclick = (e) => {
    // Ctrl/Cmd + clique marca varias sessões sem sair da lista
    if (e.ctrlKey || e.metaKey) {
      if (!state.selectMode) {
        state.selectMode = true;
        renderSidebar();
        updateSelectionBar();
      }
      toggleSelect(s.id);
      return;
    }
    selectSession(s.id);
  };
  return row;
}

/** Liga/desliga a marcacao de uma sessão sem redesenhar a lista inteira. */
function toggleSelect(id, on) {
  const want = on === undefined ? !state.selected.has(id) : !!on;
  if (want) state.selected.add(id);
  else state.selected.delete(id);
  syncSelectionUi();
}

/** Reflete o estado de selecao nos itens ja desenhados e na barra. */
function syncSelectionUi() {
  const rows = $$(".s-item", $("#sessionList"));
  for (const row of rows) {
    const id = row.dataset.sid;
    const on = state.selected.has(id);
    const cb = $(".s-sel", row);
    if (cb) cb.checked = on;
    row.classList.toggle("checked", state.selectMode && on);
  }
  const all = $("#selectAll");
  if (all) {
    const vis = rows.map((n) => n.dataset.sid);
    const n = vis.filter((id) => state.selected.has(id)).length;
    all.checked = n > 0 && n === vis.length;
    all.indeterminate = n > 0 && n < vis.length;
  }
  updateSelectionBar();
}

function updateSelectionBar() {
  const n = state.selected.size;
  const count = $("#selectCount");
  if (count) count.textContent = n === 1 ? "1 selecionada" : `${n} selecionadas`;
  const btn = $("#deleteSelected");
  if (btn) {
    btn.disabled = n === 0;
    const label = $("span", btn);
    if (label) label.textContent = n === 0 ? "Excluir selecionadas" : `Excluir ${n} selecionada${n === 1 ? "" : "s"}`;
  }
  const bar = $("#selectBar");
  if (bar) bar.hidden = !state.selectMode;
  const sm = $("#selectModeBtn");
  if (sm) {
    sm.classList.toggle("on", state.selectMode);
    sm.textContent = state.selectMode ? "Concluir" : "Selecionar";
  }
  const st = $("#subsToggle");
  if (st) {
    st.classList.toggle("on", state.showSubs);
    st.title = state.showSubs ? "Ocultar sessões de subagentes" : "Mostrar também as sessões de subagentes";
  }
}

function updateCounts() {
  const pins = state.pins.filter((id) => state.sessions.some((s) => s.id === id));
  $("#paraleloCount").textContent = pins.length || "";
  $("#subCount").textContent = orchestrations().length || "";
  const total = state.sessions.length;
  const subs = state.sessions.filter((s) => s.parentID).length;
  $("#sideStats").textContent = `${total} sessões · ${subs} subagentes`;
}

function selectSession(id) {
  if (state.selectedId !== id) {
    state.selectedId = id;
    store.set("selectedId", id);
    if (state.view === "subagentes") renderView();
  }
  renderSidebar();
  renderView();
  refreshMessages(id).then(() => {
    renderMessages();
    refreshPermissions(id);
  });
  const s = sessionById(id);
  if (s?.time?.idle) markViewed(id, s.time.idle);
}

function togglePin(id) {
  const i = state.pins.indexOf(id);
  if (i >= 0) state.pins.splice(i, 1);
  else state.pins.push(id);
  store.set("pins", state.pins);
  renderSidebar();
  updateCounts();
  if (state.view === "paralelo" || state.view === "foco") renderView();
}

/* ============================================================
   Visao Foco
   ============================================================ */
function renderView() {
  const root = $("#viewRoot");
  state.viewRoot = root;
  if (state.view === "foco") renderFoco();
  else if (state.view === "paralelo") renderParalelo();
  else if (state.view === "subagentes") renderSubagentes();
  else if (state.view === "eventos") renderEventos();
  $$("#viewTabs .tab").forEach((t) => {
    const on = t.dataset.view === state.view;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (state.view === "foco") renderSessionHeader();
}

function focusShell() {
  const root = $("#viewRoot");
  root.textContent = "";
  const s = sessionById(state.selectedId);

  const head = el("div", { class: "f-head" });
  head.id = "sessionHead";
  const scroll = el("div", { class: "msg-scroll" }, el("div", { class: "msg-inner" }));
  scroll.id = "msgScroll";
  const perms = el("div", { id: "permBar" });
  perms.className = "hidden";
  const composer = buildComposer(s);
  root.append(head, perms, scroll, composer);
  renderMessages();
}

function renderFoco() {
  const root = $("#viewRoot");
  root.textContent = "";
  const s = sessionById(state.selectedId);
  if (!s) {
    root.appendChild(
      el("div", { class: "empty" },
        el("h3", { text: "Nenhuma sessão selecionada" }),
        el("p", { text: "Escolha uma sessão na barra lateral ou crie uma nova." }),
        el("button", { class: "btn primary", onclick: openNewSession, text: "Nova sessão" })
      )
    );
    return;
  }
  focusShell();
  refreshMessages(s.id).then(renderMessages);
}

function renderSessionHeader() {
  if (state.view !== "foco") return;
  const head = $("#sessionHead");
  const s = sessionById(state.selectedId);
  if (!head || !s) return;
  // nao reconstruir enquanto o título esta' sendo editado
  if (head.contains(document.activeElement)) return;

  const outcome = sessionState(s);
  const { tokens, cost } = statsOf(s);
  const subs = childrenOf(s.id).length;

  const title = el("div", { class: "f-title", contenteditable: "true", spellcheck: "false", title: "Clique para renomear" });
  title.textContent = s.title || s.id;
  let titleTimer;
  title.addEventListener("blur", () => {
    const v = title.textContent.trim();
    clearTimeout(titleTimer);
    if (v && v !== (s.title || "")) {
      titleTimer = setTimeout(async () => {
        try {
          await api("rename_session", { session_id: s.id, title: v });
          await refreshSessions();
          toast("Título atualizado", "ok");
        } catch (e) {
          fail(e);
        }
      }, 450);
    }
  });
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      title.blur();
    }
  });

  const stats = el("div", { class: "stats" });
  const add = (label, value) => {
    if (stats.childNodes.length) stats.appendChild(el("span", { class: "sep", text: "/" }));
    stats.appendChild(el("span", {}, document.createTextNode(label + " "), el("b", { text: value })));
  };
  add("in", fmtNum(tokens.input));
  add("out", fmtNum(tokens.output));
  if (tokens.reasoning) add("rac", fmtNum(tokens.reasoning));
  if (tokens.cache?.read) add("cache", fmtNum(tokens.cache.read));
  add("custo", fmtCost(cost));
  if (s.location?.directory) stats.appendChild(el("span", { class: "dim", text: shortPath(s.location.directory) }));

  head.textContent = "";
  head.append(
    el("div", { class: "f-row" },
      el("span", { class: "state-chip " + outcome, text: outcome }),
      title,
      el("button", { class: "btn", onclick: (e) => openModelPicker(e.currentTarget, s), title: "Trocar modelo" },
        icon("i-cpu"), el("span", { class: "nowrap", text: modelName(s.model) || "padrão" })),
      el("button", { class: "btn", onclick: (e) => openAgentPicker(e.currentTarget, s), title: "Trocar agente" },
        el("span", { class: "nowrap", text: s.agent || "padrão" })),
      // todas as ações ficam no menu, para nao repetir botoes na tela
      el("button", { class: "icon-btn", onclick: (e) => openSessionMenu(e.currentTarget, s), title: "Ações da sessão" }, icon("i-more"))
    ),
    el("div", { class: "f-row" },
      stats,
      subs ? el("span", { class: "tag subs", text: `${subs} subagentes` }) : null
    )
  );

  renderPermissions(s.id);
}

async function act(cmd, args, okMsg) {
  try {
    await api(cmd, args);
    if (okMsg) toast(okMsg, "ok");
    await refreshSessions();
    if (state.selectedId) await refreshMessages(state.selectedId, { force: true });
    renderView();
  } catch (e) {
    fail(e);
  }
}

/* ---------- permissoes ---------- */
async function refreshPermissions(sid) {
  if (!sid || !isBusy(sid)) {
    state.permissions[sid] = [];
    renderPermissions(sid);
    return;
  }
  try {
    const r = await api("session_permissions", { session_id: sid });
    state.permissions[sid] = r?.data || [];
  } catch {
    state.permissions[sid] = [];
  }
  renderPermissions(sid);
}

function renderPermissions(sid) {
  const bar = $("#permBar");
  if (!bar) return;
  const list = state.permissions[sid] || [];
  bar.textContent = "";
  if (!list.length) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  for (const p of list) {
    const res = (p.resources || []).join(", ");
    bar.appendChild(
      el("div", { class: "modal", style: "width:auto;max-width:560px;margin:8px auto;padding:12px 14px" },
        el("div", { class: "row" },
          icon("i-alert"),
          el("div", { class: "grow" },
            el("div", { style: "font-weight:600;font-size:13px", text: p.message || `Permissao: ${p.action}` }),
            el("div", { class: "dim mono", style: "font-size:11px", text: res })
          ),
          el("button", { class: "btn", onclick: () => replyPerm(sid, p, "reject") }, el("span", { text: "Negar" })),
          el("button", { class: "btn primary", onclick: () => replyPerm(sid, p, "once") }, el("span", { text: "Permitir" })),
          el("button", { class: "btn subtle", onclick: () => replyPerm(sid, p, "always") }, el("span", { text: "Sempre" }))
        )
      )
    );
  }
}

async function replyPerm(sid, p, decision) {
  try {
    await api("reply_permission", { session_id: sid, request_id: p.id, decision });
    state.permissions[sid] = (state.permissions[sid] || []).filter((x) => x.id !== p.id);
    renderPermissions(sid);
    toast("Permissao enviada", "ok");
  } catch (e) {
    fail(e);
  }
}

/* ============================================================
   Mensagens
   ============================================================ */
function renderMessages() {
  const scroll = $("#msgScroll");
  if (!scroll) return;
  const sid = state.selectedId;
  const msgs = state.messages[sid] || [];
  const inner = $(".msg-inner", scroll);
  inner.textContent = "";

  if (!msgs.length && !state.live[sid]?.size) {
    inner.appendChild(
      el("div", { class: "empty" },
        el("h3", { text: "Sessão vazia" }),
        el("p", { text: "Envie a primeira mensagem abaixo." })
      )
    );
    return;
  }

  let lastDay = "";
  for (const m of msgs) {
    const created = m.time?.created || 0;
    const day = created ? new Date(created).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" }) : "";
    if (day && day !== lastDay) {
      lastDay = day;
      inner.appendChild(el("div", { class: "msg-day", text: day }));
    }
    inner.appendChild(messageNode(sid, m));
  }

  // mensagens ainda em streaming que ainda nao chegaram no histórico
  for (const [mid, live] of state.live[sid] || []) {
    if (!msgs.some((m) => m.id === mid)) {
      inner.appendChild(messageNode(sid, { id: mid, type: "assistant", content: [], time: { created: Date.now() } }, live));
    }
  }

  scroll.scrollTop = scroll.scrollHeight;
  applyClamps(inner);
}

function messageNode(sid, m, live) {
  const type = m.type || "assistant";
  const node = el("div", { class: "msg " + (type === "user" ? "user" : type === "assistant" ? "assistant" : "meta") });
  node.dataset.msg = msgKey(sid, m.id);

  if (type !== "meta") {
    node.appendChild(
      el("div", { class: "msg-avatar", text: type === "user" ? "vo" : (m.agent || "ai").slice(0, 2).toLowerCase() })
    );
  }
  node.appendChild(buildBody(sid, m, live));
  return node;
}

function buildBody(sid, m, live, streaming = false) {
  const type = m.type || "assistant";
  const body = el("div", { class: "msg-body" });

  if (type === "user") {
    body.appendChild(el("div", { class: "msg-text", text: normalizeText(m.text || "") }));
    if (m.files?.length) {
      body.appendChild(el("div", { class: "dim", style: "font-size:11px;margin-top:4px", text: `${m.files.length} anexo(s)` }));
    }
    body.appendChild(messageActions(sid, m));
    return body;
  }

  if (type === "assistant") {
    const content = m.content || [];
    const reasoning = content.filter((p) => p.type === "reasoning");
    const texts = content.filter((p) => p.type === "text");
    const tools = content.filter((p) => p.type === "tool");

    if (state.think) {
      for (const p of reasoning) {
        const t = normalizeText(p.text || "");
        if (t) body.appendChild(blockThink(sid, m.id, t));
      }
    }
    if (live) {
      for (const t of live.reasoning.values()) {
        if (state.think && t) body.appendChild(blockThink(sid, m.id + ":live", t, true));
      }
    }

    let anyText = false;
    for (const p of texts) {
      const t = normalizeText(p.text || "");
      if (t.trim()) {
        anyText = true;
        body.appendChild(el("div", { class: "prose", html: md(t) }));
      }
    }
    if (live) {
      for (const t of live.texts.values()) {
        if (t) {
          anyText = true;
          body.appendChild(el("div", { class: "prose", html: md(normalizeText(t)) }));
        }
      }
    }
    if (!anyText && !tools.length && !reasoning.length && !streaming && !m.error) {
      if (m.finish && m.finish !== "stop") {
        body.appendChild(el("span", { class: "dim", style: "font-size:11.5px", text: `sem texto · finish: ${m.finish}` }));
      }
    }
    // O erro aparece sempre, mesmo com conteudo parcial: uma rodada que
    // falhou no meio (raciocínio parcial, algumas ferramentas) precisa dizer
    // o que deu errado, senao parece que o modelo simplesmente parou.
    if (m.error && !streaming) body.appendChild(errorBlock(m.error));

    for (const p of tools) body.appendChild(blockTool(sid, m.id, p));
    if (live) {
      for (const [tid, t] of live.tools) {
        body.appendChild(
          blockTool(sid, m.id, {
            type: "tool",
            id: tid,
            name: t.name,
            state: { status: t.status, input: t.input, content: t.output, error: t.error },
          }, true)
        );
      }
    }

    if (streaming) {
      body.appendChild(el("div", { class: "thinking-line" }, el("span", { class: "spin" }), el("span", { text: "processando" })));
    }

    if (m.snapshot?.files?.length) {
      body.appendChild(el("div", { class: "dim", style: "font-size:10.5px;margin-top:6px", text: `${m.snapshot.files.length} arquivo(s) no snapshot` }));
    }
    body.appendChild(messageActions(sid, m));
    return body;
  }

  // mensagens de metadados do sistema
  return el("div", { class: "msg-body" }, metaNote(m));
}

function metaNote(m) {
  const line = el("div", { class: "msg-note" });
  const add = (t) => line.append(el("span", { class: "tline" }), el("span", { text: t }));
  switch (m.type) {
    case "idle":
      line.append(icon("i-check"), el("span", { text: `ocioso · ${m.outcome || "—"}` }));
      break;
    case "system":
    case "synthetic":
      add(m.description || m.text || "sistema");
      break;
    case "skill":
      add(`skill ${m.name || m.skill}`);
      if (m.text) {
        const d = el("details", { class: "blk" });
        d.appendChild(el("summary", {}, icon("i-chev", "caret"), el("span", { class: "lbl", text: m.name || m.skill })));
        d.appendChild(el("div", { class: "blk-content" }, el("pre", { text: m.text })));
        return el("div", {}, line, d);
      }
      break;
    case "shell": {
      const d = el("details", { class: "blk" });
      d.appendChild(
        el("summary", {}, icon("i-chev", "caret"),
          el("span", { class: "lbl mono", text: `$ ${m.command || ""}` }),
          el("span", { class: "tstatus " + (m.status === "completed" ? "completed" : m.status === "error" ? "error" : "running"), text: m.status || "" })
        )
      );
      const c = el("div", { class: "blk-content" });
      if (m.output) c.appendChild(el("pre", { text: typeof m.output === "string" ? m.output : JSON.stringify(m.output, null, 1) }));
      d.appendChild(c);
      return d;
    }
    case "agentSelected":
      add(`agente ·  ${m.agent}`);
      break;
    case "modelSelected":
      add(`modelo ·  ${modelName(m.model)}`);
      break;
    case "locationSwitched":
      add(`diretório ·  ${shortPath(m.location?.directory || "")}`);
      break;
    case "compaction":
      add("contexto compactado");
      break;
    default:
      add(m.type || "mensagem");
  }
  return line;
}

function messageActions(sid, m) {
  const wrap = el("div", { class: "msg-foot" });

  const copy = el("button", { class: "icon-btn", title: "Copiar texto" });
  copy.appendChild(icon("i-copy"));
  copy.onclick = async () => {
    const t = m.type === "user" ? m.text : (m.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
    if (!t) return;
    await navigator.clipboard.writeText(t);
    toast("Copiado", "ok");
  };
  wrap.appendChild(copy);

  if (m.type === "user") {
    const undo = el("button", { class: "icon-btn", title: "Reverter ate aqui (remove as mensagens seguintes)" });
    undo.appendChild(icon("i-undo"));
    undo.onclick = () => revertTo(sid, m.id);
    wrap.appendChild(undo);
  }

  const fork = el("button", { class: "icon-btn", title: "Bifurcar a partir desta mensagem" });
  fork.appendChild(icon("i-branch"));
  fork.onclick = () => act("fork_session", { session_id: sid, before: m.id }, "Bifurcada");
  wrap.appendChild(fork);

  return wrap;
}

async function revertTo(sid, messageId) {
  if (!confirm("Reverter a sessão ate a mensagem escolhida? As mensagens seguintes serao descartadas.")) return;
  try {
    await api("stage_revert", { session_id: sid, message_id: messageId });
    await api("commit_revert", { session_id: sid });
    clearLive(sid);
    await refreshMessages(sid, { force: true });
    renderMessages();
    await refreshSessions();
    toast("Sessão revertida", "ok");
  } catch (e) {
    fail(e);
  }
}

/* ---------- blocos colapsaveis ---------- */
function blockKey(sid, mid, kind) {
  return `${sid}|${mid}|${kind}`;
}
function isOpen(key) {
  return !!state.expanded[key];
}

function blockThink(sid, mid, text, streaming = false) {
  const key = blockKey(sid, mid, "think");
  const d = el("details", { class: "blk think" });
  d.open = isOpen(key);
  const preview = text.replace(/\s+/g, " ").slice(0, 110);
  d.appendChild(
    el("summary", {},
      icon("i-chev", "caret"),
      icon("i-brain"),
      el("span", { class: "lbl", text: "Raciocínio" }),
      streaming ? el("span", { class: "spin" }) : null,
      el("span", { class: "hint", text: preview + (preview.length < text.replace(/\s+/g, " ").length ? "…" : "") })
    )
  );
  d.appendChild(el("div", { class: "blk-content" }, el("pre", { text })));
  d.addEventListener("toggle", () => {
    if (d.open) state.expanded[key] = true;
    else delete state.expanded[key];
  });
  return d;
}

/* ---------------- leitura de codigo ---------------- */
const MAX_DIFF_CELLS = 4e6; // ~2000x2000: acima disso cai para troca em bloco

/** Diff de linhas por LCS. Devolve [{k:"eq"|"add"|"del", t}] */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_DIFF_CELLS) {
    return [...a.map((t) => ({ k: "del", t })), ...b.map((t) => ({ k: "add", t }))];
  }
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ k: "eq", t: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push({ k: "del", t: a[i++] });
    else out.push({ k: "add", t: b[j++] });
  }
  while (i < n) out.push({ k: "del", t: a[i++] });
  while (j < m) out.push({ k: "add", t: b[j++] });
  return out;
}

/**
 * Une o diff em blocos com contexto, no formato `@@ -a,b +c,d @@`.
 * Sem contexto e' impossivel ler qual linha do arquivo mudou.
 */
function diffHunks(rows, ctx = 3) {
  const isChange = rows.map((r) => r.k !== "eq");
  const keep = new Array(rows.length).fill(false);
  rows.forEach((_, idx) => {
    if (!isChange[idx]) return;
    for (let j = Math.max(0, idx - ctx); j <= Math.min(rows.length - 1, idx + ctx); j++) keep[j] = true;
  });

  let oldN = 0;
  let newN = 0;
  const nums = rows.map((r) => {
    if (r.k === "add") return [null, ++newN];
    if (r.k === "del") return [++oldN, null];
    return [++oldN, ++newN];
  });

  const hunks = [];
  let i = 0;
  while (i < rows.length) {
    if (!keep[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && keep[j]) j++;
    const slice = [];
    let add = 0;
    let del = 0;
    for (let k = i; k < j; k++) {
      slice.push({ k: rows[k].k, t: rows[k].t, n: nums[k] });
      if (rows[k].k === "add") add++;
      else if (rows[k].k === "del") del++;
    }
    // cabecalho no formato unificado: as contagens sao de linhas de cada lado,
    // e o inicio de um lado vem da linha do outro quando o hunk abre nele.
    const velhos = slice.filter((r) => r.n[0] != null);
    const novos = slice.filter((r) => r.n[1] != null);
    const iniV = velhos.length ? velhos[0].n[0] : novos[0].n[1] - 1;
    const iniN = novos.length ? novos[0].n[1] : velhos[0].n[0] - 1;
    hunks.push({
      head: `@@ -${iniV},${velhos.length} +${iniN},${novos.length} @@`,
      rows: slice,
      add,
      del,
    });
    i = j;
  }
  return hunks;
}

/** Numero de linhas Display: quem mudou, quanto. */
function diffStat(rows) {
  let add = 0;
  let del = 0;
  for (const r of rows) {
    if (r.k === "add") add++;
    else if (r.k === "del") del++;
  }
  return { add, del };
}

const MAX_CODE_ROWS = 400;

/**
 * Constroi o visualizador de codigo: numero de linha na coluna da esquerda,
 * linhas longas com rolagem horizontal (a coluna fica parada).
 */
function codeDom(rows, { diff = false, start = 1 } = {}) {
  const box = el("div", { class: "code" + (diff ? " diff" : "") });
  const scroll = el("div", { class: "code-scroll" });
  const limit = Math.min(rows.length, MAX_CODE_ROWS);
  for (let k = 0; k < limit; k++) {
    const r = rows[k];
    const isHunk = typeof r === "string";
    const ln = el("div", { class: "ln" + (isHunk ? " hunk" : " " + (r.k || "")) });
    if (isHunk) {
      ln.appendChild(el("span", { class: "n", text: "" }));
      ln.appendChild(el("span", { class: "tx", text: r }));
    } else {
      const marca = r.k === "add" ? "+" : r.k === "del" ? "-" : "";
      const num = r.n ? (r.n[0] ?? r.n[1]) : start + k;
      ln.appendChild(el("span", { class: "n", text: marca + num }));
      ln.appendChild(el("span", { class: "tx", text: r.t }));
    }
    scroll.appendChild(ln);
  }
  box.appendChild(scroll);
  if (rows.length > limit) {
    box.appendChild(el("div", { class: "code-more", text: `… mais ${fmtNum(rows.length - limit)} linhas` }));
  }
  return box;
}

/** Codigo com numeros de linha, sem diff. */
function codeFromText(text, start = 1) {
  return String(text).replace(/\r\n?/g, "\n").split("\n").map((t) => ({ t }));
}

/** Reconhece o formato do `read`: "1690:  codigo". */
function readLines(text) {
  const out = [];
  for (const linha of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const m = linha.match(/^\s*(\d+): ?(.*)$/);
    if (m) out.push({ n: +m[1], t: m[2] });
    else if (out.length) out.push({ n: null, t: linha });
  }
  return out;
}

/** Cabecalho de resultado que o OpenCode emite antes do corpo. */
function readHeader(text) {
  const m = String(text).match(/^Read file (.+?), lines (\d+)-(\d+)/);
  if (!m) return null;
  return { path: m[1], from: +m[2], to: +m[3] };
}

/* ---------------- apresentacao das ferramentas ---------------- */
const TOOL_STYLE = {
  edit: { ic: "i-pen", lbl: "editar", kind: "diff" },
  patch: { ic: "i-pen", lbl: "editar", kind: "diff" },
  multiedit: { ic: "i-pen", lbl: "editar", kind: "diff" },
  write: { ic: "i-file-plus", lbl: "criar", kind: "write" },
  create: { ic: "i-file-plus", lbl: "criar", kind: "write" },
  read: { ic: "i-file", lbl: "ler", kind: "read" },
  shell: { ic: "i-term", lbl: "shell", kind: "shell" },
  bash: { ic: "i-term", lbl: "shell", kind: "shell" },
  exec: { ic: "i-term", lbl: "shell", kind: "shell" },
  grep: { ic: "i-search", lbl: "buscar", kind: "grep" },
  glob: { ic: "i-search", lbl: "listar", kind: "raw" },
  list: { ic: "i-list", lbl: "listar", kind: "raw" },
  webfetch: { ic: "i-globe", lbl: "baixar", kind: "raw" },
  task: { ic: "i-cpu", lbl: "subagente", kind: "raw" },
};

const baseName = (p) => String(p || "").split(/[\\/]/).pop() || String(p || "");

/**
 * Encurta pelo meio: num caminho longo o que importa e o fim (o nome do
 * arquivo), nao o comeco.
 */
function trimMid(s, max = 62) {
  s = String(s || "");
  if (s.length <= max) return s;
  const corte = Math.ceil((s.length - max + 1) / 2);
  return "…" + s.slice(corte, corte + max - 1);
}

/** Titulo de uma linha: arquivo + onde, ou o comando. */
function toolSubject(name, st) {
  const inp = st.input || {};
  const out = toolOutputText(st.content ?? st.output);
  if (inp.path) {
    if (name === "read") {
      const h = readHeader(out || "");
      return h ? `${baseName(inp.path)} · linhas ${h.from}–${h.to}` : baseName(inp.path);
    }
    if (name === "grep") return `${inp.pattern} · ${baseName(inp.path)}`;
    return trimMid(shortPath(inp.path));
  }
  if (inp.command) {
    const c = String(inp.command).replace(/\s+/g, " ").trim();
    return c.length > 90 ? c.slice(0, 88) + "…" : c;
  }
  if (inp.pattern) return String(inp.pattern);
  if (inp.url) return String(inp.url);
  if (inp.description) return String(inp.description);
  return "";
}

/**
 * Corpo especifico da ferramenta. Devolve null quando nao ha nada
 * especifico — o chamador cai no formato generico entrada/saida.
 */
function toolBody(name, st) {
  const inp = st.input || {};
  const out = toolOutputText(st.content ?? st.output);
  const kind = (TOOL_STYLE[name] || {}).kind || "raw";

  if (kind === "write") {
    // arquivo novo: nao ha "antes", entao um diff inteiro ficaria verde.
    // O conteudo e o que interessa, com numeracao de linha.
    const texto = String(inp.content ?? inp.newString ?? "");
    if (!texto) return null;
    const linhas = texto.split("\n");
    const wrap = el("div", { class: "tool-diff" });
    wrap.appendChild(
      el("div", { class: "diff-bar" },
        el("span", { class: "chip add", text: `+${linhas.length}` }),
        el("span", { class: "chip muted", text: `arquivo novo · ${linhas.length} linha${linhas.length === 1 ? "" : "s"}` })
      )
    );
    wrap.appendChild(codeDom(linhas.map((t) => ({ t }))));
    return wrap;
  }

  if (kind === "diff") {
    const antigo = String(inp.oldString ?? "");
    const novo = String(inp.newString ?? inp.content ?? "");
    if (!novo) return null;
    const linhas = diffLines(antigo ? antigo.split("\n") : [], novo.split("\n"));
    const { add, del } = diffStat(linhas);
    const wrap = el("div", { class: "tool-diff" });
    wrap.appendChild(
      el("div", { class: "diff-bar" },
        add ? el("span", { class: "chip add", text: `+${add}` }) : null,
        del ? el("span", { class: "chip del", text: `-${del}` }) : null,
        add + del === 0 ? el("span", { class: "chip muted", text: "sem mudança de texto" }) : null
      )
    );
    // diffHunks devolve grupos; o visualizador quer as linhas, com o cabecalho
    // de cada grupo entre elas.
    const flat = [];
    for (const h of diffHunks(linhas)) {
      flat.push(h.head, ...h.rows);
    }
    wrap.appendChild(codeDom(flat, { diff: true }));
    return wrap;
  }

  if (kind === "read") {
    const cab = readHeader(out || "");
    if (!cab) return null;
    const corpo = out.slice(out.indexOf("\n") + 1);
    return codeDom(readLines(corpo).map((r) => ({ t: r.t, n: r.n ? [r.n, r.n] : null })));
  }

  if (kind === "shell") {
    const cmd = String(inp.command || "");
    const wrap = el("div", { class: "tool-shell" });
    wrap.appendChild(el("div", { class: "sh-cmd" }, el("span", { class: "sh-prompt", text: "❯" }), el("span", { class: "sh-txt", text: cmd })));
    const saida = String(out || "");
    if (saida) {
      const linhas = saida.replace(/\r\n?/g, "\n").split("\n");
      const box = el("div", { class: "code out" });
      const scroll = el("div", { class: "code-scroll" });
      for (const l of linhas.slice(0, MAX_CODE_ROWS)) {
        scroll.appendChild(el("div", { class: "ln" }, el("span", { class: "tx", text: l })));
      }
      box.appendChild(scroll);
      if (linhas.length > MAX_CODE_ROWS) {
        box.appendChild(el("div", { class: "code-more", text: `… mais ${fmtNum(linhas.length - MAX_CODE_ROWS)} linhas` }));
      }
      wrap.appendChild(box);
    } else {
      wrap.appendChild(el("div", { class: "sh-empty", text: "sem saída" }));
    }
    return wrap;
  }

  if (kind === "grep" && out) {
    const linhas = String(out).replace(/\r\n?/g, "\n").split("\n");
    const total = linhas[0].match(/^Found (\d+)/)?.[1];
    const box = el("div", { class: "code hits" });
    const scroll = el("div", { class: "code-scroll" });
    for (const l of linhas.slice(1, MAX_CODE_ROWS)) {
      const arquivo = !l.startsWith(" ") && l.endsWith(":") && !/^\s/.test(l);
      const linha = el("div", { class: "ln" + (arquivo ? " file" : "") });
      linha.appendChild(el("span", { class: "tx", text: arquivo ? l.replace(/:$/, "") : l.trimStart() }));
      scroll.appendChild(linha);
    }
    box.appendChild(scroll);
    const wrap = el("div", { class: "tool-grep" });
    wrap.appendChild(el("div", { class: "diff-bar" }, el("span", { class: "chip muted", text: total ? `${total} ocorrência${total === "1" ? "" : "s"}` : "resultados" })));
    wrap.appendChild(box);
    return wrap;
  }

  return null;
}

function blockTool(sid, mid, p, streaming = false) {
  const key = blockKey(sid, mid, "tool:" + (p.id || p.name));
  const st = p.state || {};
  const status = st.status || "completed";
  const name = p.name || "ferramenta";
  const stl = TOOL_STYLE[name] || { ic: "i-cpu", lbl: name, kind: "raw" };
  const d = el("details", { class: "blk tool k-" + stl.kind });
  d.open = isOpen(key);

  const assunto = toolSubject(name, st);
  d.appendChild(
    el("summary", {},
      icon("i-chev", "caret"),
      icon(stl.ic, "tic"),
      el("span", { class: "tlabel", text: stl.lbl }),
      assunto ? el("span", { class: "tsubject", text: assunto, title: st.input?.path || assunto }) : null,
      el("span", { class: "tstatus " + status, text: status === "completed" ? "ok" : status }),
      streaming && status === "running" ? el("span", { class: "spin" }) : null,
      status === "error" ? el("span", { class: "hint", text: errorText(st.error, "erro") }) : null
    )
  );

  const content = el("div", { class: "blk-content" });

  const especifico = st.status === "error" ? null : toolBody(name, st);
  if (especifico) {
    content.appendChild(especifico);
  } else {
    const inputText = stringify(st.input);
    if (inputText && inputText !== "{}") {
      content.appendChild(el("div", { class: "io-label", text: "entrada" }));
      content.appendChild(preWithLimit(inputText));
    }
    const outText = status === "error" ? errorText(st.error, "") : toolOutputText(st.content ?? st.output);
    if (outText) {
      content.appendChild(el("div", { class: "io-label", text: status === "error" ? "erro" : "saída" }));
      content.appendChild(preWithLimit(outText));
    }
  }
  d.appendChild(content);
  d.addEventListener("toggle", () => {
    if (d.open) state.expanded[key] = true;
    else delete state.expanded[key];
  });
  return d;
}

function stringify(v) {
  if (v == null) return "";
  if (typeof v === "string") return normalizeText(v);
  try {
    const s = JSON.stringify(v, null, 1);
    return s === "{}" ? "" : s;
  } catch {
    return String(v);
  }
}

function preWithLimit(text, limit = OUT_CHARS) {
  if (text.length <= limit) return el("pre", { text });
  const wrap = el("div", { style: "position:relative" });
  const pre = el("pre", { text: text.slice(0, limit) + "\n…" });
  const btn = el("button", { class: "clamp-btn", text: `ler mais ${fmtNum(text.length - limit)} caracteres` });
  btn.onclick = () => {
    pre.textContent = text;
    btn.remove();
  };
  wrap.append(pre, btn);
  return wrap;
}

/** Recolhe blocos de texto longo do assistente. */
function applyClamps(root) {
  for (const node of $$(".prose", root)) {
    if (node.closest(".clamp")) continue;
    if (node.scrollHeight <= CLAMP_PX) continue;
    // wrapper externo (estado) + interno (corte). O degradado fica no
    // padding do interno, entao nunca cobre a ultima linha de texto.
    const holder = el("div", { class: "clamp", style: "--clamp-h:" + CLAMP_PX + "px" });
    const inner = el("div", { class: "clamp-inner" });
    node.replaceWith(holder);
    holder.appendChild(inner);
    inner.appendChild(node);
    const btn = el("button", { class: "clamp-btn", type: "button" }, el("span", { text: "abrir para ler" }), icon("i-chev"));
    btn.onclick = () => {
      inner.style.maxHeight = "none";
      inner.style.paddingBottom = "0";
      inner.style.webkitMaskImage = "none";
      inner.style.maskImage = "none";
      btn.remove();
    };
    holder.appendChild(btn);
  }
}

/* ============================================================
   Compositor
   ============================================================ */
function buildComposer(s) {
  const wrap = el("div", { class: "composer" });
  const inner = el("div", { class: "composer-inner" });
  const box = el("div", { class: "composer-box" });
  const ta = el("textarea", { rows: "1", placeholder: "Mensagem para a sessão...", spellcheck: "false" });
  const send = el("button", { class: "send-btn", title: "Enviar (Enter)" });
  send.appendChild(icon("i-send"));
  box.append(ta, send);
  inner.appendChild(box);

  const hint = el("div", { class: "composer-hint" });
  const left = el("span", { text: s ? `agente ${s.agent || "—"} · modelo ${modelName(s.model) || "—"}` : "" });
  const right = el("span", { class: "row", style: "margin-left:auto" });
  right.append(el("kbd", { text: "Enter" }), el("span", { text: "enviar" }), el("kbd", { text: "Shift+Enter" }), el("span", { text: "nova linha" }));
  hint.append(left, right);
  inner.appendChild(hint);
  wrap.appendChild(inner);

  if (!s) return wrap;

  let acBox = null;
  let acItems = [];
  let acIndex = 0;

  const closeAc = () => {
    acBox?.remove();
    acBox = null;
    acItems = [];
  };

  const openAc = () => {
    const v = ta.value;
    const m = /^\/([^\s]*)$/.exec(v);
    if (!m || !state.commands.length) return closeAc();
    const q = m[1].toLowerCase();
    const found = state.commands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8);
    closeAc(); // limpa o estado anterior ANTES de popular a nova lista
    if (!found.length) return;
    acItems = found;
    acIndex = 0;
    acBox = el("div", { class: "ac" });
    acItems.forEach((c, i) => {
      const row = el("div", { class: "ac-item" + (i === 0 ? " on" : "") },
        el("span", { class: "n", text: "/" + c.name }),
        el("span", { class: "d", text: c.description || "" })
      );
      row.onmousedown = (e) => {
        e.preventDefault();
        ta.value = "/" + c.name + " ";
        closeAc();
        ta.focus();
      };
      acBox.appendChild(row);
    });
    inner.appendChild(acBox);
  };

  const doSend = async () => {
    const text = ta.value.trim();
    if (!text) return;
    closeAc();
    ta.value = "";
    ta.style.height = "auto";
    const cmdMatch = /^\/([A-Za-z0-9_-]+)\s*([\s\S]*)$/.exec(text);
    const known = cmdMatch && state.commands.some((c) => c.name === cmdMatch[1]);
    try {
      if (known) {
        await api("run_command", { session_id: s.id, name: cmdMatch[1], text: cmdMatch[2] });
      } else {
        await api("send_prompt", { session_id: s.id, text });
      }
      state.busy[s.id] = true;
      renderSessionHeader();
      // eco otimista da mensagem enviada (o servidor devolve a versão real no
      // proximo refetch; ate la este evita a sensacao de "nao enviou")
      const list = state.messages[s.id] || [];
      state.messages[s.id] = chronological([
        ...list,
        { id: "local-" + Date.now(), type: "user", text, time: { created: Date.now() }, files: [] },
      ]);
      renderMessages();
      queueSessionRefresh();
      setTimeout(refreshPermissions, 600, s.id);
    } catch (e) {
      fail(e);
      ta.value = text;
    }
  };

  send.onclick = doSend;
  ta.addEventListener("input", () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(200, ta.scrollHeight) + "px";
    send.disabled = !ta.value.trim();
    openAc();
  });
  ta.addEventListener("blur", () => setTimeout(closeAc, 120));
  ta.addEventListener("keydown", (e) => {
    if (acItems.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        acIndex = (acIndex + 1) % acItems.length;
        paint();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        acIndex = (acIndex - 1 + acItems.length) % acItems.length;
        paint();
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && acBox)) {
        e.preventDefault();
        ta.value = "/" + acItems[acIndex].name + " ";
        closeAc();
        ta.focus();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeAc();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });
  function paint() {
    $$(".ac-item", acBox).forEach((n, i) => n.classList.toggle("on", i === acIndex));
  }
  send.disabled = true;
  return wrap;
}

/* ============================================================
   Visao Paralelo
   ============================================================ */
function renderParalelo() {
  const root = $("#viewRoot");
  root.textContent = "";
  const pins = state.pins.filter((id) => sessionById(id));
  if (!pins.length) {
    root.appendChild(
      el("div", { class: "empty" },
        el("h3", { text: "Nenhuma sessão fixada" }),
        el("p", { text: "Use o botao de fixar em uma sessão da barra lateral para acompanhar varias conversas ao mesmo tempo, todas em streaming ao vivo." })
      )
    );
    return;
  }
  const grid = el("div", { class: "p-grid" });
  for (const sid of pins) {
    const s = sessionById(sid);
    if (!s) continue;
    const busy = isBusy(sid);
    const card = el("div", { class: "p-card" + (busy ? " busy" : "") });
    card.dataset.sid = sid;

    const title = el("div", { class: "t", text: s.title || s.id, title: s.title || s.id });
    title.onclick = () => {
      selectSession(sid);
      setView("foco");
    };

    const pinBtn = el("button", { class: "icon-btn on", title: "Desafixar" });
    pinBtn.appendChild(icon("i-pin"));
    pinBtn.onclick = () => togglePin(sid);

    card.appendChild(
      el("div", { class: "p-head" },
        el("span", { class: "s-dot " + sessionState(s) }),
        title,
        el("span", { class: "tag", text: shortModelTag(s) }),
        pinBtn
      )
    );

    const body = el("div", { class: "p-body" }, el("div", { class: "msg-inner" }));
    card.appendChild(body);

    const input = el("input", { placeholder: "Mensagem…" });
    const btn = el("button", { class: "send-btn", title: "Enviar" });
    btn.appendChild(icon("i-send"));
    const go = async () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      try {
        await api("send_prompt", { session_id: sid, text });
        state.busy[sid] = true;
        state.messages[sid] = chronological([
          ...(state.messages[sid] || []),
          { id: "local-" + Date.now(), type: "user", text, time: { created: Date.now() }, files: [] },
        ]);
        renderParBody(card, sid);
        queueSessionRefresh();
      } catch (e) {
        fail(e);
      }
    };
    btn.onclick = go;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        go();
      }
    });
    card.appendChild(el("div", { class: "p-foot" }, input, btn));
    grid.appendChild(card);

    refreshMessages(sid).then(() => renderParBody(card, sid));
  }
  root.appendChild(grid);
}

function shortModelTag(s) {
  const n = modelName(s.model);
  return n ? n.slice(0, 22) : "—";
}

function renderParBody(card, sid) {
  const body = $(".p-body", card);
  if (!body) return;
  const msgs = state.messages[sid] || [];
  const inner = $(".msg-inner", body) || body;
  inner.textContent = "";
  for (const m of msgs.slice(-40)) inner.appendChild(messageNode(sid, m));
  for (const [mid, live] of state.live[sid] || []) {
    if (!msgs.some((m) => m.id === mid)) {
      inner.appendChild(messageNode(sid, { id: mid, type: "assistant", content: [], time: { created: Date.now() } }, live));
    }
  }
  body.scrollTop = body.scrollHeight;
  applyClamps(inner);
}

/* ============================================================
   Visao Subagentes
   ============================================================ */
function renderSubagentes() {
  const root = $("#viewRoot");
  root.textContent = "";
  const wrap = el("div", { class: "s-view" });
  root.appendChild(wrap); // anexado antes de qualquer retorno antecipado
  const inner = el("div", { class: "s-view-inner" });
  wrap.appendChild(inner);

  const sel = sessionById(state.selectedId);
  const toggle = el("button", { class: "btn" + (state.subagentsAll ? " primary" : "") },
    el("span", { text: state.subagentsAll ? "Mostrando todas" : "Mostrar todas" }));
  toggle.onclick = () => {
    state.subagentsAll = !state.subagentsAll;
    renderSubagentes();
  };

  inner.appendChild(
    el("div", { class: "view-head" },
      el("h2", { text: "Subagentes" }),
      el("span", { class: "sub grow", text: sel && !state.subagentsAll ? `Da sessão "${sel.title || sel.id}"` : "Todas as orquestrações" }),
      toggle
    )
  );

  const groups = state.subagentsAll
    ? orchestrations()
    : sel
    ? (() => {
        const ids = descendantIds(sel.id);
        if (!ids.size) return [];
        return [{ pid: sel.id, kids: [...ids].map(sessionById).filter(Boolean).sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0)), parent: sel, updated: sel.time?.updated || 0 }];
      })()
    : [];

  if (!groups.length) {
    inner.appendChild(
      el("div", { class: "empty" },
        el("h3", { text: sel ? "Nenhum subagente nesta sessão" : "Selecione uma sessão" }),
        el("p", { text: sel ? "Quando um agente criar subagentes, a arvore aparece aqui." : "Escolha uma sessão na barra lateral, ou use \"Mostrar todas\"." })
      )
    );
    return;
  }

  const host = el("div");
  inner.appendChild(host);
  renderOrchList(host, groups);
}

function renderOrchList(host, groups) {
  host.textContent = "";
  for (const o of groups) {
    const open = state.expanded["orch:" + o.pid] !== false;
    const card = el("div", { class: "orch" + (open ? " open" : "") });
    const head = el("div", { class: "orch-head" },
      icon("i-chev"),
      el("span", { class: "t", text: o.parent?.title || o.pid, title: o.parent?.title || o.pid }),
      o.parent?.model ? el("span", { class: "tag", text: modelName(o.parent.model) }) : null,
      el("span", { class: "tag subs", text: `${o.kids.length} sub` }),
      el("span", { class: "dim", style: "font-size:10.5px", text: timeAgo(o.updated) })
    );
    head.onclick = (e) => {
      if (e.target.closest(".kid")) return;
      const nowOpen = !card.classList.contains("open");
      card.classList.toggle("open", nowOpen);
      state.expanded["orch:" + o.pid] = nowOpen;
      $(".orch-kids", card).style.display = nowOpen ? "" : "none";
    };
    card.appendChild(head);

    const kids = el("div", { class: "orch-kids" });
    kids.style.display = open ? "" : "none";
    for (const k of o.kids) kids.appendChild(kidRow(k));
    card.appendChild(kids);
    host.appendChild(card);
  }
}

function renderSubagentLists() {
  if (state.view !== "subagentes") return;
  const inner = $(".s-view-inner");
  if (!inner) return;
  renderSubagentes();
}

function kidRow(k) {
  const tk = statsOf(k).tokens;
  const row = el("div", { class: "kid" });
  const t = el("span", { class: "t", text: k.title || k.id, title: `${k.id}\n${k.location?.directory || ""}` });
  t.onclick = () => {
    selectSession(k.id);
    setView("foco");
  };
  row.append(
    el("span", { class: "agent-tag", text: k.agent || "—" }),
    t,
    el("span", { class: "s-dot " + sessionState(k) }),
    el("span", { class: "tk", text: `${fmtNum(tk.input)}/${fmtNum(tk.output)}` }),
    el("span", { class: "wh", text: timeAgo(k.time?.updated) })
  );

  // O estado e' lido no momento do clique (nao capturado na renderizacao):
  // caso contrario um segundo clique repetiria o ramo "abrir" ou removeria a
  // linha vizinha em vez do proprio preview.
  const btn = el("button", { class: "ghost-btn", type: "button" });
  const paint = () => {
    const open = state.expandedKids.has(k.id);
    btn.textContent = open ? "ocultar" : "ler";
    const next = row.nextElementSibling;
    const isPreview = !!next && next.classList.contains("sub-preview");
    if (open && !isPreview) {
      const box = el("div", { class: "sub-preview", text: "carregando…" });
      row.after(box);
      loadSubPreview(box, k.id);
    } else if (!open && isPreview) {
      next.remove();
    }
  };
  btn.onclick = () => {
    if (state.expandedKids.has(k.id)) state.expandedKids.delete(k.id);
    else state.expandedKids.add(k.id);
    paint();
  };
  row.appendChild(btn);
  paint();
  return row;
}

async function loadSubPreview(box, sid) {
  try {
    const msgs = await refreshMessages(sid);
    box.textContent = "";
    if (!msgs.length) {
      box.appendChild(el("span", { class: "dim", text: "sem mensagens" }));
      return;
    }
    for (const m of msgs.slice(-18)) {
      const who = m.type === "user" ? "você" : m.agent || "agente";
      let txt = "";
      if (m.type === "user") txt = m.text || "";
      else if (m.content) {
        const parts = [];
        for (const p of m.content) {
          if (p.type === "text" && (p.text || "").trim()) parts.push(p.text.trim());
          else if (p.type === "tool") parts.push(`[${p.name}]`);
        }
        txt = parts.join(" ");
      }
      txt = txt.replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
      if (!txt) continue;
      box.appendChild(
        el("div", { class: "l" },
          el("span", { class: "who", text: who }),
          el("span", { class: "tx", text: txt.length > 420 ? txt.slice(0, 420) + "…" : txt })
        )
      );
    }
    if (!box.childNodes.length) box.appendChild(el("span", { class: "dim", text: "sem texto" }));
  } catch (e) {
    box.textContent = "falha ao carregar";
  }
}

/* ============================================================
   Visao Eventos
   ============================================================ */
function renderEventos() {
  const root = $("#viewRoot");
  root.textContent = "";
  const view = el("div", { class: "e-view" });

  const filter = el("input", { type: "search", placeholder: "filtrar tipo de evento", spellcheck: "false" });
  filter.value = state.eventFilter;
  filter.oninput = () => {
    state.eventFilter = filter.value.toLowerCase();
    renderEventList();
  };
  const search = el("div", { class: "search-wrap" }, icon("i-search"), filter);

  const pause = el("button", { class: "btn" + (state.eventPaused ? " primary" : "") }, el("span", { text: state.eventPaused ? "Retomar" : "Pausar" }));
  pause.onclick = () => {
    state.eventPaused = !state.eventPaused;
    renderEventos();
  };
  const clear = el("button", { class: "btn" }, el("span", { text: "Limpar" }));
  clear.onclick = () => {
    state.events = [];
    updateEventStatus();
    renderEventList();
  };

  const status = el("div", { class: "status", id: "evStatus" });

  view.appendChild(el("div", { class: "e-bar" }, search, pause, clear, status));
  view.appendChild(el("div", { class: "e-list", id: "evList" }));
  root.appendChild(view);
  updateEventStatus();
  renderEventList();
}

function evClass(t) {
  if (t.includes("reasoning")) return "t-reason";
  if (t.includes("text")) return "t-text";
  if (t.includes("tool")) return "t-tool";
  if (t.includes("error")) return "t-err";
  if (t.includes("session.created") || t.includes("session.updated") || t.includes("session.idle")) return "t-session";
  return "";
}

function updateEventStatus() {
  const s = state.stream;
  $("#evCount").textContent = state.events.length || "";
  const box = $("#evStatus");
  if (!box) return;

  // O estado do stream e' inferido da atividade real: o servidor encerra a
  // conexão ociosa e o cliente reconecta, entao "conectado" e' equivalente a
  // "recebeu algum evento nos ultimos segundos". Isso nao depende do canal
  // auxiliar de status e portanto nao pode ficar dessincronizado.
  const idleMs = Date.now() - state.lastEventAt;
  const live = state.lastEventAt > 0 && idleMs < 45000;
  const effective = live ? "connected" : state.lastEventAt > 0 ? "reconnecting" : s.state;

  const map = {
    connected: ["var(--ok)", "stream conectado"],
    reconnecting: ["var(--warn)", s.attempt ? `reconectando (tentativa ${s.attempt})` : "reconectando"],
    offline: ["var(--err)", "serviço offline"],
    connecting: ["var(--muted)", "conectando"],
  };
  const [color, label] = map[effective] || map.connecting;
  box.textContent = "";
  box.append(
    el("span", { class: "s-dot " + (effective === "connected" ? "succeeded" : effective === "offline" ? "failed" : "running") }),
    el("span", { style: "color:" + color, text: label })
  );
  if (s.reconnects) box.appendChild(el("span", { class: "dim", text: `· ${s.reconnects} reconexões` }));
  if (effective === "connected" && s.since) {
    box.appendChild(el("span", { class: "dim", text: `· ha ${timeAgo(s.since)}` }));
  }
  box.appendChild(el("span", { class: "dim", text: `· ${state.events.length} eventos` }));
}

function renderEventList() {
  const list = $("#evList");
  if (!list) return;
  const q = state.eventFilter;
  const items = state.events.filter((e) => !q || e.type.toLowerCase().includes(q));
  if (!items.length) {
    list.appendChild(
      el("div", { class: "empty" },
        el("h3", { text: state.events.length ? "Nenhum evento corresponde ao filtro" : "Nenhum evento ainda" }),
        el("p", { text: state.events.length ? "Ajuste o filtro." : "O stream SSE do OpenCode aparece aqui assim que o servico emitir algo." })
      )
    );
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of items.slice(0, 300)) {
    const prev = JSON.stringify(e.d).slice(0, 220);
    frag.appendChild(
      el("div", { class: "e-row" },
        el("span", { class: "e-time", text: fmtClock(e.t) }),
        el("span", { class: "e-type " + evClass(e.type), text: e.type }),
        el("span", { class: "e-prev", text: prev, title: e.sid || "" })
      )
    );
  }
  list.textContent = "";
  list.appendChild(frag);
}

/* ============================================================
   Popovers
   ============================================================ */
let closePopover = null;

function openPopover(anchor, build, { width, align = "start", className = "" } = {}) {
  closePopover?.();
  const root = $("#popRoot");
  root.textContent = "";
  const pop = el("div", { class: "pop " + className });
  if (width) pop.style.width = typeof width === "number" ? width + "px" : width;
  root.appendChild(pop);

  const onDoc = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  const close = () => {
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    root.textContent = "";
    closePopover = null;
  };
  closePopover = close;

  build(pop, close);

  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let left = align === "end" ? r.right - pw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
  pop.style.left = left + "px";
  pop.style.top = top + "px";

  document.addEventListener("mousedown", onDoc, true);
  document.addEventListener("keydown", onKey, true);
  const first = pop.querySelector("input, .pop-item");
  first?.focus?.();
  return close;
}

/** Metadados resumidos de um modelo: contexto, custo e capacidades. */
function modelMeta(m) {
  const bits = [];
  const ctx = Number(m.limit?.context) || 0;
  if (ctx) bits.push(ctx >= 1e6 ? `${+(ctx / 1e6).toFixed(ctx % 1e6 ? 1 : 0)}M ctx` : `${Math.round(ctx / 1000)}k ctx`);
  const out = Number(m.cost?.output);
  const inp = Number(m.cost?.input);
  if (Number.isFinite(out) && Number.isFinite(inp)) {
    bits.push(out === 0 && inp === 0 ? "grátis" : `$${(out * 1e6).toFixed(2)}/M out`);
  }
  if (Array.isArray(m.capabilities?.input) && m.capabilities.input.includes("image")) bits.push("visão");
  return bits.join(" · ");
}

/**
 * Conteudo do seletor de modelo, compartilhado entre o cabecalho da sessão e
 * o modal de nova sessão. Antes eram duas implementacoes diferentes — e o
 * modal mantinha a lista longa e apertada que o usuário reclamou.
 *
 * `currentKey` marca o modelo em uso; `none` acrescenta a opcao de deixar
 * o padrão do projeto.
 */
function buildModelList({ currentKey, onPick, none = false, noneLabel = "Padrão do projeto" }) {
  // garante que o modelo em uso apareca mesmo se o provider nao estiver mais
  // exposto por /api/model
  const currentEntry = (() => {
    if (!currentKey) return null;
    const hash = currentKey.indexOf("#");
    const variant = hash >= 0 ? currentKey.slice(hash + 1) : "";
    const base = hash >= 0 ? currentKey.slice(0, hash) : currentKey;
    const sep = base.indexOf("/");
    return {
      providerID: sep >= 0 ? base.slice(0, sep) : "",
      modelID: sep >= 0 ? base.slice(sep + 1) : base,
      name: sep >= 0 ? base.slice(sep + 1) : base,
      variant: variant || undefined,
      variants: variant ? [{ id: variant, name: variant }] : [],
    };
  })();

  const head = el("div", { class: "pop-head" },
    el("div", { class: "t", text: "modelo" }),
    el("input", { class: "input mp-search", type: "search", placeholder: "buscar por nome, provedor ou id", spellcheck: "false" })
  );
  const list = el("div", { class: "pop-list" });
  const frag = document.createDocumentFragment();
  frag.append(head, list);

  const search = $("input", head);
  let items = [];
  let idx = 0;
  let rows = [];

  const rowFor = (m, i, isCurrent) => {
    const k = modelKey(m);
    const variants = Array.isArray(m.variants) ? m.variants : [];
    const row = el("button", { class: "mp-row" + (i === idx ? " on" : "") + (isCurrent ? " cur" : ""), type: "button" });
    row.append(isCurrent ? icon("i-check", "mp-check") : el("span", { class: "mp-check" }), el("span", { class: "mp-name", text: m.name || m.modelID }));
    const meta = modelMeta(m);
    if (meta) row.appendChild(el("span", { class: "mp-meta", text: meta }));
    if (variants.length) row.appendChild(el("span", { class: "mp-variants", text: variants.map((v) => v.name || v.id).join(" / ") }));
    row.title = `${m.providerID || "?"}/${m.modelID || m.name}${meta ? " · " + meta : ""}`;
    row.onclick = () => onPick(k, m);
    return row;
  };

  const addRow = (node) => {
    rows.push(node);
    list.appendChild(node);
  };

  const paint = () => {
    list.textContent = "";
    rows = [];

    if (none) {
      list.appendChild(el("div", { class: "mp-section" }, el("span", { text: "opções" })));
      const r = el("button", { class: "mp-row" + (currentKey ? "" : " on cur"), type: "button" },
        currentKey ? el("span", { class: "mp-check" }) : icon("i-check", "mp-check"),
        el("span", { class: "mp-name", text: noneLabel })
      );
      r.onclick = () => onPick("", null);
      addRow(r);
    }

    if (!items.length) {
      if (!none) list.appendChild(el("div", { class: "pop-hint", text: "nenhum modelo encontrado" }));
      return;
    }

    // modelo em uso, isolado no topo
    const curIdx = items.findIndex((m) => modelKey(m) === currentKey);
    if (curIdx > 0) items.unshift(items.splice(curIdx, 1)[0]);
    const hasCurrent = !!items[0] && modelKey(items[0]) === currentKey;
    // `items` comeca na 0: a linha "Padrão do projeto" (none) esta fora de
    // items e nao deve entrar no calculo, senao o primeiro resultado da
    // busca seria sempre pulado.
    const base = hasCurrent ? 1 : 0;

    if (hasCurrent) {
      list.appendChild(el("div", { class: "mp-section" }, el("span", { text: "em uso" })));
      addRow(rowFor(items[0], 0, true));
    }

    // demais, agrupados por provedor
    const groups = new Map();
    for (let i = base; i < items.length; i++) {
      const m = items[i];
      const key = m.providerID || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push([i, m]);
    }
    for (const [provider, entries] of groups) {
      list.appendChild(
        el("div", { class: "mp-section" }, el("span", { text: provider || "—" }), el("span", { class: "n", text: entries.length }))
      );
      for (const [i, m] of entries) addRow(rowFor(m, i, false));
    }
  };

  const filter = () => {
    const q = searchKey(search.value.trim());
    items = state.models.filter((m) => matchesModel(m, q)).slice(0, 200);
    if (currentEntry && !items.some((m) => modelKey(m) === currentKey) && matchesModel(currentEntry, q)) {
      items.unshift(currentEntry);
    }
    idx = 0;
    paint();
  };
  search.oninput = filter;
  search.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      idx = Math.max(0, Math.min(rows.length - 1, idx + (e.key === "ArrowDown" ? 1 : -1)));
      paint();
      $(".mp-row.on", list)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      rows[idx]?.click();
    }
  };
  filter();
  return frag;
}

function openModelPicker(anchor, s) {
  openPopover(anchor, (pop, close) => {
    pop.appendChild(
      buildModelList({
        currentKey: modelKey(s.model),
        onPick: async (key) => {
          close();
          try {
            await api("switch_model", { session_id: s.id, model: key });
            await refreshSessions();
            renderSessionHeader();
            toast("Modelo alterado", "ok");
          } catch (e) {
            fail(e);
          }
        },
      })
    );
  }, { width: 480, className: "model-pop" });
}
function openAgentPicker(anchor, s) {
  openPopover(anchor, (pop, close) => {
    const list = el("div", { class: "pop-list" });
    pop.append(el("div", { class: "pop-head" }, el("div", { class: "t", text: "agente" })), list);
    const agents = [...state.agents].filter((a) => !a.hidden);
    for (const a of agents) {
      const row = el("button", { class: "pop-item" + (a.id === s.agent ? " on" : ""), type: "button" },
        el("span", { class: "t", text: agentLabel(a) }),
        el("span", { class: "k", text: a.mode || "" })
      );
      row.title = a.description || "";
      row.onclick = async () => {
        close();
        try {
          await api("switch_agent", { session_id: s.id, agent: a.id });
          await refreshSessions();
          renderSessionHeader();
          toast("Agente alterado", "ok");
        } catch (e) {
          fail(e);
        }
      };
      list.appendChild(row);
    }
    if (!agents.length) list.appendChild(el("div", { class: "pop-hint", text: "nenhum agente disponível" }));
  }, { width: 280, align: "end" });
}

function openDirPicker(anchor) {
  openPopover(anchor, (pop, close) => {
    const head = el("div", { class: "pop-head" },
      el("div", { class: "t", text: "diretório de trabalho" }),
      el("input", { class: "input", type: "search", placeholder: "filtrar ou digitar um caminho", spellcheck: "false" })
    );
    const list = el("div", { class: "pop-list" });
    const foot = el("div", { class: "pop-foot" });
    pop.append(head, list, foot);

    const search = $("input", head);
    const all = el("button", { class: "pop-item" + (state.directory ? "" : " on"), type: "button" },
      icon("i-grid"), el("span", { class: "t", text: "Todos os diretórios" }));
    all.onclick = () => applyDir(null, close);
    list.appendChild(all);

    const paint = () => {
      const q = search.value.trim().toLowerCase();
      $$(".pop-item", list).slice(1).forEach((n) => n.remove());
      const dirs = state.projects.filter((p) => !q || p.toLowerCase().includes(q));
      for (const p of dirs.slice(0, 60)) {
        const row = el("button", { class: "pop-item" + (p === state.directory ? " on" : ""), type: "button" },
          icon("i-folder"),
          el("span", { class: "t dir-pop-path path", text: p, title: p })
        );
        row.onclick = () => applyDir(p, close);
        list.appendChild(row);
      }
      if (!dirs.length && q) list.appendChild(el("div", { class: "pop-hint", text: "nenhum diretório conhecido; use o botao abaixo para criar" }));
    };

    const typed = el("button", { class: "btn", type: "button" }, el("span", { text: "Usar caminho digitado" }));
    typed.onclick = () => {
      const v = search.value.trim();
      if (!v) return;
      applyDir(v, close);
    };
    foot.appendChild(typed);
    search.oninput = paint;
    search.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const v = search.value.trim();
        if (v && !state.projects.some((p) => p.toLowerCase() === v.toLowerCase())) applyDir(v, close);
        else $(".pop-item.on", list) || list.children[1]?.click();
      }
    };
    paint();
  }, { width: 420, className: "dir-pop" });
}

async function applyDir(dir, close) {
  close?.();
  try {
    await api("set_directory", { directory: dir });
    state.directory = dir || null;
    store.set("directory", state.directory);
    state.messages = {};
    clearLive();
    updateDirLabel();
    await Promise.all([refreshSessions(), refreshMeta()]);
    if (state.view === "foco") {
      const s = sessionById(state.selectedId);
      if (s) {
        await refreshMessages(s.id, { force: true });
        renderView();
      } else {
        renderView();
      }
    } else {
      renderView();
    }
    toast(dir ? `Diretório: ${shortPath(dir)}` : "Todos os diretórios", "ok");
  } catch (e) {
    fail(e);
  }
}

function updateDirLabel() {
  const btn = $("#dirBtn");
  const label = $("#dirLabel");
  if (!state.directory) {
    label.textContent = "Todos os diretórios";
    btn.classList.remove("set");
  } else {
    label.textContent = lastSegment(state.directory);
    btn.title = state.directory;
    btn.classList.add("set");
  }
}

/**
 * Effort de raciocínio. No OpenCode isso é a *variante* do modelo
 * (`provider/id#variante`): escolher `none` desliga o thinking e
 * `high`/`xhigh`/`max` liga.
 */
function openEffortPicker(anchor, s) {
  openPopover(anchor, (pop, close) => {
    pop.appendChild(el("div", { class: "pop-head" }, el("div", { class: "t", text: "effort de raciocínio" })));
    const list = el("div", { class: "pop-list" });
    pop.appendChild(list);

    const info = state.models.find((m) => modelBaseKey(m) === modelBaseKey(s.model));
    // a variante atual entra na lista mesmo que o catalogo nao a traga
    const variants = [...new Set([...modelVariants(info), ...(s.model?.variant ? [s.model.variant] : [])])];
    const current = s.model?.variant || "";

    if (!variants.length) {
      list.appendChild(el("div", { class: "pop-hint", text: "este modelo não oferece ajuste de effort" }));
      return;
    }
    list.appendChild(el("div", { class: "pop-hint", text: `${modelName(s.model)} · ${variants.length} níveis` }));

    for (const v of variants) {
      const thinking = v !== "none";
      const row = el("button", { class: "pop-item" + (v === current ? " on" : ""), type: "button" },
        thinking ? icon("i-brain") : icon("i-stop"),
        el("span", { class: "t", text: v }),
        el("span", { class: "k", text: thinking ? "thinking ligado" : "thinking desligado" })
      );
      row.onclick = async () => {
        close();
        try {
          const base = modelBaseKey(s.model);
          await api("switch_model", { session_id: s.id, model: `${base}#${v}` });
          await refreshSessions();
          renderSessionHeader();
          toast(`Effort: ${v}${thinking ? " · thinking ligado" : " · thinking desligado"}`, "ok");
        } catch (e) {
          fail(e);
        }
      };
      list.appendChild(row);
    }
  }, { width: 260, align: "end" });
}

function openSessionMenu(anchor, s) {
  openPopover(anchor, (pop, close) => {
    pop.appendChild(el("div", { class: "pop-head" }, el("div", { class: "t", text: s.title || s.id })));
    const item = (label, iconId, fn, danger) => {
      const b = el("button", { class: "pop-item" + (danger ? " danger" : ""), type: "button" }, iconId ? icon(iconId) : null, el("span", { class: "t", text: label }));
      b.onclick = async () => {
        close();
        await fn();
      };
      pop.appendChild(b);
      return b;
    };

    // Interromper e' contextual: so aparece quando ha execucao em andamento
    if (isBusy(s.id)) {
      item("Interromper", "i-stop", () => act("interrupt_session", { session_id: s.id }, "Interrompido"), true);
      pop.appendChild(el("div", { class: "pop-sep" }));
    }

    item("Arquivos alterados", "i-diff", () => openDiffModal(s));
    item("Exportar", "i-download", () => openExportModal(anchor, s));
    pop.appendChild(el("div", { class: "pop-sep" }));
    item("Effort / thinking", "i-brain", () => openEffortPicker(anchor, s));
    item("Compactar contexto", "i-compact", async () => {
      try {
        await api("compact_session", { session_id: s.id });
        toast("Compactação enfileirada", "ok");
        await refreshSessions();
      } catch (e) {
        fail(e);
      }
    });
    item("Bifurcar (histórico inteiro)", "i-branch", () => act("fork_session", { session_id: s.id }, "Sessão bifurcada"));
    item("Mover para outro diretório", "i-move", () => openMoveModal(s));
    pop.appendChild(el("div", { class: "pop-sep" }));
    item(state.pins.includes(s.id) ? "Desafixar do Paralelo" : "Fixar no Paralelo", "i-pin", () => togglePin(s.id));
    item("Excluir sessão", "i-trash", () => confirmDelete([s.id]), true);
  }, { width: 260, align: "end" });
}

function openSettings(anchor) {
  openPopover(anchor, (pop, close) => {
    pop.appendChild(el("div", { class: "pop-head" }, el("div", { class: "t", text: "aparencia" })));

    const themeRow = el("div", { class: "set-row" }, el("span", { class: "lbl", text: "Tema" }));
    const sel = el("select", { class: "input", style: "width:auto" });
    for (const [id, name] of THEMES) sel.appendChild(el("option", { value: id, text: name, selected: id === state.theme }));
    sel.onchange = () => {
      state.theme = sel.value;
      store.set("theme", state.theme);
      applyTheme();
    };
    themeRow.appendChild(sel);
    pop.appendChild(themeRow);

    const accRow = el("div", { class: "set-row" }, el("span", { class: "lbl", text: "Destaque" }));
    const sws = el("div", { class: "swatches" });
    for (const [id, color] of ACCENTS) {
      const b = el("button", { class: "swatch" + (state.accent === id ? " on" : ""), title: id });
      b.style.background = color;
      b.onclick = () => {
        state.accent = state.accent === id ? null : id;
        store.set("accent", state.accent);
        applyTheme();
        close();
        openSettings(anchor);
      };
      sws.appendChild(b);
    }
    accRow.appendChild(sws);
    pop.appendChild(accRow);

    const thinkRow = el("div", { class: "set-row" },
      el("span", { class: "lbl", text: "Mostrar raciocínio" }),
      el("button", { class: "switch" + (state.think ? " on" : ""), type: "button" })
    );
    $(".switch", thinkRow).onclick = (e) => {
      state.think = !state.think;
      store.set("think", state.think);
      e.currentTarget.classList.toggle("on", state.think);
      renderMessages();
      if (state.view === "paralelo") renderParalelo();
    };
    pop.appendChild(thinkRow);

    pop.appendChild(el("div", { class: "pop-sep" }));
    const refresh = el("button", { class: "pop-item", type: "button" }, icon("i-refresh"), el("span", { class: "t", text: "Atualizar agora" }));
    refresh.onclick = async () => {
      close();
      await refreshAll();
      toast("Atualizado", "ok");
    };
    pop.appendChild(refresh);

    const vcsBtn = el("button", { class: "pop-item", type: "button" }, icon("i-diff"), el("span", { class: "t", text: "Alterações no diretório" }));
    vcsBtn.onclick = async () => {
      close();
      try {
        const r = await api("vcs_status");
        const files = r?.data || [];
        openModal({
          title: "Alterações no diretório de trabalho",
          subtitle: state.directory ? shortPath(state.directory) : "nenhum diretório selecionado",
          body: files.length
            ? el("div", { class: "list-box" }, ...files.map((f) => el("div", { class: "diff-row" },
                el("span", { class: "f", text: f.file || f.path || "" }),
                el("span", { class: "tag", text: f.status || "" })
              )))
            : el("p", { class: "dim", text: "Nenhuma alteração registrada." }),
          actions: [],
        });
      } catch (e) {
        fail(e);
      }
    };
    pop.appendChild(vcsBtn);
  }, { width: 250, align: "end" });
}

/* ============================================================
   Modais
   ============================================================ */
let closeModal = null;
function openModal({ title, subtitle, body, actions = [], onOpen }) {
  closeModal?.();
  const root = $("#modalRoot");
  root.textContent = "";
  const close = () => {
    root.textContent = "";
    document.removeEventListener("keydown", onKey, true);
    closeModal = null;
  };
  closeModal = close;
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  const foot = el("div", { class: "modal-foot" });
  const cancel = el("button", { class: "btn", text: "Cancelar" });
  cancel.onclick = close;
  if (actions.length) foot.appendChild(cancel);
  for (const a of actions) {
    const b = el("button", { class: "btn " + (a.primary ? "primary" : "") + (a.danger ? " danger" : ""), text: a.label });
    b.onclick = async () => {
      b.disabled = true;
      try {
        await a.run();
        close();
      } catch (e) {
        fail(e);
        b.disabled = false;
      }
    };
    foot.appendChild(b);
  }
  root.appendChild(
    el("div", { class: "modal" },
      el("div", { class: "modal-head" }, el("h3", { text: title }), subtitle ? el("p", { text: subtitle }) : null),
      el("div", { class: "modal-body" }, body),
      foot
    )
  );
  document.addEventListener("keydown", onKey, true);
  onOpen?.($(".modal", root));
  return close;
}

function openNewSession() {
  const titleIn = el("input", { class: "input", placeholder: "opcional", spellcheck: "false" });
  const agentBtn = el("button", { class: "picker-btn", type: "button" }, el("span", { class: "t", text: "padrão" }), icon("i-chev", "caret"));
  const modelBtn = el("button", { class: "picker-btn", type: "button" }, el("span", { class: "t", text: "padrão" }), icon("i-chev", "caret"));
  let agent = "";
  let model = "";

  agentBtn.onclick = () =>
    openPopover(agentBtn, (pop, close) => {
      const list = el("div", { class: "pop-list" });
      pop.appendChild(list);
      const blank = el("button", { class: "pop-item on", type: "button" }, el("span", { class: "t", text: "padrão" }));
      blank.onclick = () => {
        agent = "";
        $(".t", agentBtn).textContent = "padrão";
        close();
      };
      list.appendChild(blank);
      for (const a of state.agents.filter((x) => !x.hidden)) {
        const row = el("button", { class: "pop-item", type: "button" }, el("span", { class: "t", text: agentLabel(a) }), el("span", { class: "k", text: a.mode || "" }));
        row.onclick = () => {
          agent = a.id;
          $(".t", agentBtn).textContent = agentLabel(a);
          close();
        };
        list.appendChild(row);
      }
    }, { width: 260 });

  modelBtn.onclick = () =>
    openPopover(modelBtn, (pop, close) => {
      // mesmo componente do cabecalho: mesma busca, mesmo agrupamento
      pop.appendChild(
        buildModelList({
          currentKey: model,
          none: true,
          noneLabel: "Padrão do projeto",
          onPick: (key, m) => {
            model = key;
            $(".t", modelBtn).textContent = m ? m.name || m.modelID : "padrão";
            close();
          },
        })
      );
    }, { width: 480, className: "model-pop" });

  const body = el("div", {},
    el("div", { class: "field" }, el("label", { text: "título" }), titleIn),
    el("div", { class: "field" }, el("label", { text: "agente" }), agentBtn),
    el("div", { class: "field" }, el("label", { text: "modelo" }), modelBtn)
  );

  openModal({
    title: "Nova sessão",
    subtitle: state.directory ? shortPath(state.directory) : "será criada no diretório padrão",
    body,
    actions: [
      {
        label: "Criar",
        primary: true,
        run: async () => {
          const r = await api("create_session", { title: titleIn.value.trim() || undefined, agent: agent || undefined, model: model || undefined });
          const created = r?.data || r;
          const id = created?.id;
          // a sessão recem-criada pode nao aparecer na proxima listagem ainda;
          // sem isso o auto-select devolveria a selecao para a sessão mais
          // recente do projeto e o usuário perderia o que acabou de criar
          if (id) {
            if (!state.sessions.some((s) => s.id === id)) state.sessions.unshift(created);
            state.selectedId = id;
            store.set("selectedId", id);
            selectSession(id);
          }
          await refreshSessions();
          if (id && !state.sessions.some((s) => s.id === id)) {
            await new Promise((res) => setTimeout(res, 900));
            await refreshSessions();
          }
          if (id) selectSession(id);
          toast("Sessão criada", "ok");
        },
      },
    ],
    onOpen: () => titleIn.focus(),
  });
}

function confirmDelete(ids) {
  const names = ids.map((id) => sessionById(id)?.title || id);
  const preview = names.slice(0, 5).map((n) => el("li", { class: "dim", text: n }));
  openModal({
    title: ids.length === 1 ? "Excluir sessão" : `Excluir ${ids.length} sessões`,
    subtitle: "A exclusao e' definitiva e remove o histórico.",
    body: el("div", {},
      el("ul", { style: "font-size:12px;padding-left:18px;margin-bottom:6px" }, ...preview),
      names.length > 5 ? el("p", { class: "dim", text: `… e mais ${names.length - 5}.` }) : null
    ),
    actions: [
      {
        label: "Excluir",
        danger: true,
        run: async () => {
          const r = await api("delete_sessions", { session_ids: ids });
          const deleted = r?.deleted || [];
          const failed = r?.failed || [];
          for (const id of deleted) {
            delete state.messages[id];
            clearLive(id);
            state.selected.delete(id);
          }
          state.selectedId = null;
          state.selected = new Set();
          await refreshSessions();
          renderView();
          renderSidebar();
          if (failed.length) toast(`${failed.length} sessão(oes) nao puderam ser excluidas`, "err");
          else toast(`${deleted.length} sessão(oes) excluida(s)`, "ok");
        },
      },
    ],
  });
}

async function openDiffModal(s) {
  openModal({
    title: "Arquivos alterados",
    subtitle: s.title || s.id,
    body: el("p", { class: "dim", text: "carregando…" }),
    actions: [],
  });
  try {
    const r = await api("session_diff", { session_id: s.id });
    const files = r?.data || [];
    const host = $(".modal-body");
    if (host) {
      host.textContent = "";
      if (!files.length) {
        host.appendChild(el("p", { class: "dim", text: "Nenhum arquivo alterado por esta sessão." }));
      } else {
        const totAdd = files.reduce((a, f) => a + (f.additions || 0), 0);
        const totDel = files.reduce((a, f) => a + (f.deletions || 0), 0);
        host.appendChild(
          el("div", { class: "row dim", style: "font-size:11px;margin-bottom:8px" },
            el("span", { text: `${files.length} arquivo(s)` }),
            el("span", { class: "add", text: `+${totAdd}` }),
            el("span", { class: "del", text: `-${totDel}` })
          )
        );
        const box = el("div", { class: "list-box" });
        for (const f of files) {
          const row = el("div", { class: "diff-row", title: f.patch || "" },
            el("span", { class: "f", text: f.file || "" }),
            el("span", { class: "tag", text: f.status || "" }),
            el("span", { class: "add", text: "+" + (f.additions || 0) }),
            el("span", { class: "del", text: "-" + (f.deletions || 0) })
          );
          box.appendChild(row);
        }
        host.appendChild(box);
      }
    }
  } catch (e) {
    const host = $(".modal-body");
    if (host) host.textContent = "";
    host?.appendChild(el("p", { class: "dim", style: "color:var(--err)", text: e.message }));
  }
}

function openExportModal(anchor, s) {
  openPopover(anchor, (pop, close) => {
    pop.appendChild(el("div", { class: "pop-head" }, el("div", { class: "t", text: "exportar sessão" })));
    const mk = (label, fmt) => {
      const b = el("button", { class: "pop-item", type: "button" }, icon("i-download"), el("span", { class: "t", text: label }));
      b.onclick = async () => {
        close();
        try {
          const r = await api("export_session", { session_id: s.id, format: fmt });
          const t = toast(`Salvo em ${shortPath(r.path)}`, "ok");
          const open = el("button", { class: "ghost-btn toast-act", text: "revelar" });
          open.onclick = () => api("reveal_in_explorer", { path: r.path }).catch(() => {});
          t.appendChild(open);
        } catch (e) {
          fail(e);
        }
      };
      pop.appendChild(b);
    };
    mk("Markdown (.md)", "markdown");
    mk("JSON completo (.json)", "json");
  }, { width: 230, align: "end" });
}

function openMoveModal(s) {
  const list = el("div", { class: "list-box", style: "max-height:240px" });
  let chosen = "";
  const search = el("input", { class: "input", placeholder: "filtrar diretórios", spellcheck: "false" });
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    list.textContent = "";
    for (const p of state.projects.filter((p) => !q || p.toLowerCase().includes(q))) {
      const row = el("button", { class: "list-row" + (chosen === p ? " on" : ""), type: "button" },
        el("span", { class: "t", text: p, title: p }),
        el("span", { class: "k", text: lastSegment(p) })
      );
      row.onclick = () => {
        chosen = p;
        paint();
      };
      list.appendChild(row);
    }
  };
  search.oninput = paint;
  paint();

  openModal({
    title: "Mover sessão",
    subtitle: "A sessão passa a executar no diretório escolhido.",
    body: el("div", {}, el("div", { class: "field" }, el("label", { text: "diretório" }), search), list),
    actions: [
      {
        label: "Mover",
        primary: true,
        run: async () => {
          if (!chosen) throw new Error("escolha um diretório");
          await api("move_session", { session_id: s.id, directory: chosen });
          await refreshSessions();
          toast("Sessão movida", "ok");
        },
      },
    ],
  });
}

/* ============================================================
   Conexão e tema
   ============================================================ */
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  if (state.accent) document.documentElement.dataset.accent = state.accent;
  else delete document.documentElement.dataset.accent;
  document.body.classList.toggle("sb-collapsed", state.sidebarCollapsed);
  const t = $("#sidebarToggle");
  if (t) {
    t.setAttribute("aria-expanded", state.sidebarCollapsed ? "false" : "true");
    t.title = state.sidebarCollapsed ? "Mostrar barra de sessões (Ctrl+B)" : "Ocultar barra de sessões (Ctrl+B)";
    const use = t.querySelector("use");
    if (use) use.setAttribute("href", state.sidebarCollapsed ? "#i-panel-off" : "#i-panel");
  }
  updateDirLabel();
}

function toggleSidebar(force) {
  state.sidebarCollapsed = force === undefined ? !state.sidebarCollapsed : !!force;
  store.set("sidebarCollapsed", state.sidebarCollapsed);
  document.body.classList.toggle("sb-collapsed", state.sidebarCollapsed);
  const t = $("#sidebarToggle");
  if (t) {
    t.setAttribute("aria-expanded", state.sidebarCollapsed ? "false" : "true");
    t.title = state.sidebarCollapsed ? "Mostrar barra de sessões (Ctrl+B)" : "Ocultar barra de sessões (Ctrl+B)";
    const use = t.querySelector("use");
    if (use) use.setAttribute("href", state.sidebarCollapsed ? "#i-panel-off" : "#i-panel");
  }
}

async function checkConnection() {
  const text = $("#connText");
  const btn = $("#connBtn");
  try {
    const r = await api("service_status");
    if (r.connected) {
      text.textContent = shortPath(r.url) || "conectado";
      btn.classList.add("ok");
      btn.classList.remove("err");
      btn.title = `serviço ${r.url}${r.info?.version ? " · v" + r.info.version : ""}`;
      return true;
    }
    text.textContent = "offline — clique para iniciar";
    btn.classList.add("err");
    btn.classList.remove("ok");
    btn.onclick = async () => {
      text.textContent = "iniciando serviço…";
      try {
        await api("start_service");
        await checkConnection();
        await refreshAll();
        toast("Servico iniciado", "ok");
      } catch (e) {
        fail(e);
        await checkConnection();
      }
    };
    return false;
  } catch (e) {
    text.textContent = "indisponivel";
    btn.classList.add("err");
    return false;
  }
}

async function refreshAll() {
  await Promise.all([refreshSessions(), refreshMeta(), refreshProjects()]);
  if (state.selectedId) await refreshMessages(state.selectedId, { force: true });
  renderView();
}

/* ============================================================
   Navegacao
   ============================================================ */
function setView(v) {
  state.view = v;
  store.set("view", v);
  renderView();
}

/* ============================================================
   Boot
   ============================================================ */
async function init() {
  applyTheme();

  $$("#viewTabs .tab").forEach((t) => {
    t.onclick = () => setView(t.dataset.view);
  });
  $("#dirBtn").onclick = (e) => openDirPicker(e.currentTarget);
  $("#settingsBtn").onclick = (e) => openSettings(e.currentTarget);
  $("#sidebarToggle").onclick = () => toggleSidebar();
  $("#newSessionBtn").onclick = openNewSession;
  $("#searchInput").oninput = (e) => {
    state.search = e.target.value;
    renderSidebar();
  };
  $("#selectModeBtn").onclick = () => {
    state.selectMode = !state.selectMode;
    if (!state.selectMode) state.selected = new Set();
    renderSidebar();
    updateSelectionBar();
  };
  $("#subsToggle").onclick = () => {
    state.showSubs = !state.showSubs;
    store.set("showSubs", state.showSubs);
    renderSidebar();
    updateSelectionBar();
  };
  $("#selectCancel").onclick = () => {
    state.selectMode = false;
    state.selected = new Set();
    renderSidebar();
    updateSelectionBar();
  };
  $("#selectAll").onchange = (e) => {
    const vis = $$(".s-item", $("#sessionList")).map((n) => n.dataset.sid);
    state.selected = e.target.checked ? new Set(vis) : new Set();
    renderSidebar();
    updateSelectionBar();
  };
  $("#deleteSelected").onclick = () => confirmDelete([...state.selected]);

  document.addEventListener("keydown", (e) => {
    const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
    if (e.key === "/" && !typing) {
      e.preventDefault();
      $("#searchInput").focus();
    } else if (e.key === "Escape" && !typing) {
      closeModal?.();
      closePopover?.();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "n") {
      e.preventDefault();
      openNewSession();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "r" && !typing) {
      e.preventDefault();
      refreshAll();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "b") {
      e.preventDefault();
      toggleSidebar();
    }
  });

  connectEvents();
  // O diretório padrão do app e' o mesmo do servico (`/api/location`), para
  // que a lista de sessões corresponda a `opencode session list`. Sem isso o
  // app mostraria todos os projetos de uma vez.
  if (state.directory) {
    try {
      await api("set_directory", { directory: state.directory });
    } catch {
      state.directory = null;
      store.set("directory", null);
    }
  } else {
    try {
      const loc = await api("default_location");
      const dir = loc?.directory || loc?.project?.canonical;
      if (dir) {
        state.directory = dir;
        store.set("directory", dir);
        await api("set_directory", { directory: dir });
      }
    } catch {
      /* sem diretório padrão: segue mostrando todas as sessões */
    }
  }
  updateDirLabel();
  await Promise.all([checkConnection(), refreshMeta(), refreshProjects()]);
  await refreshSessions();
  await refreshActive();

  if (!sessionById(state.selectedId) && state.sessions.length) {
    const top = [...state.sessions].filter((s) => !s.parentID).sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))[0];
    state.selectedId = top?.id || state.sessions[0].id;
  }
  renderSidebar();
  updateCounts();
  renderView();
  if (state.selectedId) {
    await refreshMessages(state.selectedId, { force: true });
    renderMessages();
  }

  // revisao periodica leve: sessões + permissoes da sessão aberta
  setInterval(async () => {
    if (document.hidden) return;
    await refreshActive();
    await refreshSessions();
    if (state.selectedId && isBusy(state.selectedId)) refreshPermissions(state.selectedId);
    if (state.view === "eventos") updateEventStatus();
  }, 7000);
}

init().catch((e) => {
  console.error(e);
  document.body.innerHTML = "";
  document.body.appendChild(
    el("div", { class: "empty" },
      el("h3", { text: "Falha ao iniciar" }),
      el("p", { text: e?.message || String(e) })
    )
  );
});
