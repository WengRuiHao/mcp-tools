/**
 * svn-edit 的控制頁（單一 HTML）。由 edit-server 在 GET / 與 GET /edit 回傳，並把一次性 token
 * 嵌進頁面；頁面之後所有操作都用同源 fetch 呼叫 /api/*，一律帶 X-Edit-Token。
 *
 * 注意：下面的樣板字串裡不能出現反引號與 `${`，前端程式碼一律用字串串接。
 * 所有動態內容（檔名、路徑、訊息）都用 textContent 填入，不用 innerHTML，避免 XSS。
 */
const PAGE = String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SVN 遠端編輯</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1f2328;--muted:#656d76;--line:#d8dee4;--accent:#0969da;--danger:#cf222e;--warn:#9a6700;--ok:#1a7f37;--warnbg:#fff8c5}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--text:#e6edf3;--muted:#8d96a0;--line:#30363d;--accent:#4493f8;--danger:#f85149;--warn:#d29922;--ok:#3fb950;--warnbg:#3b2e00}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 "Microsoft JhengHei",system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 16px}
.card h2{font-size:16px;margin:0 0 4px;word-break:break-all}
.path{color:var(--muted);font-size:13px;word-break:break-all;margin:0 0 10px}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}
.badge{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:1px 10px;color:var(--muted)}
.badge.ok{color:var(--ok);border-color:var(--ok)}
.badge.warn{color:var(--warn);border-color:var(--warn)}
label{display:block;font-size:13px;color:var(--muted);margin:8px 0 4px}
textarea,input,select{width:100%;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px}
textarea{min-height:64px;resize:vertical}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:6px;padding:7px 14px;cursor:pointer}
button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:var(--danger)}
button:disabled{opacity:.5;cursor:default}
.msg{margin:12px 0 0;padding:10px 12px;border-radius:6px;font-size:14px;border:1px solid var(--danger);color:var(--danger);white-space:pre-wrap}
.msg.info{border-color:var(--ok);color:var(--ok)}
.hint{margin-top:6px;color:var(--muted);font-size:13px}
.banner{background:var(--warnbg);border:1px solid var(--warn);color:var(--warn);border-radius:8px;padding:10px 14px;margin:0 0 16px}
.empty{color:var(--muted);text-align:center;padding:24px 0}
summary{cursor:pointer;font-weight:600}
.entry{display:flex;justify-content:space-between;gap:8px;width:100%;text-align:left;margin:0 0 4px}
.crumbs{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0}
.conn{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:14px;word-break:break-all}
</style>
</head>
<body>
<main>
  <h1>SVN 遠端編輯</h1>
  <p class="sub">把 SVN 上的檔案取到暫存區、用 Word／Excel 等軟體修改，改完再上傳回去。</p>
  <div id="banner"></div>
  <div id="pending"></div>
  <div id="sessions"></div>
  <div id="browser"></div>
  <div id="importer"></div>
  <div id="settings"></div>
