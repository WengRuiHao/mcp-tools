/** 控制頁前端（瀏覽器端 JS 片段）：瀏覽 SVN 目錄：主畫面卡片、右側面板的清單（彩色圖示、文字路徑列、勾選、批次刪除）。
 * 這些片段會依序接進同一個立即執行函式（見 client.ts），所以彼此共用變數與函式；函式宣告會被提升，搬到哪個檔案都安全。 */
export const CLIENT_BROWSE = String.raw`  function loadBrowse(path) {
    browse.path = path; browse.loading = true; browse.error = null; browse.notice = null; browse.entries = null; browse.del = null; browse.mv = null; browse.rn = null; browse.focusName = null; browse.sel = {}; renderExt();
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
    return h("p", { class: "hint" }, "還沒有任何帳號，請先到下方的「連線設定」填寫伺服器網址與帳密。");
  }

  function renderBrowser() {
    var box = document.getElementById("browser");
    if (browseRequest && !browseStarted && state.connections.length > 0) {
      browseStarted = true;
      var wanted = findConnection(browseRequest.connection) || state.connections[0];
      browse.connection = wanted.id; browse.ticket = browseRequest.ticket; browse.path = browseRequest.path; browse.picking = false;
      recordOpened(wanted.name);
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

  /** 路徑列：「根目錄 → 3-SD → 9-SOURCE」，每一段都能點回那一層，目前這一層是粗體黑字、不能點。 */
  function crumbNodes(segments, go) {
    var levels = [{ label: "根目錄", target: "" }].concat(segments.map(function (seg, i) { return { label: seg, target: segments.slice(0, i + 1).join("/") }; }));
    var nodes = [];
    levels.forEach(function (lv, i) {
      if (i > 0) nodes.push(h("span", { class: "sep" }, "→"));
      if (i === levels.length - 1) nodes.push(h("span", { class: "cur" }, lv.label));
      else nodes.push(h("button", { type: "button", title: "回到這一層", onclick: function () { go(lv.target); } }, lv.label));
    });
    return nodes;
  }
  function badgeOf(entry) {
    if (entry.kind === "dir") return { cls: "dir", text: "夾" };
    var m = /[.]([a-z0-9]+)$/i.exec(entry.name || "");
    var ext = m ? m[1].toLowerCase() : "";
    var hit = BADGE_BY_EXT[ext];
    return hit ? { cls: hit[0], text: hit[1] } : { cls: "other", text: (ext || "檔").slice(0, 4).toUpperCase() };
  }
  function fileBadge(entry, small) { var b = badgeOf(entry); return h("div", { class: "fb fb--" + b.cls + (small ? " fb--sm" : "") }, b.text); }
  /** 檔名下面那一行小字：「r2238 ・ 作者 ・ 2026-07-31 15:24」；不能編輯的檔案補上原因。 */
  function entryMetaText(entry) {
    if (entry.kind === "dir") return "";
    var parts = [];
    if (entry.revision) parts.push("r" + entry.revision);
    if (entry.author) parts.push(entry.author);
    var when = fmtDate(entry.date);
    if (when) parts.push(when);
    if (!entry.editable && !entry.viewable) parts.push(entry.tempFile ? "Office 暫存檔，不是文件" : "不支援編輯");
    return parts.join(" • ");
  }
  function fiMain(entry) {
    var meta = entryMetaText(entry);
    return h("div", { class: "fi__main" }, h("div", { class: "fi__name" }, entry.name + (entry.kind === "dir" ? " /" : "")), meta ? h("div", { class: "fi__meta" }, meta) : null);
  }
  /** 唯讀檢視：請伺服器匯出最新版並用預設程式開啟；結果顯示在面板上方的提示列。 */
  function viewFile(full) {
    browse.notice = { text: "正在取出並開啟…", error: false }; renderExt();
    api("POST", "/api/view", { connection: browse.connection, path: full }).then(function (r) {
      browse.notice = { text: "已用預設程式開啟最新版（r" + r.revision + "，唯讀）：" + full, error: false }; renderExt();
    }).catch(function (e) {
      browse.notice = { text: e.message || "開啟失敗", error: true }; renderExt();
    });
  }
  function pickBox(full) {
    var box = h("input", { type: "checkbox", class: "pick", title: "勾選（檔案或資料夾，可多選一起刪除）", checked: (browse.sel && browse.sel[full]) ? "checked" : null });
    box.addEventListener("change", function () {
      browse.sel = browse.sel || {};
      if (box.checked) browse.sel[full] = true; else delete browse.sel[full];
      rerenderExt();
    });
    return box;
  }
  function deleteBox(current) {
    var d = browse.del;
    var prefs = prefsNow();
    var localDir = prefs.localPaths && prefs.localPaths[current.name];
    var syncHint = prefs.syncLocal
      ? (localDir ? "同步本地端已開啟：本地目錄 " + localDir + " 也會一起更新。" : "同步本地端已開啟，但這個專案還沒設定本地目錄，本地端不會更新。")
      : "";
    var dirs = d.dirs || [];
    var shown = d.paths.slice(0, 8).map(function (p) { return h("div", { class: "path", style: "margin:0" }, (dirs.indexOf(p) >= 0 ? "📁 " : "📄 ") + p); });
    var area = h("textarea", { placeholder: "說明為什麼刪除（必填，會寫進 SVN 的 commit 訊息）", disabled: d.busy ? "disabled" : null, oninput: function () { d.message = area.value; } });
    area.value = d.message;
    function fail(text) { d.busy = false; d.error = text; rerenderExt(); }
    var confirmBtn = h("button", { type: "button", class: "danger", disabled: d.busy ? "disabled" : null, onclick: function () {
      if (!d.message.trim()) { fail("請填寫刪除說明"); return; }
      d.busy = true; d.error = null; rerenderExt();
      api("POST", "/api/delete", { connection: browse.connection, paths: d.paths, message: d.message }).then(function (r) {
        var sync = r.localSync;
        var count = r.paths.length;
        loadBrowse(browse.path);
        browse.notice = { text: "已刪除 " + count + " 個項目（r" + r.deletedRevision + "）" + (sync && sync.status === "updated" ? "。" + sync.message : ""), error: false };
        rerenderExt();
        if (sync && sync.status !== "updated") showAlert(syncAlertTitle(sync, "已刪除 SVN 上的項目"), sync.message);
      }).catch(function (e) { fail(e.message + (HINTS[e.code] ? String.fromCharCode(10) + HINTS[e.code] : "")); });
    } }, d.busy ? "刪除中…" : "確定刪除 " + d.paths.length + " 個項目");
    return h("div", { class: "delbox" },
      h("p", null, h("strong", null, "要刪除 SVN 上的這 " + d.paths.length + " 個項目嗎？")),
      h("div", { style: "margin:0 0 8px" }, shown, d.paths.length > shown.length ? h("div", { class: "path", style: "margin:0" }, "…另外還有 " + (d.paths.length - shown.length) + " 個") : null),
      dirs.length ? h("div", { class: "warnbox" }, "其中 " + dirs.length + " 個是資料夾，會連同底下所有檔案一起刪除。") : null,
      h("p", { class: "hint", style: "margin:0 0 8px" }, "會產生一個新版本，之後仍可從 SVN 歷史還原。" + syncHint),
      area,
      d.error ? h("div", { class: "msg" }, d.error) : null,
      h("div", { class: "row" }, confirmBtn, h("button", { type: "button", disabled: d.busy ? "disabled" : null, onclick: function () { browse.del = null; rerenderExt(); } }, "取消")));
  }

  /** 移動面板裡的資料夾清單：只列資料夾；被選中要移動的資料夾本身不能進去（不能移到自己裡面）。 */
  function loadMoveTarget(p) {
    var m = browse.mv; if (!m) return;
    m.target = p; m.loadedFor = p; m.loading = true; m.entries = null; m.error = null; rerenderExt();
    api("GET", "/api/browse?connection=" + encodeURIComponent(browse.connection) + "&path=" + encodeURIComponent(p)).then(function (r) {
      if (!browse.mv || browse.mv.loadedFor !== p) return;
      m.loading = false; m.entries = r.entries.filter(function (e) { return e.kind === "dir"; }); rerenderExt();
    }).catch(function (e) {
      if (!browse.mv || browse.mv.loadedFor !== p) return;
      m.loading = false; m.entries = []; m.error = e.message; rerenderExt();
    });
  }
  function moveBox(current) {
    var m = browse.mv;
    var prefs = prefsNow();
    var syncHint = prefs.syncLocal ? "同步本地端已開啟：移動後本地目錄也會一起更新。" : "";
    var shown = m.paths.slice(0, 8).map(function (p) { return h("div", { class: "path", style: "margin:0" }, (m.dirs.indexOf(p) >= 0 ? "📁 " : "📄 ") + p); });
    var moving = m.paths.map(function (p) { return p.toLowerCase(); });
    var segments = m.target ? m.target.split("/") : [];
    var sameDir = m.paths.every(function (p) { return (p.indexOf("/") >= 0 ? p.slice(0, p.lastIndexOf("/")) : "") === m.target; });
    var folders = (m.entries || []).map(function (e) {
      var full = m.target ? m.target + "/" + e.name : e.name;
      var blocked = moving.indexOf(full.toLowerCase()) >= 0;
      return h("button", { type: "button", class: "entry fi", disabled: blocked || m.busy ? "disabled" : null, title: blocked ? "這是要移動的資料夾，不能移到它自己裡面" : "", onclick: function () { loadMoveTarget(full); } },
        fileBadge(e), fiMain(e));
    });
    var area = h("textarea", { placeholder: "說明為什麼移動（選填，會寫進 SVN 的 commit 訊息；留空會自動補一句）", disabled: m.busy ? "disabled" : null, oninput: function () { m.message = area.value; } });
    area.value = m.message;
    function fail(text) { m.busy = false; m.error = text; rerenderExt(); }
    var confirmBtn = h("button", { type: "button", class: "primary", disabled: (m.busy || sameDir) ? "disabled" : null, title: sameDir ? "這些項目本來就在這個資料夾裡，請先進入別的資料夾" : "", onclick: function () {
      m.busy = true; m.error = null; rerenderExt();
      api("POST", "/api/move", { connection: browse.connection, paths: m.paths, targetDir: m.target, message: m.message }).then(function (r) {
        var sync = r.localSync;
        loadBrowse(browse.path);
        browse.notice = { text: "已移動 " + r.moved.length + " 個項目到「" + (r.targetDir || "根目錄") + "」（r" + r.movedRevision + "）" + (sync && sync.status === "updated" ? "。" + sync.message : ""), error: false };
        rerenderExt();
        if (sync && sync.status !== "updated") showAlert(syncAlertTitle(sync, "已移動 SVN 上的項目"), sync.message);
      }).catch(function (e) { fail(e.message + (HINTS[e.code] ? String.fromCharCode(10) + HINTS[e.code] : "")); });
    } }, m.busy ? "移動中…" : "移動到這裡（" + m.paths.length + " 個項目）");
    return h("div", { class: "movebox" },
      h("p", null, h("strong", null, "把這 " + m.paths.length + " 個項目移到哪裡？")),
      h("div", { style: "margin:0 0 8px" }, shown, m.paths.length > shown.length ? h("div", { class: "path", style: "margin:0" }, "…另外還有 " + (m.paths.length - shown.length) + " 個") : null),
      h("p", { class: "hint", style: "margin:0 0 6px" }, "在下面點進目標資料夾，再按「移動到這裡」。"),
      h("div", { class: "crumbs" }, crumbNodes(segments, loadMoveTarget)),
      h("div", { class: "hint", style: "margin:0 0 6px" }, "目標：", h("b", null, m.target || "（整個專案的根目錄）")),
      m.loading ? h("div", { class: "empty" }, "讀取中…") : null,
      !m.loading && m.entries && m.entries.length === 0 ? h("div", { class: "empty" }, "這裡沒有子資料夾。") : null,
      h("div", { style: "max-height:220px;overflow:auto;margin:0 0 8px" }, folders),
      h("p", { class: "hint", style: "margin:0 0 8px" }, "會產生一個新版本，歷史紀錄保留；目標已有同名項目時不會覆蓋。" + syncHint),
      area,
      m.error ? h("div", { class: "msg" }, m.error) : null,
      h("div", { class: "row" }, confirmBtn, h("button", { type: "button", disabled: m.busy ? "disabled" : null, onclick: function () { browse.mv = null; rerenderExt(); } }, "取消")));
  }

  /** 貼 SVN 網址直接跳到那個位置：網址對得到專案就切過去；資料夾就進入，檔案就進入所在資料夾並標示。 */
  function jumpToUrl() {
    var text = (browse.urlText || "").trim();
    if (!text || browse.urlBusy) return;
    browse.urlBusy = true; browse.urlError = null; rerenderExt();
    api("GET", "/api/resolve-url?url=" + encodeURIComponent(text)).then(function (r) {
      browse.urlBusy = false; browse.urlText = "";
      browse.connection = r.connection; browse.picking = false; browse.ticket = browse.ticket || "";
      var c = findConnection(r.connection); if (c) recordOpened(c.name);
      loadBrowse(r.dir);
      browse.focusName = r.fileName; browse.focusScrolled = false;
      browse.notice = { text: r.kind === "file" ? "已跳到「" + r.fileName + "」所在的資料夾（專案：" + r.connectionName + "）。" : "已跳到「" + (r.path || "專案根目錄") + "」（專案：" + r.connectionName + "）。", error: false };
      rerenderExt();
    }).catch(function (e) { browse.urlBusy = false; browse.urlError = e.message; rerenderExt(); });
  }
  function urlJumpBar() {
    var input = h("input", { type: "text", class: "urlinput", placeholder: "貼上 SVN 網址，直接跳到那個位置（例如 https://svn.example.com/svn/專案/資料夾）", autocomplete: "off", spellcheck: "false", disabled: browse.urlBusy ? "disabled" : null, value: browse.urlText || "",
      oninput: function () { browse.urlText = input.value; },
      onkeydown: function (ev) { if (ev.key === "Enter") { ev.preventDefault(); browse.urlText = input.value; jumpToUrl(); } } });
    return h("div", { class: "urlbar" },
      h("div", { class: "row" }, input, h("button", { type: "button", class: "primary", disabled: browse.urlBusy ? "disabled" : null, onclick: function () { browse.urlText = input.value; jumpToUrl(); } }, browse.urlBusy ? "前往中…" : "前往")),
      browse.urlError ? h("div", { class: "msg" }, browse.urlError) : null);
  }

  /** 每一列右邊的「編輯名稱」：檔案與資料夾都能改；不用填說明（commit 訊息自動產生）。 */
  function startRename(entry, full) {
    browse.rn = { path: full, kind: entry.kind, name: entry.name, busy: false, error: null }; browse.del = null; browse.mv = null; browse.notice = null; rerenderExt();
    setTimeout(function () {
      var el = document.getElementById("renameInput"); if (!el) return;
      el.focus();
      var dot = entry.kind === "file" ? entry.name.lastIndexOf(".") : -1;
      el.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
    }, 0);
  }
  function renameRow(entry, full) {
    var rn = browse.rn;
    function cancel() { browse.rn = null; rerenderExt(); }
    function submit() {
      var next = rn.name.trim();
      if (!next) { rn.error = "新名稱不能是空的"; rerenderExt(); return; }
      if (next === entry.name) { cancel(); return; }
      rn.busy = true; rn.error = null; rerenderExt();
      api("POST", "/api/rename-entry", { connection: browse.connection, path: full, newName: next }).then(function (r) {
        var sync = r.localSync;
        loadBrowse(browse.path);
        browse.notice = { text: "已改名（r" + r.renamedRevision + "）：「" + entry.name + "」→「" + r.newName + "」" + (sync && sync.status === "updated" ? "。" + sync.message : ""), error: false };
        rerenderExt();
        if (sync && sync.status !== "updated") showAlert(syncAlertTitle(sync, "已改名"), sync.message);
      }).catch(function (e) { rn.busy = false; rn.error = e.message + (HINTS[e.code] ? String.fromCharCode(10) + HINTS[e.code] : ""); rerenderExt(); });
    }
    var input = h("input", { type: "text", id: "renameInput", class: "renameinput", autocomplete: "off", spellcheck: "false", disabled: rn.busy ? "disabled" : null, value: rn.name,
      oninput: function () { rn.name = input.value; },
      onkeydown: function (ev) { if (ev.key === "Enter") { ev.preventDefault(); rn.name = input.value; submit(); } else if (ev.key === "Escape") { cancel(); } } });
    return h("div", { class: "renamerow" },
      h("div", { class: "renamerow__top" }, fileBadge(entry, true), input,
        h("button", { type: "button", class: "primary", disabled: rn.busy ? "disabled" : null, onclick: function () { rn.name = input.value; submit(); } }, rn.busy ? "改名中…" : "確定"),
        h("button", { type: "button", disabled: rn.busy ? "disabled" : null, onclick: cancel }, "取消")),
      rn.error ? h("div", { class: "msg" }, rn.error) : null);
  }

  /** 開啟「移動」面板：paths 是要移動的項目完整路徑，dirs 是其中的資料夾（不能移進自己裡面）。 */
  function startMove(paths, dirs) {
    browse.mv = { paths: paths, dirs: dirs, message: "", busy: false, error: null, target: browse.path, loadedFor: null, loading: false, entries: null }; browse.del = null; browse.rn = null; browse.notice = null;
    loadMoveTarget(browse.path);
  }

  // ---- 右鍵選單：編輯名稱、移動、釘選（資料夾），不佔列上的位置 ----
  var rowMenuEl = null;
  function closeRowMenu() {
    if (!rowMenuEl) return;
    rowMenuEl.remove(); rowMenuEl = null;
    document.removeEventListener("mousedown", onRowMenuOutside, true);
    document.removeEventListener("keydown", onRowMenuKey, true);
    window.removeEventListener("blur", closeRowMenu);
    window.removeEventListener("resize", closeRowMenu);
    document.removeEventListener("scroll", closeRowMenu, true);
  }
  function onRowMenuOutside(ev) { if (rowMenuEl && !rowMenuEl.contains(ev.target)) closeRowMenu(); }
  function onRowMenuKey(ev) {
    if (!rowMenuEl) return;
    if (ev.key === "Escape") { ev.preventDefault(); closeRowMenu(); return; }
    var items = Array.prototype.slice.call(rowMenuEl.querySelectorAll("button:not([disabled])"));
    var i = items.indexOf(document.activeElement);
    if (ev.key === "ArrowDown") { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  }
  function showRowMenu(ev, entry, full, current) {
    ev.preventDefault(); ev.stopPropagation();
    closeRowMenu();
    var isDir = entry.kind === "dir";
    var sel = browse.sel || {};
    var multi = !!sel[full] && Object.keys(sel).filter(function (k) { return sel[k]; }).length > 1;
    var item = function (text, onPick) {
      return h("button", { type: "button", class: "ctxmenu__item", role: "menuitem", onclick: function () { closeRowMenu(); onPick(); } }, text);
    };
    var items = [];
    items.push(item("✎ 編輯" + (isDir ? "資料夾" : "檔案") + "名稱", function () { startRename(entry, full); }));
    if (multi) {
      var chosen = (browse.entries || []).filter(function (e) { return sel[browse.path ? browse.path + "/" + e.name : e.name]; });
      items.push(item("➜ 移動所選（" + chosen.length + " 個項目）…", function () {
        startMove(chosen.map(function (e) { return browse.path ? browse.path + "/" + e.name : e.name; }),
          chosen.filter(function (e) { return e.kind === "dir"; }).map(function (e) { return browse.path ? browse.path + "/" + e.name : e.name; }));
      }));
    } else {
      items.push(item("➜ 移動到…", function () { startMove([full], isDir ? [full] : []); }));
    }
    if (isDir) {
      var pinned = favFolders(current.name).indexOf(full) >= 0;
      items.push(item(pinned ? "📌 取消釘選" : "📌 釘選為常用目錄", function () { toggleFolderStar(current.name, full); }));
    }
    var menu = h("div", { class: "ctxmenu", role: "menu" }, items);
    document.body.appendChild(menu);
    var w = menu.offsetWidth, hgt = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(ev.clientX, window.innerWidth - w - 4)) + "px";
    menu.style.top = Math.max(4, Math.min(ev.clientY, window.innerHeight - hgt - 4)) + "px";
    rowMenuEl = menu;
    document.addEventListener("mousedown", onRowMenuOutside, true);
    document.addEventListener("keydown", onRowMenuKey, true);
    window.addEventListener("blur", closeRowMenu);
    window.addEventListener("resize", closeRowMenu);
    document.addEventListener("scroll", closeRowMenu, true);
    items[0].focus();
  }

  function renderBrowseView(box) {
    if (state.connections.length === 0) { box.appendChild(h("div", null, h("h2", null, "瀏覽 SVN 目錄"), noConnectionHint())); return; }
    if (browse.picking || !findConnection(browse.connection)) { box.appendChild(urlJumpBar()); renderProjectPicker(box); return; }
    var current = findConnection(browse.connection);
    var projbar = h("div", { class: "projbar" },
      h("button", { type: "button", onclick: backToPicker }, "← 專案清單"),
      h("strong", { class: "projbar__name" }, connLabel(current)),
      starButton(current));
    var segments = browse.path ? browse.path.split("/") : [];
    var crumbs = crumbNodes(segments, loadBrowse);
    function entryNode(entry) {
      var full = browse.path ? browse.path + "/" + entry.name : entry.name;
      if (entry.viewable) {
        return h("button", { type: "button", class: "entry fi", title: "用電腦預設的程式開啟最新版（唯讀，不能編輯、也不會改動 SVN）", onclick: function () { viewFile(full); } },
          fileBadge(entry), fiMain(entry));
      }
      if (entry.kind === "dir") {
        var dirRow = h("div", { class: "entry entry--row fi", role: "button", tabindex: "0", onclick: function () { loadBrowse(full); } },
          fileBadge(entry), fiMain(entry));
        dirRow.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && ev.target === dirRow) loadBrowse(full); });
        return dirRow;
      }
      return h("button", { type: "button", class: "entry fi", disabled: entry.editable ? null : "disabled", title: entry.editable ? "" : (entry.tempFile ? "這是 Word／Excel 開著文件時自動產生的暫存檔，不是文件本身（可能是被誤提交進 SVN 的）" : "不支援編輯這種檔案類型"),
        onclick: function () {
          pendingRequest = { connection: browse.connection, path: full, ticket: browse.ticket };
          closeExt(); render(); window.scrollTo(0, 0);
        } }, fileBadge(entry), fiMain(entry));
    }
    var rows = (browse.entries || []).map(function (entry) {
      var full = browse.path ? browse.path + "/" + entry.name : entry.name;
      if (browse.rn && browse.rn.path === full) return h("div", { class: "entryrow entryrow--edit" }, renameRow(entry, full));
      var hit = !!browse.focusName && entry.name === browse.focusName;
      var row = h("div", { class: "entryrow" + (hit ? " entryrow--hit" : "") }, pickBox(full), entryNode(entry));
      row.addEventListener("contextmenu", function (ev) { showRowMenu(ev, entry, full, current); });
      if (hit && !browse.focusScrolled) { browse.focusScrolled = true; setTimeout(function () { row.scrollIntoView({ block: "center" }); }, 0); }
      return row;
    });
    var fileEntries = browse.entries || []; // 檔案與資料夾都能勾選刪除
    function fullOf(e) { return browse.path ? browse.path + "/" + e.name : e.name; }
    var sel = browse.sel || (browse.sel = {});
    var picked = fileEntries.filter(function (e) { return sel[fullOf(e)]; });
    var allBox = h("input", { type: "checkbox", checked: (fileEntries.length && picked.length === fileEntries.length) ? "checked" : null });
    allBox.addEventListener("change", function () {
      fileEntries.forEach(function (e) { if (allBox.checked) sel[fullOf(e)] = true; else delete sel[fullOf(e)]; });
      rerenderExt();
    });
    var selBar = fileEntries.length ? h("div", { class: "selbar" },
      h("label", null, allBox, "全選"),
      h("span", { class: "grow" }, picked.length ? "已選 " + picked.length + " 個項目" : ""),
      picked.length ? h("button", { type: "button", class: "danger", onclick: function () {
        browse.del = { paths: picked.map(fullOf), dirs: picked.filter(function (e) { return e.kind === "dir"; }).map(fullOf), message: "", busy: false, error: null }; browse.mv = null; browse.notice = null; rerenderExt();
      } }, "刪除所選") : null,
      picked.length ? h("button", { type: "button", onclick: function () {
        startMove(picked.map(fullOf), picked.filter(function (e) { return e.kind === "dir"; }).map(fullOf));
      } }, "移動所選") : null) : null;
    var dirCount = fileEntries.filter(function (e) { return e.kind === "dir"; }).length;
    var stats = fileEntries.length ? h("div", { class: "stat" }, dirCount + " 個資料夾、" + (fileEntries.length - dirCount) + " 個檔案") : null;
    var trackbar = h("div", { class: "trackbar" },
      h("span", null, "目前這一層：", h("b", null, browse.path || "（整個專案）")),
      h("button", { type: "button", class: "primary", title: "把這個目錄取到你的電腦，建立 SVN 追蹤", onclick: function () { openCheckout(current); } }, "⬇ Checkout 到本地"));
    box.appendChild(h("div", null,
      h("h2", null, "瀏覽 SVN 目錄"),
      urlJumpBar(),
      h("p", { class: "hint" }, "點資料夾進入；點檔案會回到主畫面，出現「開始編輯」的確認卡。PDF（👁）只能開啟檢視，不能編輯。在檔案或資料夾上按滑鼠右鍵，可以改名、移動、釘選。"),
      browse.notice ? h("div", { class: browse.notice.error ? "msg" : "hint" }, browse.notice.text) : null,
      browse.del ? deleteBox(current) : null,
      browse.mv ? moveBox(current) : null,
      projbar,
      renderFavBox(current.name, loadBrowse, null),
      h("div", { class: "crumbs" }, crumbs),
      trackbar,
      browse.path ? h("div", { class: "hint", style: "margin:0 0 8px;display:flex;align-items:center;gap:8px" },
        folderStarButton(current.name, browse.path),
        h("span", { style: "flex:1;min-width:0;overflow-wrap:anywhere" }, "目前位置：" + browse.path + (favFolders(current.name).indexOf(browse.path) >= 0 ? "　（已是常用目錄）" : "　（點 📌 釘選為常用目錄）"))) : null,
      browse.loading ? h("div", { class: "empty" }, "讀取中…") : null,
      browse.error ? h("div", { class: "msg" }, browse.error) : null,
      !browse.loading && !browse.error && browse.entries && browse.entries.length === 0 ? h("div", { class: "empty" }, "這個目錄是空的。") : null,
      selBar,
      rows,
      stats,
      browse.truncated ? h("p", { class: "hint" }, "項目太多，只顯示前 1000 個。") : null));
  }`;
