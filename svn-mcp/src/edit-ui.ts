/**
 * svn-edit 的控制頁（單一 HTML）。由 edit-server 在 GET / 與 GET /edit 回傳，並把一次性 token
 * 嵌進頁面；頁面之後所有操作都用同源 fetch 呼叫 /api/*，一律帶 X-Edit-Token。
 *
 * 注意：下面的樣板字串裡不能出現反引號與 `${`，前端程式碼一律用字串串接。
 * 所有動態內容（檔名、路徑、訊息）都用 textContent 填入，不用 innerHTML，避免 XSS。
 */
import { LOGO_PNG_BASE64 } from "./edit-icon-data.js";

/** 顯示在頁首的版本號；有功能性改版時手動調整。 */
export const APP_VERSION = "1.0.0";

const PAGE = String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SVN 遠端編輯</title>
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<style>
:root{
  --brand:#e2484c;--brand-hover:#cf3b40;--brand-dark:#b8262b;--brand-soft:#fdecec;
  --pink:#f7a8ac;--pink-soft:#fdf2f1;--pink-line:#f9dedd;
  --page:#fdfaf7;--surface:#fff;--ink:#332e2c;--ink-soft:#6f6360;--muted:#9a8f8b;--line:#f0e8e4;--line-strong:#e4d8d3;--field:#fbf8f6;
  --pending-bg:#fef4e3;--pending-ink:#b0761b;--processing-bg:#eaf4fc;--processing-ink:#1f6fa8;--completed-bg:#eaf7ee;--completed-ink:#3a8a5d;
  --danger:#d64045;--danger-bg:#fdecec;
  --radius-card:18px;--radius-field:12px;
  --shadow-card:0 1px 2px rgb(51 46 44 / .04),0 8px 24px rgb(51 46 44 / .05);
  --font-sans:"Noto Sans TC","Microsoft JhengHei","PingFang TC",system-ui,-apple-system,"Segoe UI",sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--page);color:var(--ink);font-family:var(--font-sans);font-size:14.5px;line-height:1.5}
button,input,select,textarea{font-family:inherit}

/* 頁首 */
.top{display:flex;align-items:center;gap:10px;margin:2px 2px 8px}
.top__logo{width:34px;height:34px;border-radius:10px;flex:0 0 auto}
.top__title{font-size:20px;font-weight:700}
.top__ver{margin-left:auto;font-size:12px;color:var(--muted)}
.sub{color:var(--ink-soft);font-size:13.5px;margin:0 2px 14px}

/* 卡片 */
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-card);box-shadow:var(--shadow-card);padding:15px 18px 16px;margin:0 0 12px}
.card h2{font-size:17px;font-weight:700;margin:0 0 6px;word-break:break-all}
.card h2::before{content:"";display:inline-block;width:5px;height:17px;border-radius:3px;background:var(--brand);margin-right:9px;vertical-align:-3px}
.path{color:var(--muted);font-size:12.5px;word-break:break-all;margin:0 0 10px}
.hint{margin:6px 0 0;color:var(--ink-soft);font-size:13.5px}
.empty{color:var(--muted);text-align:center;padding:22px 0;font-size:13.5px}

/* 狀態標籤 */
.badges{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}
.badge{font-size:12px;font-weight:600;border-radius:999px;padding:2px 10px;background:var(--processing-bg);color:var(--processing-ink)}
.badge.ok{background:var(--completed-bg);color:var(--completed-ink)}
.badge.warn{background:var(--pending-bg);color:var(--pending-ink)}