</main>
<script>
(function () {
  var TOKEN = "__EDIT_TOKEN__";
  var state = { connections: [], sessions: [], svnAvailable: true, configured: false };
  var messages = {};
  var cardNotes = {};
  var busy = {};
  var confirmDiscard = {};
  var cards = {};
  var pendingRequest = readQuery();
  var browseRequest = readBrowseQuery();
  var settingsForm = { id: "", name: "", url: "", username: "", password: "" };
  var settingsNote = null;
  var settingsOpened = false;

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
      state = s;
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
    var empty = document.getElementById("emptySessions");
    if (state.sessions.length === 0) {
      if (!empty) box.appendChild(h("div", { class: "empty", id: "emptySessions" }, pendingRequest ? "" : "目前沒有進行中的編輯。從 dev-pipeline 的按鈕進來，或在這裡開啟的連結會出現在這裡。"));
      return;
    }
    if (empty) empty.parentNode.removeChild(empty);
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

  // ---- 瀏覽 SVN 目錄（唯讀） ----
  var browse = { connection: "", path: "", entries: null, truncated: false, loading: false, error: null, open: false, ticket: "" };
  var browseSig = "";
  var browseStarted = false;

  function findConnection(ref) {
    for (var i = 0; i < state.connections.length; i++) {
      if (state.connections[i].id === ref || state.connections[i].name === ref) return state.connections[i];
    }
    return null;
  }

  function loadBrowse(path) {
    browse.path = path; browse.loading = true; browse.error = null; browse.entries = null; renderBrowser();
    api("GET", "/api/browse?connection=" + encodeURIComponent(browse.connection) + "&path=" + encodeURIComponent(path)).then(function (r) {
      browse.loading = false; browse.entries = r.entries; browse.truncated = r.truncated; renderBrowser();
    }).catch(function (e) {
      browse.loading = false; browse.error = e.message; renderBrowser();
    });
  }

  function renderBrowser() {
    var box = document.getElementById("browser");
    if (state.connections.length === 0) { box.textContent = ""; browseSig = ""; return; }
    if (browseRequest && !browseStarted) {
      browseStarted = true;
      var wanted = findConnection(browseRequest.connection) || state.connections[0];
      browse.connection = wanted.id; browse.ticket = browseRequest.ticket; browse.open = true;
      loadBrowse(browseRequest.path);
      return;
    }
    if (!findConnection(browse.connection)) browse.connection = state.connections[0].id;
    var sig = JSON.stringify([state.connections, browse.connection, browse.path, browse.entries, browse.loading, browse.error, browse.open]);
    if (sig === browseSig) return;
    browseSig = sig;
    box.textContent = "";
    var select = h("select", { onchange: function () { browse.connection = select.value; browse.open = true; loadBrowse(""); } },
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
      return h("button", { type: "button", class: "entry", disabled: entry.editable ? null : "disabled", title: entry.editable ? "" : "不支援編輯這種檔案類型",
        onclick: function () {
          pendingRequest = { connection: browse.connection, path: full, ticket: browse.ticket };
          render(); window.scrollTo(0, 0);
        } }, h("span", null, "📄 " + entry.name), h("span", { class: "path" }, entry.editable ? meta : "不支援編輯"));
    });
    var details = h("details", { ontoggle: function () { browse.open = details.open; if (details.open && !browse.entries && !browse.loading && !browse.error) loadBrowse(browse.path); } },
      h("summary", null, "瀏覽 SVN 目錄"),
      h("p", { class: "hint" }, "從 SVN 上選一個檔案來編輯（這裡只會讀取，不會改動任何東西）。" + (browse.ticket ? "票號：" + browse.ticket : "")),
      state.connections.length > 1 ? h("div", null, h("label", null, "連線"), select) : null,
      h("div", { class: "crumbs" }, crumbs),
      browse.loading ? h("div", { class: "empty" }, "讀取中…") : null,
      browse.error ? h("div", { class: "msg" }, browse.error) : null,
      !browse.loading && !browse.error && browse.entries && browse.entries.length === 0 ? h("div", { class: "empty" }, "這個目錄是空的。") : null,
      rows,
      browse.truncated ? h("p", { class: "hint" }, "項目太多，只顯示前 1000 個。") : null);
    details.open = browse.open;
    box.appendChild(h("div", { class: "card" }, details));
  }

  // ---- 新增檔案到 SVN ----
  var importForm = { connection: "", path: "", message: "", file: null, busy: false, note: null };
  var importerSig = "";
  function renderImporter() {
    var box = document.getElementById("importer");
    var sig = JSON.stringify([state.connections, importForm.busy, importForm.note, importForm.file ? importForm.file.name : ""]);
    if (sig === importerSig) return;
    importerSig = sig;
    box.textContent = "";
    if (state.connections.length === 0) return;
    if (!state.connections.some(function (c) { return c.id === importForm.connection; })) importForm.connection = state.connections[0].id;
    var select = h("select", { onchange: function () { importForm.connection = select.value; } },
      state.connections.map(function (c) { return h("option", { value: c.id }, c.name); }));
    select.value = importForm.connection;
    var pathInput = h("input", { type: "text", placeholder: "例如：規格書/需求說明.docx（資料夾不存在會自動建立）", oninput: function () { importForm.path = pathInput.value; } });
    pathInput.value = importForm.path;
    var messageInput = h("textarea", { placeholder: "說明這是什麼檔案（必填）", oninput: function () { importForm.message = messageInput.value; } });
    messageInput.value = importForm.message;
    var fileInput = h("input", { type: "file", accept: ".docx,.xlsx,.md,.txt", onchange: function () {
      var f = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      importForm.file = f;
      if (f && (!importForm.path || /\/$/.test(importForm.path))) { importForm.path = importForm.path + f.name; }
      importerSig = ""; renderImporter();
    } });
    var send = h("button", { type: "button", class: "primary", disabled: importForm.busy ? "disabled" : null, onclick: function () {
      if (!importForm.file) { importForm.note = { text: "請先選擇要上傳的檔案。", info: false }; importerSig = ""; renderImporter(); return; }
      importForm.busy = true; importForm.note = null; importerSig = ""; renderImporter();
      var q = new URLSearchParams({ connection: importForm.connection, path: importForm.path, message: importForm.message });
      fetch("/api/import?" + q.toString(), { method: "POST", headers: { "X-Edit-Token": TOKEN, "Content-Type": "application/octet-stream" }, body: importForm.file })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (r) {
          importForm.busy = false;
          if (r.ok) {
            importForm.note = { text: "已新增到 SVN：" + r.d.path + (r.d.committedRevision ? "（r" + r.d.committedRevision + "）" : ""), info: true };
            importForm.path = ""; importForm.message = ""; importForm.file = null;
          } else {
            importForm.note = { text: r.d.error || "新增失敗", info: false };
          }
          importerSig = ""; renderImporter();
        })
        .catch(function (e) { importForm.busy = false; importForm.note = { text: "無法連線到 svn-edit：" + e.message, info: false }; importerSig = ""; renderImporter(); });
    } }, importForm.busy ? "新增中…" : "新增到 SVN");
    box.appendChild(h("div", { class: "card" },
      h("h2", null, "新增檔案到 SVN"),
      h("p", { class: "hint" }, "選一個本機檔案，直接加進 SVN（不會覆蓋已存在的檔案）。Word、Excel 檔會自動設定為「編輯前需先鎖定」。"),
      state.connections.length > 1 ? h("div", null, h("label", null, "連線"), select) : null,
      h("label", null, "本機檔案"), fileInput,
      importForm.file ? h("p", { class: "hint" }, "已選擇：" + importForm.file.name + "（" + Math.max(1, Math.round(importForm.file.size / 1024)) + " KB）") : null,
      h("label", null, "放到 SVN 的哪裡（遠端路徑）"), pathInput,
      h("label", null, "上傳說明（commit 訊息）"), messageInput,
      importForm.note ? h("div", { class: importForm.note.info ? "msg info" : "msg" }, importForm.note.text) : null,
      h("div", { class: "row" }, send)));
  }

  // ---- 連線設定 ----
  function renderSettings() {
    var box = document.getElementById("settings");
    var settingsSig = JSON.stringify([state.connections, settingsNote, settingsForm.id, state.configured]);
    if (box.dataset.sig === settingsSig) return;
    var wasOpen = box.querySelector("details") ? box.querySelector("details").open : null;
    box.textContent = "";
    var inputs = {};
    function field(key, label, type, placeholder) {
      inputs[key] = h("input", { type: type, placeholder: placeholder || "", autocomplete: "off", oninput: function () { settingsForm[key] = inputs[key].value; } });
      inputs[key].value = settingsForm[key];
      return h("div", null, h("label", null, label), inputs[key]);
    }
    var save = h("button", { type: "button", class: "primary", onclick: function () {
      api("POST", "/api/connections", settingsForm).then(function () {
        settingsForm = { id: "", name: "", url: "", username: "", password: "" }; settingsNote = { text: "已儲存。", info: true }; return refresh();
      }).catch(function (e) { settingsNote = { text: e.message, info: false }; box.dataset.sig = ""; renderSettings(); });
    } }, settingsForm.id ? "更新連線" : "新增連線");
    var list = state.connections.map(function (c) {
      return h("div", { class: "conn" }, h("span", null, c.name + "（" + c.username + "）" + c.url),
        h("button", { type: "button", onclick: function () { settingsForm = { id: c.id, name: c.name, url: c.url, username: c.username, password: "" }; settingsNote = null; box.dataset.sig = ""; renderSettings(); } }, "編輯"));
    });
    var details = h("details", null,
      h("summary", null, "連線設定" + (state.connections.length ? "（" + state.connections.length + " 個）" : "（尚未設定）")),
      h("p", { class: "hint" }, "這裡的設定跟 svn-mcp 的唯讀工具共用同一份檔案，只存在這台電腦。密碼不會再顯示出來；編輯時密碼留空代表不變更。"),
      list.length ? h("div", null, list) : h("div", { class: "empty" }, "還沒有任何連線，請先新增一個。"),
      h("form", { autocomplete: "off", onsubmit: function (ev) { ev.preventDefault(); } },
        h("h2", { style: "margin-top:16px" }, settingsForm.id ? "編輯連線" : "新增連線"),
        field("name", "名稱", "text", "例如：規格書庫"),
        field("url", "SVN 網址", "text", "https://svn.example.com/repo"),
        field("username", "帳號（請使用你自己的 SVN 帳號）", "text"),
        field("password", settingsForm.id ? "密碼（留空代表不變更）" : "密碼", "password"),
        settingsNote ? h("div", { class: settingsNote.info ? "msg info" : "msg" }, settingsNote.text) : null,
        h("div", { class: "row" }, save, settingsForm.id ? h("button", { type: "button", onclick: function () { settingsForm = { id: "", name: "", url: "", username: "", password: "" }; box.dataset.sig = ""; renderSettings(); } }, "取消編輯") : null)));
    var open = wasOpen !== null ? wasOpen : (!state.configured || !!settingsForm.id);
    if (!settingsOpened && !state.configured) { open = true; settingsOpened = true; }
    details.open = open;
    box.appendChild(h("div", { class: "card" }, details));
    box.dataset.sig = settingsSig;
  }

  render();
  refresh();
  setInterval(refresh, 3000);
})();
</script>
</body>
</html>`;

/** 把這個 process 的一次性 token 嵌進頁面後回傳。 */
export function renderPage(token: string): string {
  return PAGE.replace("__EDIT_TOKEN__", token);
}
