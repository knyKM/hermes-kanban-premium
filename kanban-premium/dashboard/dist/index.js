/**
 * Kanban Premium — camada sobre o plugin Kanban nativo.
 *
 * 1. Marca elementos do board com data-kp-* para o premium.css (papel do
 *    botão, status da coluna, iniciais).
 * 2. Em cada card: profile que executa + ícone e nome do modelo
 *    (GET /api/plugins/kanban-premium/cards).
 * 3. No drawer do card: painel "Agente" com os retornos do chat do worker e
 *    os arquivos modificados (GET /api/plugins/kanban-premium/tasks/:id/activity),
 *    atualizado ao vivo enquanto o card roda.
 *
 * Só lê. Nada aqui altera task, run ou sessão.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var API = "/api/plugins/kanban-premium";
  var LS_BOARD = "hermes.kanban.selectedBoard";
  var SCOPE = ".hermes-kanban, .hermes-kanban-drawer, .hermes-kanban-dialog, .hermes-kanban-bulk";

  // ------------------------------------------------------------ utilidades

  function getJSON(url) {
    if (SDK && SDK.fetchJSON) return SDK.fetchJSON(url);
    return fetch(url, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error(r.status + "");
      return r.json();
    });
  }
  function board() {
    try { return window.localStorage.getItem(LS_BOARD) || ""; } catch (e) { return ""; }
  }
  function withBoard(url) {
    var b = board();
    return b ? url + (url.indexOf("?") >= 0 ? "&" : "?") + "board=" + encodeURIComponent(b) : url;
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function norm(s) { return (s || "").replace(/\s+/g, " ").trim().toLowerCase(); }
  function setAttr(el, k, v) { if (el.getAttribute(k) !== v) el.setAttribute(k, v); }
  function fmtInt(n) {
    if (n == null) return "–";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
    return String(n);
  }
  function fmtDur(s) {
    if (s == null || s < 0) return "–";
    s = Math.round(s);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + "m" + (r ? " " + r + "s" : "");
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  function fmtTime(ts) {
    if (!ts) return "";
    return new Date(ts * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function fmtSize(b) {
    if (b == null) return "";
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    return (b / 1048576).toFixed(1) + " MB";
  }

  // ------------------------------------------------------------ provedores

  function svgUri(svg) { return 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '")'; }
  function tile(bg, glyph, fg) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
      '<rect width="24" height="24" rx="6" fill="' + bg + '"/>' +
      '<g fill="none" stroke="' + (fg || "#fff") + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      glyph + "</g></svg>";
  }
  var PROVIDERS = {
    anthropic: { label: "Anthropic", svg: tile("#D97757", '<path d="M12 5v14M5 12h14M7.05 7.05l9.9 9.9M16.95 7.05l-9.9 9.9"/>') },
    openai: { label: "OpenAI", svg: tile("#10A37F", '<path d="M12 4.5l6.5 3.75v7.5L12 19.5l-6.5-3.75v-7.5z"/><path d="M12 9v6M9.4 10.5l5.2 3M14.6 10.5l-5.2 3"/>') },
    deepseek: { label: "DeepSeek", svg: tile("#4D6BFE", '<path d="M4.5 13.5c1.5 3.2 5.6 4.6 9 3.3 2.6-1 4.3-3.3 4.6-5.8"/><path d="M18 11c.9-1.3 1.8-2.1 2-3.5-1.4.1-2.6.8-3.4 1.8"/><path d="M5 13c2.5-.4 4.6-1.9 5.6-4"/><circle cx="14.5" cy="11.5" r=".6" fill="#fff"/>') },
    google: { label: "Google", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4285F4"/><stop offset="1" stop-color="#9B72CB"/></linearGradient></defs><rect width="24" height="24" rx="6" fill="url(#g)"/><path d="M12 4c.6 4.2 3.8 7.4 8 8-4.2.6-7.4 3.8-8 8-.6-4.2-3.8-7.4-8-8 4.2-.6 7.4-3.8 8-8z" fill="#fff"/></svg>' },
    xai: { label: "xAI", svg: tile("#111111", '<path d="M7 6l10 12M17 6l-4.2 5M7 18l4.2-5"/>') },
    mistral: { label: "Mistral", svg: tile("#FA520F", '<path d="M6 7h3M15 7h3M6 11h12M6 15h3M10.5 15h3M15 15h3M6 18h3M15 18h3"/>') },
    nous: { label: "Nous", svg: tile("#E8E2D4", '<path d="M8 6v12M16 6v12M8 12h8M4.5 8.5L8 10M19.5 8.5L16 10"/>', "#1b1b1b") },
    openrouter: { label: "OpenRouter", svg: tile("#6467F2", '<path d="M4 12h6l4-5h6M14 17h6M10 12l4 5"/><path d="M18 5l2 2-2 2M18 15l2 2-2 2"/>') },
    moonshot: { label: "Moonshot", svg: tile("#1F1F2E", '<path d="M15.5 5.5a7 7 0 1 0 3 9.5 5.5 5.5 0 1 1-3-9.5z"/>') },
    zhipu: { label: "Z.AI", svg: tile("#3859FF", '<path d="M7 7h10L7 17h10"/>') },
    qwen: { label: "Qwen", svg: tile("#615CED", '<path d="M12 4.5l6.5 3.75v7.5L12 19.5l-6.5-3.75v-7.5z"/><path d="M12 12l3.5 3.5"/>') },
    local: { label: "Local", svg: tile("#3A3A40", '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3"/>') },
    unknown: { label: "Modelo", svg: tile("#3A3A40", '<path d="M12 5l1.6 4.4L18 11l-4.4 1.6L12 17l-1.6-4.4L6 11l4.4-1.6z"/>') },
  };
  function providerKey(provider, model) {
    var s = ((provider || "") + " " + (model || "")).toLowerCase();
    if (/anthropic|claude/.test(s)) return "anthropic";
    if (/deepseek/.test(s)) return "deepseek";
    if (/openai|codex|gpt|\bo[134]\b|o[134]-/.test(s)) return "openai";
    if (/gemini|google|vertex/.test(s)) return "google";
    if (/xai|grok/.test(s)) return "xai";
    if (/mistral|codestral|devstral/.test(s)) return "mistral";
    if (/nous|hermes/.test(s)) return "nous";
    if (/kimi|moonshot/.test(s)) return "moonshot";
    if (/glm|zhipu|z\.ai|zai/.test(s)) return "zhipu";
    if (/qwen|dashscope|alibaba/.test(s)) return "qwen";
    if (/ollama|llama|lmstudio|local|vllm|magnitude/.test(s)) return "local";
    if (/openrouter/.test(s)) return "openrouter";
    return model ? "unknown" : "";
  }
  var ICON_CACHE = {};
  function iconUri(key) {
    if (!ICON_CACHE[key]) ICON_CACHE[key] = svgUri((PROVIDERS[key] || PROVIDERS.unknown).svg);
    return ICON_CACHE[key];
  }
  function iconHTML(key, size) {
    var p = PROVIDERS[key] || PROVIDERS.unknown;
    return '<span class="kp-ico" style="width:' + size + "px;height:" + size + 'px" title="' + esc(p.label) + '">' + p.svg + "</span>";
  }

  // ------------------------------------------------------- decoração base

  var PRIMARY = ["+ new board", "new board", "complete", "comment", "create", "create task", "save", "+ add", "add",
    "confirm", "import", "apply", "+ nova board", "concluir", "comentar", "criar", "salvar"];
  var DANGER = ["archive", "delete", "terminate", "delete board", "archive board", "arquivar", "excluir", "encerrar"];
  var WARN = ["block", "bloquear", "reclaim"];
  var STATUS = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"];

  function initials(name) {
    var n = (name || "").replace(/^@/, "").trim();
    if (!n) return "?";
    var parts = n.split(/[-_.\s]+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : n.slice(0, 2)).toUpperCase();
  }
  function statusOf(head) {
    var dot = head.querySelector(".hermes-kanban-dot");
    if (!dot) return null;
    for (var i = 0; i < STATUS.length; i++) if (dot.classList.contains("hermes-kanban-dot-" + STATUS[i])) return STATUS[i];
    var t = norm((head.querySelector(".hermes-kanban-column-label") || {}).textContent);
    if (t.indexOf("sched") === 0 || t.indexOf("agend") === 0) return "scheduled";
    return "none";
  }

  function decorateBase() {
    var roots = document.querySelectorAll(SCOPE);
    if (!roots.length) return false;
    document.documentElement.setAttribute("data-kp", "on");
    roots.forEach(function (root) {
      root.querySelectorAll(".hermes-kanban-column").forEach(function (col) {
        var head = col.querySelector(".hermes-kanban-column-header");
        var st = head ? statusOf(head) : null;
        if (!st) return;
        setAttr(col, "data-kp-status", st);
        col.querySelectorAll(".hermes-kanban-card").forEach(function (card) { setAttr(card, "data-kp-status", st); });
      });
      root.querySelectorAll("button").forEach(function (b) {
        if (b.closest(".hermes-kanban-card") || b.closest(".kp-agent")) return;
        var t = norm(b.textContent);
        if (!t) return;
        var cn = String(b.className || "");
        if (cn.indexOf("font-mono") < 0 && cn.indexOf("bg-midground") < 0) return;
        var role = PRIMARY.indexOf(t) >= 0 ? "primary" : DANGER.indexOf(t) >= 0 ? "danger" : WARN.indexOf(t) >= 0 ? "warn" : "secondary";
        setAttr(b, "data-kp-btn", role);
      });
      root.querySelectorAll(".hermes-kanban-lane-name").forEach(function (a) {
        setAttr(a, "data-kp-initials", initials(a.textContent));
      });
    });
    return true;
  }

  // ------------------------------------------------- cards: profile + modelo

  var CARD_INFO = {};
  var CARD_PENDING = {};

  function cardId(card) {
    var el = card.querySelector(".hermes-kanban-card-id");
    var t = el ? el.textContent.trim() : "";
    return /^t_[0-9a-f]+$/.test(t) ? t : "";
  }

  function applyCard(card, info) {
    var meta = card.querySelector(".hermes-kanban-card-meta");
    if (!meta) return;
    var who = meta.querySelector(".hermes-kanban-assignee");
    var key = providerKey(info.provider, info.model);
    setAttr(card, "data-kp-live", info.live ? "1" : "0");
    if (!who) return;
    if (info.profile && who.textContent.replace(/^@/, "").trim() !== info.profile) setAttr(who, "data-kp-runner", info.profile);
    else if (who.hasAttribute("data-kp-runner")) who.removeAttribute("data-kp-runner");
    setAttr(who, "data-kp-model", info.model || "");
    setAttr(who, "data-kp-provider", key || "none");
    setAttr(who, "title", (info.profile || "") + (info.model ? " · " + info.model : "") +
      (info.source === "profile" ? " (modelo do profile)" : info.source === "override" ? " (override do card)" : ""));
    if (key) {
      var uri = iconUri(key);
      if (who.style.getPropertyValue("--kp-icon") !== uri) who.style.setProperty("--kp-icon", uri);
    }
  }

  function decorateCards() {
    var now = Date.now(), need = [];
    document.querySelectorAll(".hermes-kanban .hermes-kanban-card").forEach(function (card) {
      var id = cardId(card);
      if (!id) return;
      var c = CARD_INFO[id];
      if (c) applyCard(card, c.info);
      var ttl = c && c.info.live ? 8000 : 45000;
      if ((!c || now - c.at > ttl) && !CARD_PENDING[id]) need.push(id);
    });
    if (need.length) fetchCards(need);
  }

  function fetchCards(ids) {
    ids.forEach(function (id) { CARD_PENDING[id] = 1; });
    getJSON(withBoard(API + "/cards?ids=" + encodeURIComponent(ids.join(","))))
      .then(function (r) {
        var now = Date.now();
        Object.keys(r.cards || {}).forEach(function (id) { CARD_INFO[id] = { info: r.cards[id], at: now }; });
        ids.forEach(function (id) { if (!CARD_INFO[id]) CARD_INFO[id] = { info: {}, at: now }; });
      })
      .catch(function () { /* API do plugin indisponível: segue sem o chip */ })
      .then(function () { ids.forEach(function (id) { delete CARD_PENDING[id]; }); schedule(); });
  }

  // ------------------------------------------------- drawer: painel Agente

  var PANELS = {};
  var activeTask = null;
  var pollTimer = null;

  function drawerTaskId(drawer) {
    var head = drawer.querySelector(".hermes-kanban-drawer-head");
    var m = head ? (head.textContent || "").match(/t_[0-9a-f]{4,32}/) : null;
    return m ? m[0] : "";
  }

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }
  function mdLite(src) {
    var blocks = String(src || "").split(/```/), html = "";
    for (var i = 0; i < blocks.length; i++) {
      if (i % 2 === 1) {
        var code = blocks[i].replace(/^[a-zA-Z0-9_+-]*\n/, "");
        html += '<pre class="kp-code">' + esc(code.replace(/\n$/, "")) + "</pre>";
        continue;
      }
      var lines = blocks[i].split("\n"), list = null, para = [];
      var flush = function () {
        if (para.length) { html += "<p>" + para.join("<br>") + "</p>"; para = []; }
        if (list) { html += "</" + list + ">"; list = null; }
      };
      for (var j = 0; j < lines.length; j++) {
        var raw = lines[j];
        var h = raw.match(/^(#{1,4})\s+(.*)$/);
        var li = raw.match(/^\s*[-*]\s+(.*)$/);
        var oli = raw.match(/^\s*\d+[.)]\s+(.*)$/);
        if (!raw.trim()) { flush(); continue; }
        if (/^\s*\|.*\|\s*$/.test(raw)) {
          flush();
          var rows = [];
          while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) { rows.push(lines[j]); j++; }
          j--;
          var cells = function (r) { return r.trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); }); };
          var body = rows.filter(function (r) { return !/^\s*\|?[\s:|-]+\|?\s*$/.test(r); });
          var hasHead = rows.length > 1 && /^\s*\|?[\s:|-]+\|?\s*$/.test(rows[1]);
          html += '<div class="kp-table"><table>' + body.map(function (r, n) {
            var tag = hasHead && n === 0 ? "th" : "td";
            return "<tr>" + cells(r).map(function (c) { return "<" + tag + ">" + inline(c) + "</" + tag + ">"; }).join("") + "</tr>";
          }).join("") + "</table></div>";
          continue;
        }
        if (h) { flush(); var lv = Math.min(6, h[1].length + 2); html += "<h" + lv + ">" + inline(h[2]) + "</h" + lv + ">"; continue; }
        if (li || oli) {
          if (para.length) { html += "<p>" + para.join("<br>") + "</p>"; para = []; }
          var want = li ? "ul" : "ol";
          if (list !== want) { if (list) html += "</" + list + ">"; html += "<" + want + ">"; list = want; }
          html += "<li>" + inline((li || oli)[1]) + "</li>";
          continue;
        }
        if (list) { html += "</" + list + ">"; list = null; }
        para.push(inline(raw));
      }
      flush();
    }
    return html;
  }

  function splitPath(p) {
    var s = String(p || ""), i = s.lastIndexOf("/");
    return i >= 0 ? [s.slice(0, i + 1), s.slice(i + 1)] : ["", s];
  }
  function shortDir(dir, ws) {
    if (ws) {
      var w = ws.replace(/\\/g, "/");
      if (dir.toLowerCase().indexOf(w.toLowerCase()) === 0) return "workspace/" + dir.slice(w.length).replace(/^\//, "");
    }
    return dir.replace(/^[A-Za-z]:\/Users\/[^/]+\//, "~/");
  }
  var ACTION_LABEL = { escrita: "escrito", patch: "editado", artefato: "artefato", criado: "novo", editado: "editado",
    removido: "removido", renomeado: "renomeado", workspace: "gerado" };

  function statusLabel(d) {
    if (d.live) return "rodando";
    var o = d.run && (d.run.outcome || d.run.status);
    var map = { completed: "concluído", done: "concluído", blocked: "bloqueado", crashed: "falhou", gave_up: "desistiu",
      timed_out: "timeout", spawn_failed: "falha ao iniciar", reclaimed: "interrompido", running: "rodando" };
    return o ? (map[o] || o) : (d.status || "");
  }
  function stat(k, v) { return '<div class="kp-stat"><span>' + k + "</span><b>" + v + "</b></div>"; }
  function tab(st, id, label, n) {
    return '<button type="button" class="kp-tab' + (st.tab === id ? " is-on" : "") + '" data-kp-act="tab" data-kp-tab="' + id + '">' +
      label + '<span class="kp-tab-n">' + n + "</span></button>";
  }

  function renderHead(st) {
    var d = st.data, s = d.session || {};
    var key = providerKey(d.provider, d.model) || "unknown";
    var end = s.ended_at || (d.live ? Date.now() / 1000 : (d.run && d.run.ended_at) || s.last_activity_at);
    var dur = s.started_at && end ? end - s.started_at : null;
    var cost = s.actual_cost_usd != null ? s.actual_cost_usd : s.estimated_cost_usd;
    var bad = d.run && /crash|gave|timed|fail/.test(d.run.outcome || "");
    var runSel = "";
    if (d.runs && d.runs.length > 1) {
      runSel = '<select class="kp-run-select" data-kp-act="run">' + d.runs.slice().reverse().map(function (r) {
        return '<option value="' + r.id + '"' + (d.run && d.run.id === r.id ? " selected" : "") + ">run #" + r.id +
          " · " + esc(r.profile || "") + (r.outcome ? " · " + esc(r.outcome) : r.ended_at ? "" : " · rodando") + "</option>";
      }).join("") + "</select>";
    }
    return '<div class="kp-agent-head">' +
        '<div class="kp-agent-avatar' + (d.live ? " is-live" : "") + '">' + iconHTML(key, 34) + "</div>" +
        '<div class="kp-agent-id"><div class="kp-agent-model">' + esc(d.model || "modelo não informado") + "</div>" +
          '<div class="kp-agent-sub"><span class="kp-agent-profile">' + esc(d.profile || "sem profile") + "</span>" +
          (d.provider ? '<span class="kp-sep">·</span>' + esc(d.provider) : "") +
          (d.run ? '<span class="kp-sep">·</span>run #' + d.run.id : "") + "</div></div>" +
        '<span class="kp-state kp-state--' + (d.live ? "live" : bad ? "bad" : "idle") + '">' + (d.live ? "<i></i>" : "") +
          esc(statusLabel(d)) + "</span>" +
      "</div>" +
      (d.session ? '<div class="kp-stats">' +
        stat("Entrada", fmtInt(s.input_tokens)) + stat("Saída", fmtInt(s.output_tokens)) +
        stat("Cache", fmtInt(s.cache_read_tokens)) + stat("Ferramentas", fmtInt(s.tool_call_count)) +
        stat("Duração", fmtDur(dur)) + stat("Custo", cost != null ? "$" + Number(cost).toFixed(cost < 0.1 ? 4 : 2) : "–") +
      "</div>" : "") +
      '<div class="kp-tabs">' + tab(st, "chat", "Chat", d.items_total || 0) + tab(st, "files", "Arquivos", (d.files || []).length) +
        tab(st, "term", "Terminal", termCount(st)) +
        '<span class="kp-tabs-fill"></span>' +
        (st.tab === "chat" ? '<label class="kp-toggle"><input type="checkbox" data-kp-act="replies"' + (st.onlyReplies ? " checked" : "") + "> só respostas</label>" : "") +
        runSel + "</div>";
  }

  function termItems(st) {
    return (st.items || []).filter(function (i) { return i.kind === "tool" && i.name === "terminal"; });
  }
  function termCount(st) { return termItems(st).length; }

  function renderTerm(st) {
    var d = st.data, list = termItems(st), out = [];
    var running = list.filter(function (i) { return i.pending; });
    running.forEach(function (it) {
      var secs = Math.max(0, Date.now() / 1000 - (it.ts || 0));
      out.push('<div class="kp-run-now"><div class="kp-run-now-head"><i></i>executando agora<span>' + fmtDur(secs) + "</span></div>" +
        '<pre class="kp-code kp-term">$ ' + esc(it.command || it.label || "") + "</pre>" +
        '<div class="kp-muted">o Hermes grava a saída do comando quando ele termina; ela aparece aqui sozinha</div></div>');
    });
    list.slice().reverse().forEach(function (it) {
      if (it.pending) return;
      out.push('<details class="kp-term-item' + (it.ok ? "" : " is-err") + '" data-kp-id="t' + esc(it.id) + '"' + (st.open["t" + it.id] ? " open" : "") + ">" +
        '<summary><span class="kp-tool-dot"></span><span class="kp-term-cmd">$ ' + esc((it.command || it.label || "").split("\n")[0]) + "</span>" +
        '<span class="kp-tool-time">' + fmtTime(it.ts) + (it.done_ts && it.ts ? " · " + fmtDur(it.done_ts - it.ts) : "") + "</span></summary>" +
        (it.command && it.command.indexOf("\n") >= 0 ? '<pre class="kp-code kp-term">$ ' + esc(it.command) + "</pre>" : "") +
        '<pre class="kp-code kp-term kp-code--out">' + esc(it.output || (it.lost ? "(sem retorno: o worker encerrou antes do fim do comando)" : "(sem saída)")) + "</pre></details>");
    });
    var tailUseful = d.log_tail && d.log_tail.replace(/^\s*Session:.*$/gm, "").trim();
    if (tailUseful) {
      out.push('<div class="kp-files-head">Log do worker' + (d.live ? " (ao vivo)" : "") + "</div>" +
        '<pre class="kp-code kp-term kp-log">' + esc(d.log_tail) + "</pre>");
    }
    if (!out.length) out.push('<div class="kp-empty">Nenhum comando de terminal nesta execução.</div>');
    return out.join("");
  }

  function renderChat(st) {
    var d = st.data, items = st.items || [];
    if (!d.session) {
      return '<div class="kp-empty">' + esc(d.session_hint || "Sem sessão do worker") +
        (d.run && d.run.summary ? '<div class="kp-summary kp-md"><b>Motivo / resumo do run:</b><br>' + mdLite(d.run.summary) + "</div>" : "") +
        (d.log_tail ? '<pre class="kp-code kp-term kp-log" style="text-align:left">' + esc(d.log_tail) + "</pre>" : "") + "</div>";
    }
    var key = providerKey(d.provider, d.model) || "unknown";
    var out = [], toolRun = [];
    var flushTools = function () {
      if (toolRun.length && !st.onlyReplies) out.push('<div class="kp-tools">' + toolRun.join("") + "</div>");
      toolRun = [];
    };
    items.forEach(function (it) {
      if (it.kind === "tool") {
        toolRun.push('<details class="kp-tool' + (it.pending ? " is-pending" : it.ok ? "" : " is-err") + '" data-kp-id="' + esc(it.id) + '"' + (st.open[it.id] ? " open" : "") + ">" +
          '<summary><span class="kp-tool-dot"></span><span class="kp-tool-name">' + esc(it.name) + "</span>" +
          '<span class="kp-tool-label">' + esc(it.label || "") + '</span><span class="kp-tool-time">' + fmtTime(it.ts) + "</span></summary>" +
          (it.command ? '<pre class="kp-code kp-term">$ ' + esc(it.command) + "</pre>" : "") +
          (it.pending ? '<div class="kp-muted">executando…</div>' :
            it.output ? '<pre class="kp-code kp-code--out">' + esc(it.output) + "</pre>" :
            '<div class="kp-muted">' + (it.lost ? "sem retorno: o worker encerrou antes do fim" : "sem retorno") + "</div>") +
          "</details>");
        return;
      }
      flushTools();
      if (it.kind === "user") {
        out.push('<details class="kp-prompt" data-kp-id="' + esc(it.id) + '"' + (st.open[it.id] ? " open" : "") +
          '><summary>Prompt enviado ao worker<span class="kp-tool-time">' + fmtTime(it.ts) + "</span></summary>" +
          '<div class="kp-md">' + mdLite(it.text) + "</div></details>");
      } else {
        out.push('<div class="kp-msg' + (it.final ? " is-final" : "") + '"><div class="kp-msg-ico">' + iconHTML(key, 20) + "</div>" +
          '<div class="kp-msg-body"><div class="kp-msg-meta"><b>' + esc(d.profile || "agente") + "</b>" +
          (it.final ? '<span class="kp-pill">resposta</span>' : "") + "<span>" + fmtTime(it.ts) + "</span></div>" +
          '<div class="kp-md">' + mdLite(it.text) + "</div></div></div>");
      }
    });
    flushTools();
    if (d.live) out.push('<div class="kp-typing"><i></i><i></i><i></i><span>' + esc(d.profile || "agente") + " trabalhando…</span></div>");
    if (!out.length) out.push('<div class="kp-empty">Sessão sem mensagens ainda.</div>');
    return out.join("");
  }

  function renderFiles(st) {
    var d = st.data, files = d.files || [];
    if (!files.length) return '<div class="kp-empty">Nenhum arquivo modificado registrado nesta execução.</div>';
    var row = function (f) {
      var sp = splitPath(f.path);
      var ext = sp[1].indexOf(".") > 0 ? sp[1].split(".").pop().toLowerCase() : "";
      return '<div class="kp-file' + (f.exists ? "" : " is-gone") + '">' +
        '<span class="kp-file-ext">' + esc(ext.slice(0, 4) || "—") + "</span>" +
        '<div class="kp-file-main"><div class="kp-file-name">' + esc(sp[1]) + "</div>" +
        '<div class="kp-file-dir" title="' + esc(f.path) + '">' + esc(shortDir(sp[0], d.workspace)) + "</div></div>" +
        '<div class="kp-file-tags">' + f.actions.map(function (a) {
          return '<span class="kp-tag kp-tag--' + esc(a) + '">' + esc(ACTION_LABEL[a] || a) + "</span>";
        }).join("") + (f.count > 1 ? '<span class="kp-tag">×' + f.count + "</span>" : "") + "</div>" +
        '<span class="kp-file-size">' + (f.exists ? fmtSize(f.size) : "não existe") + "</span>" +
        '<button type="button" class="kp-copy" data-kp-act="copy" data-kp-path="' + esc(f.path) + '" title="Copiar caminho">⧉</button></div>';
    };
    var outside = files.filter(function (f) { return !f.in_workspace; });
    var inside = files.filter(function (f) { return f.in_workspace; });
    var html = "";
    if (outside.length) html += '<div class="kp-files-head">Fora do workspace<span>' + outside.length + "</span></div>" + outside.map(row).join("");
    if (inside.length) html += '<div class="kp-files-head">Workspace do card<span>' + inside.length + "</span></div>" + inside.map(row).join("");
    return html;
  }

  function render(st, panel) {
    if (!st.data) {
      panel.innerHTML = '<div class="kp-loading">' + (st.error ? esc(st.error) : "Carregando atividade do agente…") + "</div>";
      return;
    }
    var body = panel.querySelector(".kp-pane");
    var stick = body ? body.scrollHeight - body.scrollTop - body.clientHeight < 40 : true;
    var prevTop = body ? body.scrollTop : 0;
    panel.innerHTML = renderHead(st) + '<div class="kp-pane kp-pane--' + st.tab + '">' +
      (st.tab === "chat" ? renderChat(st) : st.tab === "term" ? renderTerm(st) : renderFiles(st)) + "</div>";
    var nb = panel.querySelector(".kp-pane");
    nb.scrollTop = st.tab === "chat" && (stick || st.firstPaint) ? nb.scrollHeight : (st.firstPaint ? 0 : prevTop);
    st.firstPaint = false;
  }

  function load(st, incremental) {
    if (st.loading) return;
    st.loading = true;
    var url = API + "/tasks/" + encodeURIComponent(st.id) + "/activity", q = [];
    if (st.run) q.push("run=" + st.run);
    if (incremental && st.data && st.data.cursor) q.push("after=" + st.data.cursor);
    if (q.length) url += "?" + q.join("&");
    getJSON(withBoard(url)).then(function (d) {
      if (incremental && st.data && d.incremental) {
        var pos = {};
        st.items.forEach(function (i, n) { pos[i.id] = n; });
        d.items.forEach(function (i) {
          if (pos[i.id] != null) st.items[pos[i.id]] = i;
          else { pos[i.id] = st.items.length; st.items.push(i); }
        });
      } else {
        st.items = d.items || [];
      }
      d.items_total = st.items.filter(function (i) { return i.kind === "assistant"; }).length;
      st.data = d;
      st.error = null;
      if (!st.run) CARD_INFO[st.id] = { info: { profile: d.profile, model: d.model, provider: d.provider, live: d.live, source: "session" }, at: Date.now() };
    }).catch(function (e) {
      st.error = "Não consegui ler a atividade (" + (e && e.message ? String(e.message).slice(0, 90) : "erro") + ")";
    }).then(function () {
      st.loading = false;
      var panel = document.querySelector('.kp-agent[data-kp-task="' + st.id + '"]');
      if (panel) render(st, panel);
      armPoll(st);
    });
  }

  function armPoll(st) {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (activeTask !== st.id || !st.data || !st.data.live || st.run) return;
    // sem sessão ainda (worker iniciando): recarrega completo até a sessão aparecer
    var incr = !!st.data.session;
    pollTimer = setTimeout(function () { if (activeTask === st.id) load(st, incr); }, 3000);
  }

  function onPanelEvent(e) {
    var panel = e.target.closest(".kp-agent");
    if (!panel) return;
    var st = PANELS[panel.getAttribute("data-kp-task")];
    if (!st) return;
    var det = e.target.closest("details");
    if (det && e.type === "click" && e.target.closest("summary")) {
      setTimeout(function () { st.open[det.getAttribute("data-kp-id")] = det.open; }, 0);
    }
    var t = e.target.closest("[data-kp-act]");
    if (!t) return;
    var act = t.getAttribute("data-kp-act");
    if (act === "tab" && e.type === "click") { st.tab = t.getAttribute("data-kp-tab"); st.firstPaint = true; render(st, panel); }
    else if (act === "replies" && e.type === "change") { st.onlyReplies = t.checked; render(st, panel); }
    else if (act === "run" && e.type === "change") {
      var v = parseInt(t.value, 10), runs = (st.data && st.data.runs) || [];
      st.run = runs.length && v === runs[runs.length - 1].id ? null : v;
      st.data = null; st.items = []; st.firstPaint = true; render(st, panel); load(st, false);
    } else if (act === "copy" && e.type === "click") {
      try {
        navigator.clipboard.writeText(t.getAttribute("data-kp-path"));
        t.textContent = "✓"; setTimeout(function () { t.textContent = "⧉"; }, 1200);
      } catch (err) { /* sem clipboard */ }
    }
  }

  function decorateDrawer() {
    var drawer = document.querySelector(".hermes-kanban-drawer");
    if (!drawer) {
      if (activeTask) { activeTask = null; if (pollTimer) clearTimeout(pollTimer); }
      return;
    }
    var id = drawerTaskId(drawer);
    var bodyEl = drawer.querySelector(".hermes-kanban-drawer-body");
    if (!id || !bodyEl) return;
    var panel = bodyEl.querySelector(".kp-agent");
    if (panel && panel.getAttribute("data-kp-task") !== id) { panel.remove(); panel = null; }
    var st = PANELS[id] || (PANELS[id] = { id: id, tab: "chat", open: {}, items: [], onlyReplies: false, firstPaint: true, run: null });
    if (!panel) {
      panel = document.createElement("section");
      panel.className = "kp-agent";
      panel.setAttribute("data-kp-task", id);
      panel.addEventListener("click", onPanelEvent);
      panel.addEventListener("change", onPanelEvent);
      var anchor = bodyEl.querySelector(":scope > .hermes-kanban-drawer-meta") || bodyEl.querySelector(":scope > .hermes-kanban-drawer-title");
      if (anchor) anchor.insertAdjacentElement("afterend", panel);
      else bodyEl.insertBefore(panel, bodyEl.firstChild);
      st.firstPaint = true;
      render(st, panel);
    }
    if (activeTask !== id) { activeTask = id; load(st, false); }
  }

  // ------------------------------------------------------------- agenda

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      try {
        if (!decorateBase()) return;
        decorateCards();
        decorateDrawer();
      } catch (e) { if (window.console) console.warn("[kanban-premium]", e); }
    });
  }

  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var t = muts[i].target;
      if (t && t.nodeType === 1 && t.closest && t.closest(".kp-agent")) continue;
      schedule();
      return;
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  setInterval(schedule, 10000);
  schedule();

  if (SDK && window.__HERMES_PLUGINS__ && typeof window.__HERMES_PLUGINS__.register === "function") {
    window.__HERMES_PLUGINS__.register("kanban-premium", function () { return null; });
  }
})();