/* 表單 */
label{display:block;font-size:13px;font-weight:600;color:var(--ink-soft);margin:10px 0 5px}
textarea,input,select{width:100%;color:var(--ink);background:var(--field);border:1px solid var(--line);border-radius:var(--radius-field);padding:8px 12px;font-size:14.5px;transition:border-color .15s,background .15s,box-shadow .15s}
textarea::placeholder,input::placeholder{color:#bdb2ad}
textarea:focus,input:focus,select:focus{outline:none;border-color:var(--pink);background:#fff;box-shadow:0 0 0 3px var(--brand-soft)}
textarea{min-height:84px;resize:vertical;line-height:1.55}
input[type=file]{padding:6px 10px}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}

/* 按鈕 */
button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 16px;border:1px solid var(--line-strong);border-radius:var(--radius-field);background:#fff;color:var(--ink-soft);font-size:14px;font-weight:600;cursor:pointer;transition:background .15s,box-shadow .15s,transform .08s,color .15s}
button:hover:not(:disabled){background:var(--pink-soft);color:var(--ink)}
button:active:not(:disabled){transform:translateY(1px)}
button.primary{background:var(--brand);border-color:var(--brand);color:#fff;box-shadow:0 2px 8px rgb(226 72 76 / .25)}
button.primary:hover:not(:disabled){background:var(--brand-hover);color:#fff}
button.danger{color:var(--danger);border-color:#f3c4c5}
button.danger:hover:not(:disabled){background:var(--danger-bg);color:var(--danger)}
button:disabled{opacity:.5;cursor:default}

/* 提示 */
.msg{margin:12px 0 0;padding:10px 12px;border-radius:var(--radius-field);font-size:13.5px;background:var(--danger-bg);color:var(--danger);white-space:pre-wrap}
.msg.info{background:var(--completed-bg);color:var(--completed-ink)}
.banner{background:var(--pending-bg);color:var(--pending-ink);border-radius:var(--radius-field);padding:10px 14px;margin:12px 0 0;font-size:13.5px}
.banner .path{color:var(--pending-ink);opacity:.85}

/* 目錄瀏覽、連線清單 */
summary{cursor:pointer;font-weight:700;font-size:15.5px}
summary::marker{color:var(--brand)}
.crumbs{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.crumbs button{padding:3px 11px;font-size:13px;border-radius:10px}
.entry{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;text-align:left;margin:0 0 4px;padding:8px 12px;border-radius:10px;font-weight:500;color:var(--ink)}
.entry .path{margin:0;font-size:12px}
.conn{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font-size:13.5px;word-break:break-all}
details>.hint{margin-bottom:8px}
button{white-space:nowrap}
.conn button{flex:0 0 auto}
input+details,select+details{margin-top:12px}
/* 排版 A：三個功能區塊永遠在主畫面；按「▸」按鈕時視窗往右加寬，右邊出現面板 */
.layout{display:flex;align-items:flex-start;min-height:100vh}
main{flex:0 1 560px;min-width:0;padding:14px 16px 28px}
.ext{display:none;flex:0 0 420px;width:420px;position:sticky;top:0;height:100vh;overflow-y:auto;background:var(--surface);border-left:1px solid var(--line-strong);padding:16px 18px 24px}
.layout.ext-inline .ext{display:block;animation:ext-in .24s ease-out}
.layout.ext-overlay .ext{display:block;position:fixed;top:0;right:0;bottom:0;height:auto;width:min(420px,94vw);z-index:25;box-shadow:-14px 0 34px rgb(51 46 44 / .18);animation:ext-in .24s ease-out}
@keyframes ext-in{from{opacity:0;transform:translateX(-14px)}to{opacity:1;transform:none}}
.ext h2{font-size:17px;font-weight:700;margin:0 0 6px;padding-right:40px}
.ext h2::before{content:"";display:inline-block;width:5px;height:17px;border-radius:3px;background:var(--brand);margin-right:9px;vertical-align:-3px}
.ext__close{position:absolute;top:12px;right:14px;padding:2px 9px;font-size:13px;border-radius:10px}
.scrim{display:none;position:fixed;top:0;right:0;bottom:0;left:0;background:rgb(51 46 44 / .14);z-index:20}
.scrim.is-on{display:block}
.opener{justify-content:space-between;gap:10px}
.opener .arrow{transition:transform .2s;font-size:16px;line-height:1}
.opener.is-open{background:var(--brand);border-color:var(--brand);color:#fff}
.opener.is-open:hover:not(:disabled){background:var(--brand-hover);color:#fff}
.opener.is-open .arrow{transform:rotate(180deg)}
.opener.wide{width:100%}
.inline{display:flex;gap:8px;align-items:stretch}
.inline input{flex:1;min-width:0}
.foot{position:sticky;bottom:0;background:var(--surface);padding-top:10px;margin-top:10px;border-top:1px solid var(--line)}
.ow{padding:6px 0;border-top:1px solid rgb(176 118 27 / .25)}
.ow__name{font-weight:600;word-break:break-all}
.ow--newer .ow__name{color:var(--danger)}
.warnbox{background:var(--danger-bg);color:var(--danger);border-radius:var(--radius-field);padding:8px 12px;margin:8px 0;font-size:13.5px}
</style>
</head>
<body>
<div class="layout" id="layout">
<main>
  <div class="top"><img class="top__logo" src="__LOGO_SRC__" alt=""><div class="top__title">SVN 遠端編輯</div><div class="top__ver">v__APP_VERSION__</div></div>
  <p class="sub">把 SVN 上的檔案取到暫存區、用 Word／Excel 等軟體修改，改完再上傳回去。</p>
  <div id="banner"></div>
  <div id="pending"></div>
  <div id="sessions"></div>
  <div id="browser"></div>
  <div id="importer"></div>
  <div id="settings"></div>
</main>
<aside class="ext" id="ext" aria-live="polite"><button type="button" class="ext__close" id="extClose" aria-label="收起">✕</button><div id="extBody"></div></aside>
</div>
<div class="scrim" id="scrim"></div>
<script>
(function () {
  var TOKEN = "__EDIT_TOKEN__";
  var state = { connections: [], servers: [], sessions: [], svnAvailable: true, configured: false };
  var stateLoaded = false;
  var messages = {};
  var cardNotes = {};
  var busy = {};
  var confirmDiscard = {};
  var cards = {};
  var pendingRequest = readQuery();
  var browseRequest = readBrowseQuery();
  var settingsForm = { id: "", name: "", url: "", username: "", password: "" };
  var serverForm = { id: "", name: "", url: "", username: "", password: "" };
  var serverBusy = false;
  var settingsNote = null;

  function readQuery() {
    var q = new URLSearchParams(location.search);
    var path = (q.get("path") || "").trim();
    if (!path) return null;
    return { connection: (q.get("connection") || "").trim(), path: path, ticket: (q.get("ticket") || "").trim() };
  }

  function readBrowseQuery() {
    var q = new URLSearchParams(location.search);
    if (!q.has("browse")) return null;
    return { connection: (q.get("connection") || "").trim(), path: (q.get("browse") || "").trim().replace(/^[/]+|[/]+$/g, ""), ticket: (q.get("ticket") || "").trim() };
  }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") el.className = attrs[k];
      else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
    });
    function add(c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    for (var i = 2; i < arguments.length; i++) add(arguments[i]);
    return el;
  }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { "X-Edit-Token": TOKEN, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.error || ("請求失敗（HTTP " + r.status + "）")); e.code = data.code; throw e; }
        return data;
      });
    });
  }

  var HINTS = {
    EDITOR_STILL_OPEN: "請先在 Word／Excel 存檔並關閉這個檔案，再按「上傳」。",
    REMOTE_CHANGED: "可以按「下載最新版另存」取得對方的版本，手動比對、合併後，再把內容貼回你正在編輯的檔案重新上傳。",
    NO_CHANGES: "還沒有修改任何內容。改完並存檔後再按「上傳」。",
    FILE_LOCKED: "檔案目前被別人鎖定編輯中，請等對方上傳或解除鎖定。",
    ALREADY_EDITING: "這個檔案已經有進行中的編輯，請到下方的編輯清單繼續處理。"
  };

  function refresh() {
    return api("GET", "/api/state").then(function (s) {
      state = s; stateLoaded = true;
      try { render(); } catch (e) { console.error(e); showBanner("頁面顯示發生錯誤：" + e.message, true); }
    }, function (e) { showBanner("無法連線到 svn-edit：" + e.message, true); });
  }

  function showBanner(text, isError) {
    var box = document.getElementById("banner");
    box.textContent = "";
    if (text) box.appendChild(h("div", { class: isError ? "banner" : "banner" }, text));
  }

  function render() {
    var banner = [];
    if (state.connectionsError) banner.push(state.connectionsError);
    if (!state.svnAvailable) banner.push("找不到 svn 命令列工具。請安裝 TortoiseSVN，並在安裝時勾選「command line client tools」，裝好後重新整理這個頁面。");
    showBanner(banner.join("\n"), true);
    renderPending();
    renderSessions();
    renderBrowser();
    renderImporter();
    renderSettings();
    renderExt();
    // 第一次使用、還沒設定任何連線：直接把「連線」面板打開
    if (stateLoaded && !state.configured && !extAutoOpened) { extAutoOpened = true; if (ext.view === null) openExt("conn"); }
  }

  // ---- 準備開始編輯（從 dev-pipeline 按鈕或連結進來） ----
  var pendingNote = null;
  var pendingSig = "";
  function renderPending() {
    var box = document.getElementById("pending");
    var sig = JSON.stringify([pendingRequest, pendingNote, state.connections]);
    if (sig === pendingSig) return;
    pendingSig = sig;
    box.textContent = "";
    if (!pendingRequest) return;
    var req = pendingRequest;
    var select = null;
    if (!req.connection && state.connections.length !== 1) {
      select = h("select", { id: "pendingConn" }, state.connections.map(function (c) { return h("option", { value: c.id }, c.name); }));
    }
    var connName = req.connection || (state.connections.length === 1 ? state.connections[0].name : "");
    var startBtn = h("button", { class: "primary", onclick: function () {
      var conn = req.connection || (select ? select.value : (state.connections[0] && state.connections[0].id));
      if (!conn) { pendingNote = "請先在下方「連線設定」新增 SVN 連線。"; renderPending(); return; }
      startBtn.disabled = true; startBtn.textContent = "取出檔案中…";
      api("POST", "/api/open", { connection: conn, path: req.path, ticket: req.ticket }).then(function () {
        pendingRequest = null; pendingNote = null; history.replaceState(null, "", location.pathname); return refresh();
      }).catch(function (e) {
        startBtn.disabled = false; startBtn.textContent = "開始編輯";
        pendingNote = e.message + (HINTS[e.code] ? "\n" + HINTS[e.code] : ""); renderPending();
      });
    } }, "開始編輯");
    box.appendChild(h("div", { class: "card" },
      h("h2", null, "要開始編輯這個檔案嗎？"),
      h("p", { class: "path" }, req.path),
      h("div", { class: "badges" }, connName ? h("span", { class: "badge" }, "連線：" + connName) : null, req.ticket ? h("span", { class: "badge" }, "票號：" + req.ticket) : null),
      select ? h("div", null, h("label", null, "選擇連線"), select) : null,
      h("p", { class: "hint" }, "會把檔案取到暫存資料夾並用預設程式開啟；Word、Excel 檔會先在 SVN 上鎖定，避免別人同時修改。"),
      pendingNote ? h("div", { class: "msg" }, pendingNote) : null,
      h("div", { class: "row" }, startBtn, h("button", { onclick: function () { pendingRequest = null; pendingNote = null; history.replaceState(null, "", location.pathname); render(); } }, "取消"))
    ));
  }

  // ---- 編輯清單 ----
  function sessionSig(s) {
    return [s.session.id, s.modified, s.editorStillOpen, busy[s.session.id] || "", cardNotes[s.session.id] ? cardNotes[s.session.id].text : "", !!confirmDiscard[s.session.id]].join("|");
  }

  function renderSessions() {
    var box = document.getElementById("sessions");
    var live = {};
    state.sessions.forEach(function (s) { live[s.session.id] = true; });
    Object.keys(cards).forEach(function (id) { if (!live[id]) { if (cards[id].el.parentNode) cards[id].el.parentNode.removeChild(cards[id].el); delete cards[id]; } });
    if (state.sessions.length === 0) return;
    state.sessions.forEach(function (s, index) {
      var id = s.session.id;
      var sig = sessionSig(s);
      if (!cards[id] || cards[id].sig !== sig) {
        var hadFocus = cards[id] && document.activeElement === cards[id].textarea;
        var built = buildCard(s);
        if (cards[id] && cards[id].el.parentNode) cards[id].el.parentNode.replaceChild(built.el, cards[id].el);
        cards[id] = { el: built.el, textarea: built.textarea, sig: sig };
        if (hadFocus) built.textarea.focus();
      }
      if (!cards[id].el.parentNode) box.appendChild(cards[id].el);
    });
  }

  function buildCard(s) {
    var session = s.session;
    var id = session.id;
    if (messages[id] === undefined) messages[id] = session.ticket ? "[" + session.ticket + "] " : "";
    var note = cardNotes[id];
    var disabled = !!busy[id];
    var textarea = h("textarea", { placeholder: "說明這次改了什麼（必填）", oninput: function () { messages[id] = textarea.value; } });
    textarea.value = messages[id];
    function run(label, fn) {
      busy[id] = label; cardNotes[id] = null; render();
      fn().then(function (result) { busy[id] = ""; if (result && result.note) cardNotes[id] = { text: result.note, info: true }; return refresh(); })
        .catch(function (e) { busy[id] = ""; cardNotes[id] = { text: e.message + (HINTS[e.code] ? "\n" + HINTS[e.code] : ""), info: false }; return refresh(); });
    }
    var commit = h("button", { class: "primary", disabled: disabled ? "disabled" : null, onclick: function () {
      run("上傳中…", function () {
        return api("POST", "/api/commit", { id: id, message: messages[id] }).then(function (r) {
          delete messages[id]; delete cardNotes[id];
          return { note: null, done: r };
        });
      });
    } }, busy[id] === "上傳中…" ? "上傳中…" : "上傳");
    var discard = h("button", { class: "danger", disabled: disabled ? "disabled" : null, onclick: function () {
      if (!confirmDiscard[id]) { confirmDiscard[id] = true; render(); return; }
      delete confirmDiscard[id];
      run("放棄中…", function () { return api("POST", "/api/discard", { id: id }).then(function () { delete messages[id]; return null; }); });
    } }, confirmDiscard[id] ? "確定放棄？你的修改會被丟掉" : "放棄");
    var el = h("div", { class: "card" },
      h("h2", null, session.fileName),
      h("p", { class: "path" }, session.connectionName + " / " + session.path),
      h("div", { class: "badges" },
        session.locked ? h("span", { class: "badge ok" }, "已在 SVN 鎖定") : null,
        h("span", { class: "badge" }, "基準版本 r" + session.baseRevision),
        s.modified ? h("span", { class: "badge ok" }, "已修改") : h("span", { class: "badge" }, "尚未修改"),
        s.editorStillOpen ? h("span", { class: "badge warn" }, "檔案還開著（請先關閉再上傳）") : null),
      h("label", null, "上傳說明（commit 訊息）"), textarea,
      note ? h("div", { class: note.info ? "msg info" : "msg" }, note.text) : null,
      h("div", { class: "row" },
        commit,
        h("button", { disabled: disabled ? "disabled" : null, onclick: function () { run("開啟中…", function () { return api("POST", "/api/reopen", { id: id }).then(function () { return { note: "已用預設程式重新開啟檔案。" }; }); }); } }, "重新開啟檔案"),
        h("button", { disabled: disabled ? "disabled" : null, onclick: function () { run("下載中…", function () { return api("POST", "/api/export-latest", { id: id }).then(function (r) { return { note: "已把遠端最新版（r" + r.revision + "）另存到：" + r.path }; }); }); } }, "下載最新版另存"),
        discard));
    return { el: el, textarea: textarea };
  }

  // ---- 瀏覽 SVN 目錄（唯讀）：主畫面只放一張卡片，清單在往右延伸的面板裡 ----
  var browse = { connection: "", path: "", entries: null, truncated: false, loading: false, error: null, ticket: "" };
  var browseSig = "";
  var browseStarted = false;

  function findConnection(ref) {
    for (var i = 0; i < state.connections.length; i++) {
      if (state.connections[i].id === ref || state.connections[i].name === ref) return state.connections[i];
    }
    return null;
  }

  function loadBrowse(path) {
    browse.path = path; browse.loading = true; browse.error = null; browse.entries = null; renderExt();
    api("GET", "/api/browse?connection=" + encodeURIComponent(browse.connection) + "&path=" + encodeURIComponent(path)).then(function (r) {
      browse.loading = false; browse.entries = r.entries; browse.truncated = r.truncated; renderExt();
    }).catch(function (e) {
      browse.loading = false; browse.error = e.message; renderExt();
    });
  }

  // 會往右延伸的按鈕：展開中呈紅色，箭頭轉向
  function openerButton(view, label, extraClass, disabled) {
    return h("button", { type: "button", class: "opener" + (extraClass ? " " + extraClass : "") + (ext.view === view ? " is-open" : ""), disabled: disabled ? "disabled" : null, onclick: function () { openExt(view); } },
      h("span", null, label), h("span", { class: "arrow" }, "▸"));
  }
  function noConnectionHint() {
    return h("p", { class: "hint" }, "還沒有任何連線，請先到下方的「連線設定」新增一個。");
  }

  function renderBrowser() {
    var box = document.getElementById("browser");
    if (browseRequest && !browseStarted && state.connections.length > 0) {
      browseStarted = true;
      var wanted = findConnection(browseRequest.connection) || state.connections[0];
      browse.connection = wanted.id; browse.ticket = browseRequest.ticket; browse.path = browseRequest.path;
      openExt("browse");
    }
    var sig = JSON.stringify([state.connections.length, ext.view === "browse", browse.ticket]);
    if (sig === browseSig) return;
    browseSig = sig;
    box.textContent = "";
    box.appendChild(h("div", { class: "card" },
      h("h2", null, "瀏覽 SVN 目錄"),
      h("p", { class: "hint" }, "從 SVN 上選一個檔案來編輯（只會讀取，不會改動任何東西）。" + (browse.ticket ? "票號：" + browse.ticket : "")),
      state.connections.length === 0 ? noConnectionHint() : h("div", { class: "row" }, openerButton("browse", "瀏覽 SVN 目錄", "wide"))));
  }

  function renderBrowseView(box) {
    if (state.connections.length === 0) { box.appendChild(h("div", null, h("h2", null, "瀏覽 SVN 目錄"), noConnectionHint())); return; }
    if (!findConnection(browse.connection)) browse.connection = state.connections[0].id;
    var select = h("select", { onchange: function () { browse.connection = select.value; loadBrowse(""); } },
      state.connections.map(function (c) { return h("option", { value: c.id }, c.name); }));
    select.value = browse.connection;
    var segments = browse.path ? browse.path.split("/") : [];
    var crumbs = [h("button", { type: "button", onclick: function () { loadBrowse(""); } }, "根目錄")];
    segments.forEach(function (seg, index) {
      crumbs.push(h("button", { type: "button", onclick: function () { loadBrowse(segments.slice(0, index + 1).join("/")); } }, seg));
    });
    var rows = (browse.entries || []).map(function (entry) {
      var full = browse.path ? browse.path + "/" + entry.name : entry.name;
      if (entry.kind === "dir") {
        return h("button", { type: "button", class: "entry", onclick: function () { loadBrowse(full); } }, h("span", null, "📁 " + entry.name), h("span", { class: "path" }, "資料夾"));
      }
      var meta = (entry.revision ? "r" + entry.revision : "") + (entry.author ? " " + entry.author : "");
      return h("button", { type: "button", class: "entry", disabled: entry.editable ? null : "disabled", title: entry.editable ? "" : (entry.tempFile ? "這是 Word／Excel 開著文件時自動產生的暫存檔，不是文件本身（可能是被誤提交進 SVN 的）" : "不支援編輯這種檔案類型"),
        onclick: function () {
          pendingRequest = { connection: browse.connection, path: full, ticket: browse.ticket };
          closeExt(); render(); window.scrollTo(0, 0);
        } }, h("span", null, "📄 " + entry.name), h("span", { class: "path" }, entry.editable ? meta : (entry.tempFile ? "Office 暫存檔，不是文件" : "不支援編輯")));
    });
    box.appendChild(h("div", null,
      h("h2", null, "瀏覽 SVN 目錄"),
      h("p", { class: "hint" }, "點資料夾進入；點檔案會回到主畫面，出現「開始編輯」的確認卡。"),
      state.connections.length > 1 ? h("div", null, h("label", null, "連線"), select) : null,
      h("div", { class: "crumbs" }, crumbs),
      browse.loading ? h("div", { class: "empty" }, "讀取中…") : null,
      browse.error ? h("div", { class: "msg" }, browse.error) : null,
      !browse.loading && !browse.error && browse.entries && browse.entries.length === 0 ? h("div", { class: "empty" }, "這個目錄是空的。") : null,
      rows,
      browse.truncated ? h("p", { class: "hint" }, "項目太多，只顯示前 1000 個。") : null));
  }

  // ---- 新增檔案到 SVN（多個檔案、整個資料夾）----
  var MAX_FILE_BYTES = 52428800;
  var MAX_BATCH_FILES = 3000;
  var MAX_BATCH_BYTES = 524288000;
  var STAGE_PARALLEL = 4;
  var EXCLUDED_DIRS = [".svn", ".git", ".hg"];
  var EXCLUDED_FILES = ["thumbs.db", "desktop.ini", ".ds_store"];
  var importForm = {
    connection: "", path: browseRequest ? browseRequest.path : "", message: "",
    files: [], skipped: { temp: 0, empty: 0, big: 0 },
    phase: "idle", progress: 0, batch: null, plan: null, note: null
  };
  var importerSig = "";

  function fmtSize(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function cleanDir(p) { return (p || "").trim().replace(/^[/]+|[/]+$/g, ""); }
  function isExcludedPath(rel) {
    var parts = rel.split("/");
    for (var i = 0; i < parts.length - 1; i++) {
      if (EXCLUDED_DIRS.indexOf(parts[i].toLowerCase()) >= 0) return true;
    }
    var name = parts[parts.length - 1];
    return name.indexOf("~$") === 0 || name.indexOf(".~lock.") === 0 || EXCLUDED_FILES.indexOf(name.toLowerCase()) >= 0;
  }
  function importRerender() { importerSig = ""; renderImporter(); }
  function importNote(text, info) { importForm.note = { text: text, info: !!info }; importRerender(); }

  // 把選到的檔案併進清單（同一路徑以後選的為準），並略過暫存檔、系統檔、空檔案、過大的檔案
  function addFiles(items) {
    var byRel = {};
    importForm.files.forEach(function (f) { byRel[f.rel] = f; });
    var skipped = { temp: importForm.skipped.temp, empty: importForm.skipped.empty, big: importForm.skipped.big };
    items.forEach(function (it) {
      var rel = it.rel.replace(/^[/]+/, "");
      if (!rel) return;
      if (isExcludedPath(rel)) { skipped.temp++; return; }
      if (it.file.size === 0) { skipped.empty++; return; }
      if (it.file.size > MAX_FILE_BYTES) { skipped.big++; return; }
      byRel[rel] = { file: it.file, rel: rel };
    });
    var all = Object.keys(byRel).sort().map(function (k) { return byRel[k]; });
    var total = all.reduce(function (sum, f) { return sum + f.file.size; }, 0);
    if (all.length > MAX_BATCH_FILES || total > MAX_BATCH_BYTES) {
      importNote("一次最多上傳 " + MAX_BATCH_FILES + " 個檔案、總共 " + (MAX_BATCH_BYTES / 1048576) + " MB，這次選的超過了，請分批上傳。", false);
      return;
    }
    importForm.files = all; importForm.skipped = skipped; importForm.plan = null; importForm.note = null;
    importRerender();
  }
  function itemsFromInput(input, useRelative) {
    var out = [];
    for (var i = 0; i < input.files.length; i++) {
      var f = input.files[i];
      out.push({ file: f, rel: useRelative && f.webkitRelativePath ? f.webkitRelativePath : f.name });
    }
    return out;
  }

  // 拖曳進來的資料夾要自己走訪（readEntries 一次最多回 100 筆，要讀到空為止）
  function readAllEntries(reader) {
    return new Promise(function (resolve, reject) {
      var all = [];
      (function next() {
        reader.readEntries(function (batch) {
          if (!batch.length) { resolve(all); return; }
          all = all.concat(Array.prototype.slice.call(batch));
          next();
        }, reject);
      })();
    });
  }
  function walkEntry(entry) {
    if (entry.isFile) {
      return new Promise(function (resolve, reject) {
        entry.file(function (file) { resolve([{ file: file, rel: entry.fullPath }]); }, reject);
      });
    }
    if (entry.isDirectory && EXCLUDED_DIRS.indexOf(entry.name.toLowerCase()) < 0) {
      return readAllEntries(entry.createReader()).then(function (children) {
        return Promise.all(children.map(walkEntry)).then(function (lists) { return [].concat.apply([], lists); });
      });
    }
    return Promise.resolve([]);
  }
  function handleDrop(ev) {
    ev.preventDefault();
    if (importForm.phase !== "idle") return;
    var items = ev.dataTransfer && ev.dataTransfer.items;
    if (!items) return;
    var entries = [];
    for (var i = 0; i < items.length; i++) {
      var entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
      if (entry) entries.push(entry);
    }
    Promise.all(entries.map(walkEntry)).then(function (lists) { addFiles([].concat.apply([], lists)); })
      .catch(function (e) { importNote("讀取拖曳的內容失敗：" + e.message, false); });
  }
  // 沒拖到框框裡時，不要讓瀏覽器把檔案直接打開
  window.addEventListener("dragover", function (ev) { ev.preventDefault(); });
  window.addEventListener("drop", function (ev) { ev.preventDefault(); });

  // 目的地資料夾選擇器（只列資料夾，唯讀）：在往右延伸的面板裡操作，按「使用這個位置」才會填進路徑欄位
  var pick = { path: "", loadedFor: null, entries: null, loading: false, notice: null };
  function loadPick(p) {
    pick.path = p; pick.loadedFor = p; pick.loading = true; pick.entries = null; pick.notice = null;
    renderExt();
    api("GET", "/api/browse?connection=" + encodeURIComponent(importForm.connection) + "&path=" + encodeURIComponent(p)).then(function (r) {
      if (pick.loadedFor !== p) return;
      pick.loading = false;
      pick.entries = r.entries.filter(function (e) { return e.kind === "dir"; });
      renderExt();
    }, function (e) {
      if (pick.loadedFor !== p) return;
      pick.loading = false; pick.entries = [];
      pick.notice = e.code === "NOT_FOUND" ? "讀不到這個資料夾，可能還不存在（上傳時會自動建立）：" + e.message : e.message;
      renderExt();
    });
  }
  function openPick() { pick.path = cleanDir(importForm.path); openExt("pick"); }

  // 上傳：逐檔送到暫存區 → 比對遠端 → （有會覆蓋的檔案就先請使用者確認）→ 送出
  function stageAll(batch) {
    var files = importForm.files.slice();
    var next = 0;
    function worker() {
      if (next >= files.length) return Promise.resolve();
      var item = files[next++];
      var q = new URLSearchParams({ batch: batch, path: item.rel, mtime: String(item.file.lastModified || 0) });
      return fetch("/api/import/stage?" + q.toString(), { method: "POST", headers: { "X-Edit-Token": TOKEN, "Content-Type": "application/octet-stream" }, body: item.file })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            if (!r.ok) throw new Error((d.error || "傳送失敗") + "（" + item.rel + "）");
          });
        })
        .then(function () { importForm.progress++; updateProgressText(); return worker(); });
    }
    var workers = [];
    for (var i = 0; i < STAGE_PARALLEL; i++) workers.push(worker());
    return Promise.all(workers);
  }
  function updateProgressText() {
    var el = document.getElementById("importProgress");
    if (el) el.textContent = "正在傳送檔案… " + importForm.progress + " / " + importForm.files.length;
  }
  function importFailed(e) {
    var batch = importForm.batch;
    importForm.batch = null; importForm.plan = null; importForm.phase = "idle";
    if (batch) api("POST", "/api/import/cancel", { batch: batch }).catch(function () {});
    importNote(e.message || "上傳失敗", false);
  }
  function startUpload() {
    var f = importForm;
    if (f.files.length === 0) { importNote("請先選擇要上傳的檔案或資料夾。", false); return; }
    if (!f.message.trim()) { importNote("請填寫上傳說明（commit 訊息）。", false); return; }
    f.path = cleanDir(f.path);
    f.phase = "staging"; f.progress = 0; f.note = null; f.plan = null;
    importRerender();
    api("POST", "/api/import/start", {}).then(function (s) {
      f.batch = s.batch;
      return stageAll(s.batch);
    }).then(function () {
      return api("POST", "/api/import/plan", { batch: f.batch, connection: f.connection, targetDir: f.path });
    }).then(function (plan) {
      if (plan.overwrite.length === 0) return commitUpload();
      f.plan = plan; f.phase = "planned"; importRerender();
    }).catch(importFailed);
  }
  function commitUpload() {
    var f = importForm;
    f.phase = "committing"; importRerender();
    return api("POST", "/api/import/commit", { batch: f.batch, connection: f.connection, targetDir: f.path, message: f.message, ticket: browse.ticket || undefined }).then(function (r) {
      var parts = ["新增 " + r.added + " 個"];
      if (r.modified) parts.push("更新 " + r.modified + " 個");
      if (r.unchanged) parts.push("內容相同略過 " + r.unchanged + " 個");
      f.files = []; f.skipped = { temp: 0, empty: 0, big: 0 }; f.message = ""; f.batch = null; f.plan = null; f.phase = "idle";
      f.note = { text: "已上傳到 SVN" + (r.committedRevision ? "（r" + r.committedRevision + "）" : "") + "：" + parts.join("、") + "。位置：" + (r.targetDir || "（連線根目錄）"), info: true };
      pick.loadedFor = null;
      importRerender();
    }).catch(importFailed);
  }
  function cancelUpload() {
    var batch = importForm.batch;
    importForm.batch = null; importForm.plan = null; importForm.phase = "idle";
    if (batch) api("POST", "/api/import/cancel", { batch: batch }).catch(function () {});
    importRerender();
  }

  function renderImporter() {
    var box = document.getElementById("importer");
    var f = importForm;
    var sig = JSON.stringify([state.connections, f.phase, f.note, f.files.length, f.skipped, f.plan, f.connection, ext.view === "pick"]);
    if (sig === importerSig) return;
    importerSig = sig;
    box.textContent = "";
    if (state.connections.length === 0) { box.appendChild(noConnectionCard()); return; }
    if (!state.connections.some(function (c) { return c.id === f.connection; })) f.connection = state.connections[0].id;
    var idle = f.phase === "idle";

    var connSelect = h("select", { onchange: function () { f.connection = connSelect.value; pick.loadedFor = null; pick.entries = null; f.plan = null; importRerender(); } },
      state.connections.map(function (c) { return h("option", { value: c.id }, c.name); }));
    connSelect.value = f.connection;
    if (!idle) connSelect.setAttribute("disabled", "disabled");

    // 選檔案／資料夾
    var fileInput = h("input", { type: "file", multiple: "multiple", style: "display:none", onchange: function () { addFiles(itemsFromInput(fileInput, false)); } });
    var dirInput = h("input", { type: "file", webkitdirectory: "", directory: "", multiple: "multiple", style: "display:none", onchange: function () { addFiles(itemsFromInput(dirInput, true)); } });
    var total = f.files.reduce(function (sum, x) { return sum + x.file.size; }, 0);
    var preview = f.files.slice(0, 6).map(function (x) { return h("div", { class: "path", style: "margin:0" }, x.rel); });
    var skippedParts = [];
    if (f.skipped.temp) skippedParts.push("暫存檔／系統檔／.git／.svn " + f.skipped.temp + " 個");
    if (f.skipped.empty) skippedParts.push("空檔案 " + f.skipped.empty + " 個");
    if (f.skipped.big) skippedParts.push("超過 " + (MAX_FILE_BYTES / 1048576) + " MB 的檔案 " + f.skipped.big + " 個");
    var picker = h("div", null,
      h("div", { class: "row", style: "margin-top:4px" },
        h("button", { type: "button", disabled: idle ? null : "disabled", onclick: function () { fileInput.click(); } }, "選擇檔案（可多選）"),
        h("button", { type: "button", disabled: idle ? null : "disabled", onclick: function () { dirInput.click(); } }, "選擇整個資料夾"),
        f.files.length ? h("button", { type: "button", disabled: idle ? null : "disabled", onclick: function () { f.files = []; f.skipped = { temp: 0, empty: 0, big: 0 }; f.plan = null; importRerender(); } }, "清除") : null,
        fileInput, dirInput),
      h("p", { class: "hint" }, "也可以直接把檔案或資料夾拖曳到這個區塊。資料夾會連同裡面的子資料夾一起上傳，並保留資料夾名稱。"),
      f.files.length
        ? h("div", null,
            h("p", { class: "hint" }, "已選擇 " + f.files.length + " 個檔案，共 " + fmtSize(total) + "："),
            preview, f.files.length > 6 ? h("div", { class: "path", style: "margin:0" }, "…另外還有 " + (f.files.length - 6) + " 個") : null)
        : null,
      skippedParts.length ? h("p", { class: "hint" }, "已自動略過：" + skippedParts.join("、")) : null);

    // 放到 SVN 的哪裡：可以直接輸入，或按「從 SVN 選擇」在右邊的面板點選資料夾
    var pathInput = h("input", { type: "text", placeholder: "留空代表連線根目錄；不存在會自動建立", disabled: idle ? null : "disabled",
      oninput: function () { f.path = pathInput.value; }, onchange: function () { f.path = cleanDir(pathInput.value); } });
    pathInput.value = f.path;
    var pickBtn = openerButton("pick", "從 SVN 選擇", "", !idle);

    var messageInput = h("textarea", { placeholder: "說明這次上傳了什麼（必填）", disabled: idle ? null : "disabled", oninput: function () { f.message = messageInput.value; } });
    messageInput.value = f.message;

    var overwriteBox = null;
    if (f.phase === "planned" && f.plan) {
      // 有「遠端比本機新」的檔案排在最前面，並整體警告
      var details = (f.plan.overwriteDetails || f.plan.overwrite.map(function (p) { return { path: p }; })).slice();
      details.sort(function (a, b) { return (b.remoteNewer ? 1 : 0) - (a.remoteNewer ? 1 : 0); });
      var newerCount = details.filter(function (d) { return d.remoteNewer; }).length;
      var rows = details.slice(0, 10).map(function (d) {
        var remote = (d.remoteRevision ? "r" + d.remoteRevision : "") + (d.remoteAuthor ? " " + d.remoteAuthor : "") + (d.remoteDate ? " " + fmtDate(d.remoteDate) : "");
        var line = remote ? "遠端最後修改：" + remote : "";
        if (d.localModified) line += (line ? "｜" : "") + "你的檔案：" + fmtDate(d.localModified);
        return h("div", { class: "ow" + (d.remoteNewer ? " ow--newer" : "") },
          h("div", { class: "ow__name" }, (d.remoteNewer ? "⚠ " : "") + d.path),
          line ? h("div", { class: "path", style: "margin:0" }, line) : null);
      });
      overwriteBox = h("div", { class: "banner" },
        h("div", null, "遠端已經有 " + f.plan.overwrite.length + " 個同名檔案，繼續的話會更新成你這次選的內容（會產生新版本，可從 SVN 歷史還原）；另外新增 " + f.plan.add.length + " 個。"),
        newerCount > 0
          ? h("div", { class: "warnbox" }, "⚠ 其中 " + newerCount + " 個檔案，遠端的版本比你本機的檔案新。可能是別人在你修改這份檔案期間已經更新過，直接覆蓋會蓋掉對方的修改。建議先按「瀏覽 SVN 目錄」確認遠端內容，再決定要不要覆蓋。")
          : null,
        rows, details.length > 10 ? h("div", { class: "path", style: "margin:0" }, "…另外還有 " + (details.length - 10) + " 個") : null,
        h("div", { class: "row" },
          h("button", { type: "button", class: "primary", onclick: function () { commitUpload(); } }, newerCount > 0 ? "我確認，仍要覆蓋" : "確認，更新並上傳"),
          h("button", { type: "button", onclick: cancelUpload }, "取消")));
    }

    var busyText = f.phase === "staging" ? "正在傳送檔案… " + f.progress + " / " + f.files.length : (f.phase === "committing" ? "正在送出到 SVN，檔案多的話需要一點時間…" : null);
    var send = h("button", { type: "button", class: "primary", disabled: idle ? null : "disabled", onclick: startUpload },
      f.files.length > 1 ? "上傳這 " + f.files.length + " 個檔案到 SVN" : "上傳到 SVN");

    var card = h("div", { class: "card" },
      h("h2", null, "新增檔案到 SVN"),
      h("p", { class: "hint" }, "可一次上傳多個檔案或整個資料夾，只會產生一個 commit。遠端已有同名檔案時，會先請你確認再更新成新版本。Word、Excel 新檔會自動設定為「編輯前需先鎖定」。"),
      state.connections.length > 1 ? h("div", null, h("label", null, "連線"), connSelect) : null,
      h("label", null, "本機檔案或資料夾"), picker,
      h("label", null, "放到 SVN 的哪裡"), h("div", { class: "inline" }, pathInput, pickBtn),
      h("label", null, "上傳說明（commit 訊息）"), messageInput,
      busyText ? h("div", { class: "hint", id: "importProgress" }, busyText) : null,
      overwriteBox,
      f.note ? h("div", { class: f.note.info ? "msg info" : "msg" }, f.note.text) : null,
      f.phase === "planned" ? null : h("div", { class: "row" }, send));
    card.addEventListener("dragover", function (ev) { ev.preventDefault(); });
    card.addEventListener("drop", handleDrop);
    box.appendChild(card);
  }

  // ---- 連線設定：主畫面只放連線摘要，表單在往右延伸的面板裡 ----
  var settingsSig = "";
  function renderSettings() {
    var box = document.getElementById("settings");
    var sig = JSON.stringify([state.connections, state.servers, ext.view === "conn"]);
    if (sig === settingsSig) return;
    settingsSig = sig;
    box.textContent = "";
    var list = state.connections.map(function (c) {
      return h("div", { class: "conn" }, h("span", null, c.name + "（" + c.username + "）", h("br", null), h("span", { class: "path" }, c.url)));
    });
    box.appendChild(h("div", { class: "card" },
      h("h2", null, "連線設定" + (state.connections.length ? "（" + state.connections.length + " 個 repo）" : "（尚未設定）")),
      state.servers.length ? h("p", { class: "hint" }, "已登入伺服器：" + state.servers.map(function (sv) { return sv.name + "（" + sv.username + "）"; }).join("、")) : null,
      list.length ? h("div", null, list) : h("p", { class: "hint" }, "還沒有任何連線，請先填寫伺服器網址與帳密。"),
      h("div", { class: "row" }, openerButton("conn", "管理連線", "wide"))));
  }

  // 伺服器：只填上層網址＋帳密，就能用這個帳號看得到的所有 repo
  function serverSection() {
    var inputs = {};
    function sfield(key, label, type, placeholder) {
      inputs[key] = h("input", { type: type, placeholder: placeholder || "", autocomplete: "off", oninput: function () { serverForm[key] = inputs[key].value; } });
      inputs[key].value = serverForm[key];
      return h("div", null, h("label", null, label), inputs[key]);
    }
    function authNote(sv) { return sv.auth === "windows" ? "（這個伺服器用 Windows 登入驗證，已使用你目前登入的 Windows 帳號）" : ""; }
    function fail(e) { serverBusy = false; settingsNote = { text: e.message, info: false }; extSig = ""; renderExt(); }
    function busy(text) { serverBusy = true; settingsNote = { text: text, info: true }; extSig = ""; renderExt(); }
    var save = h("button", { type: "button", class: "primary", disabled: serverBusy ? "disabled" : null, onclick: function () {
      busy("正在讀取 repo 清單…");
      api("POST", "/api/servers", serverForm).then(function (r) {
        serverBusy = false; serverForm = { id: "", name: "", url: "", username: "", password: "" };
        settingsNote = { text: "已儲存，載入 " + r.server.repoCount + " 個 repo。" + authNote(r.server), info: true }; return refresh();
      }).catch(fail);
    } }, serverForm.id ? "更新並重新載入" : "儲存並載入 repo 清單");
    var list = state.servers.map(function (sv) {
      return h("div", { class: "conn" }, h("span", null, sv.name + "（" + sv.username + "）・" + sv.repoCount + " 個 repo", h("br", null), h("span", { class: "path" }, sv.url)),
        h("button", { type: "button", disabled: serverBusy ? "disabled" : null, onclick: function () {
          busy("正在重新載入 repo 清單…");
          api("POST", "/api/servers/refresh", { id: sv.id }).then(function (r) {
            serverBusy = false; settingsNote = { text: "已重新載入，共 " + r.server.repoCount + " 個 repo。" + authNote(r.server), info: true }; return refresh();
          }).catch(fail);
        } }, "重新載入"),
        h("button", { type: "button", onclick: function () { serverForm = { id: sv.id, name: sv.name, url: sv.url, username: sv.username, password: "" }; settingsNote = null; extSig = ""; renderExt(); } }, "編輯"));
    });
    return h("div", null,
      h("h2", { style: "margin-top:14px;font-size:15px" }, "SVN 伺服器（填帳密就能用所有 repo）"),
      h("p", { class: "hint" }, "填伺服器的上層網址（底下每個子目錄是一個 repo）和你自己的帳密，會自動讀出你看得到的所有 repo，不用一個一個設定。如果公司伺服器用 Windows 登入驗證，帳密可以留空，會直接用你登入電腦的帳號。伺服器上新增 repo 時按「重新載入」。"),
      list.length ? h("div", null, list) : null,
      h("form", { autocomplete: "off", onsubmit: function (ev) { ev.preventDefault(); } },
        sfield("url", "伺服器網址", "text", "https://svn.example.com/svn"),
        sfield("username", "帳號（請使用你自己的 SVN 帳號；留空＝目前的 Windows 帳號）", "text"),
        sfield("password", serverForm.id ? "密碼（留空代表不變更）" : "密碼（Windows 登入驗證可留空）", "password"),
        h("div", { class: "row" }, save, serverForm.id ? h("button", { type: "button", onclick: function () { serverForm = { id: "", name: "", url: "", username: "", password: "" }; extSig = ""; renderExt(); } }, "取消編輯") : null)));
  }

  function renderConnView(box) {
    var inputs = {};
    function field(key, label, type, placeholder) {
      inputs[key] = h("input", { type: type, placeholder: placeholder || "", autocomplete: "off", oninput: function () { settingsForm[key] = inputs[key].value; } });
      inputs[key].value = settingsForm[key];
      return h("div", null, h("label", null, label), inputs[key]);
    }
    var save = h("button", { type: "button", class: "primary", onclick: function () {
      api("POST", "/api/connections", settingsForm).then(function () {
        settingsForm = { id: "", name: "", url: "", username: "", password: "" }; settingsNote = { text: "已儲存。", info: true }; return refresh();
      }).catch(function (e) { settingsNote = { text: e.message, info: false }; extSig = ""; renderExt(); });
    } }, settingsForm.id ? "更新連線" : "新增連線");
    var list = state.connections.map(function (c) {
      return h("div", { class: "conn" }, h("span", null, c.name + "（" + c.username + "）", h("br", null), h("span", { class: "path" }, c.url)),
        h("button", { type: "button", onclick: function () { settingsForm = { id: c.id, name: c.name, url: c.url, username: c.username, password: "" }; settingsNote = null; extSig = ""; renderExt(); } }, "編輯"));
    });
    box.appendChild(h("div", null,
      h("h2", null, "連線設定" + (state.connections.length ? "（" + state.connections.length + " 個）" : "（尚未設定）")),
      h("p", { class: "hint" }, "這裡的設定跟 svn-mcp 的唯讀工具共用同一份檔案，只存在這台電腦。密碼不會再顯示出來；編輯時密碼留空代表不變更。"),
      serverSection(),
      h("h2", { style: "margin-top:18px;font-size:15px" }, "單一 repo 連線"),
      list.length ? h("div", null, list) : h("div", { class: "empty" }, "還沒有任何連線，請先新增一個。"),
      h("form", { autocomplete: "off", onsubmit: function (ev) { ev.preventDefault(); } },
        h("h2", { style: "margin-top:18px;font-size:15px" }, settingsForm.id ? "編輯連線" : "新增連線"),
        field("name", "名稱", "text", "例如：規格書庫"),
        field("url", "SVN 網址", "text", "https://svn.example.com/repo"),
        field("username", "帳號（請使用你自己的 SVN 帳號）", "text"),
        field("password", settingsForm.id ? "密碼（留空代表不變更）" : "密碼", "password"),
        settingsNote ? h("div", { class: settingsNote.info ? "msg info" : "msg" }, settingsNote.text) : null,
        h("div", { class: "row" }, save, settingsForm.id ? h("button", { type: "button", onclick: function () { settingsForm = { id: "", name: "", url: "", username: "", password: "" }; extSig = ""; renderExt(); } }, "取消編輯") : null))));
  }

  function renderPickView(box) {
    var segments = pick.path ? pick.path.split("/") : [];
    var crumbs = [h("button", { type: "button", onclick: function () { loadPick(""); } }, "根目錄")];
    segments.forEach(function (seg, i) {
      crumbs.push(h("button", { type: "button", onclick: function () { loadPick(segments.slice(0, i + 1).join("/")); } }, seg));
    });
    var rows = (pick.entries || []).map(function (e) {
      var full = pick.path ? pick.path + "/" + e.name : e.name;
      return h("button", { type: "button", class: "entry", onclick: function () { loadPick(full); } }, h("span", null, "📁 " + e.name), h("span", { class: "path" }, "進入"));
    });
    box.appendChild(h("div", null,
      h("h2", null, "從 SVN 選擇資料夾"),
      h("p", { class: "hint" }, "點資料夾進入；選好之後按下方「使用這個位置」。"),
      h("div", { class: "crumbs" }, crumbs),
      pick.loading ? h("div", { class: "empty" }, "讀取中…") : null,
      pick.notice ? h("div", { class: "hint" }, pick.notice) : null,
      !pick.loading && pick.entries && pick.entries.length === 0 && !pick.notice ? h("div", { class: "hint" }, "這個資料夾底下沒有子資料夾。") : null,
      rows,
      h("div", { class: "foot" },
        h("div", { class: "hint", style: "margin:0 0 8px" }, "目前位置：" + (pick.path || "（連線根目錄）")),
        h("div", { class: "row", style: "margin-top:0" },
          h("button", { type: "button", class: "primary", onclick: function () { importForm.path = pick.path; closeExt(); importRerender(); } }, "使用這個位置"),
          h("button", { type: "button", onclick: closeExt }, "取消")))));
  }

  // ---- 往右延伸的面板：按「▸」按鈕時視窗往右加寬，右邊出現面板；再按一次、按 ✕ 或 Esc 收起，視窗縮回原寬 ----
  var MIN_MAIN_W = 480;
  var EXT_W = 420;
  var ext = { view: null };
  var extSig = "";
  var extAutoOpened = false;
  var windowBaseWidth = null;

  function noConnectionCard() {
    return h("div", { class: "card" }, noConnectionHint());
  }
  function widenWindow() {
    if (window.innerWidth >= MIN_MAIN_W + EXT_W || windowBaseWidth !== null) return;
    windowBaseWidth = window.outerWidth;
    try { window.resizeTo(windowBaseWidth + EXT_W, window.outerHeight); } catch (e) { windowBaseWidth = null; return; }
    setTimeout(function () {
      var screenRight = (screen.availLeft || 0) + screen.availWidth;
      var over = window.screenX + window.outerWidth - screenRight;
      if (over > 0) { try { window.moveBy(-over, 0); } catch (e) {} }
    }, 150);
  }
  function restoreWindow() {
    if (windowBaseWidth === null) return;
    var base = windowBaseWidth;
    windowBaseWidth = null;
    try { window.resizeTo(base, window.outerHeight); } catch (e) {}
  }
  // 視窗夠寬就並排顯示；放不下（例如視窗無法加寬）就改成蓋在主畫面右側
  function applyExtMode() {
    var layout = document.getElementById("layout");
    var open = ext.view !== null;
    var inline = window.innerWidth >= MIN_MAIN_W + EXT_W;
    layout.classList.toggle("ext-inline", open && inline);
    layout.classList.toggle("ext-overlay", open && !inline);
    document.getElementById("scrim").classList.toggle("is-on", open && !inline);
  }
  function renderExt() {
    var box = document.getElementById("extBody");
    var sig = JSON.stringify([ext.view, state.connections, state.servers, serverBusy, serverForm.id, browse.connection, browse.path, browse.entries, browse.loading, browse.error, browse.truncated, browse.ticket, pick.path, pick.entries, pick.loading, pick.notice, settingsNote, settingsForm.id]);
    if (sig === extSig) return;
    extSig = sig;
    box.textContent = "";
    if (ext.view === "browse") renderBrowseView(box);
    else if (ext.view === "pick") renderPickView(box);
    else if (ext.view === "conn") renderConnView(box);
  }
  function refreshMainCards() {
    browseSig = ""; settingsSig = ""; importerSig = "";
    renderBrowser(); renderImporter(); renderSettings();
  }
  function prepareExt(view) {
    if (view === "browse" && state.connections.length > 0) {
      if (!findConnection(browse.connection)) browse.connection = state.connections[0].id;
      if (!browse.entries && !browse.loading && !browse.error) loadBrowse(browse.path);
    } else if (view === "pick") {
      loadPick(pick.path);
    }
  }
  function openExt(view) {
    if (ext.view === view) { closeExt(); return; }
    var wasOpen = ext.view !== null;
    ext.view = view;
    document.getElementById("layout").classList.add("ext-open");
    if (!wasOpen) widenWindow();
    setTimeout(applyExtMode, wasOpen ? 0 : 160);
    prepareExt(view);
    extSig = ""; renderExt();
    refreshMainCards();
  }
  function closeExt() {
    ext.view = null;
    var layout = document.getElementById("layout");
    layout.classList.remove("ext-open", "ext-inline", "ext-overlay");
    document.getElementById("scrim").classList.remove("is-on");
    restoreWindow();
    refreshMainCards();
  }
  document.getElementById("extClose").addEventListener("click", closeExt);
  document.getElementById("scrim").addEventListener("click", closeExt);
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && ext.view !== null) closeExt(); });
  window.addEventListener("resize", applyExtMode);
  render();
  refresh();
  setInterval(refresh, 3000);
})();
</script>
</body>
</html>`;

/** 把這個 process 的一次性 token 嵌進頁面後回傳。 */
export function renderPage(token: string): string {
  return PAGE.replace("__EDIT_TOKEN__", token)
    .replace("__LOGO_SRC__", `data:image/png;base64,${LOGO_PNG_BASE64}`)
    .replace("__APP_VERSION__", APP_VERSION);
}
