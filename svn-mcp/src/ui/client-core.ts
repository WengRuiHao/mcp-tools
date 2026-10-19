/** 控制頁前端（瀏覽器端 JS 片段）：共用基礎：讀網址參數、DOM 建構、API 呼叫、重新整理與畫面骨架、警示視窗、日期與大小格式、複製、連線標籤。
 * 這些片段會依序接進同一個立即執行函式（見 client.ts），所以彼此共用變數與函式；函式宣告會被提升，搬到哪個檔案都安全。 */
export const CLIENT_CORE = String.raw`  function readQuery() {
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

  function refresh() {
    return api("GET", "/api/state").then(function (s) {
      state = s; stateLoaded = true;
      try { render(); } catch (e) { console.error(e); showBanner("頁面顯示發生錯誤：" + e.message, true); }
    }, function (e) { showBanner("無法連線到 svn-edit：" + e.message, true); });
  }

  function showBanner(text, isError) {
    var box = document.getElementById("banner");
    box.textContent = "";
    if (text) box.appendChild(h("div", { class: isError ? "banner" : "banner info", onclick: isError ? null : function () { commitNotice = ""; box.textContent = ""; } }, text));
  }

  function render() {
    var banner = [];
    if (state.connectionsError) banner.push(state.connectionsError);
    if (!state.svnAvailable) banner.push("找不到 svn 命令列工具。請安裝 TortoiseSVN，並在安裝時勾選「command line client tools」，裝好後重新整理這個頁面。");
    showBanner(banner.length ? banner.join("\n") : commitNotice, banner.length > 0);
    renderPending();
    renderSessions();
    renderBrowser();
    renderImporter();
    renderSettings();
    renderExt();
    // 第一次使用、還沒設定任何連線：直接把「連線」面板打開
    if (stateLoaded && !state.configured && !extAutoOpened) { extAutoOpened = true; if (ext.view === null) openExt("conn"); }
  }

  /** 從畫面底下滑出的視窗：半透明背景＋白色面板。點背景呼叫 onBackdrop。回傳 { el, sheet, close }，內容請放進 sheet。 */
  function openSheet(top, onBackdrop) {
    var sheet = h("div", { class: "sheet2" });
    var el = h("div", { class: "shade" + (top ? " shade--top" : "") + " on" }, sheet);
    el.addEventListener("click", function (ev) { if (ev.target === el && onBackdrop) onBackdrop(); });
    document.body.appendChild(el);
    return { el: el, sheet: sheet, close: function () { if (el.parentNode) el.parentNode.removeChild(el); } };
  }
  function showAlert(title, message) {
    function close() {
      if (alertBox && alertBox.parentNode) alertBox.parentNode.removeChild(alertBox);
      alertBox = null;
      document.removeEventListener("keydown", onKey, true);
    }
    function onKey(ev) { if (ev.key === "Escape" || ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); close(); } }
    if (alertBox) close();
    var ok = h("button", { type: "button", class: "primary", onclick: close }, "知道了");
    alertBox = h("div", { class: "modal", role: "alertdialog", "aria-modal": "true" },
      h("div", { class: "modal__box" }, h("h3", null, title), h("p", null, message), h("div", { class: "row" }, ok)));
    document.body.appendChild(alertBox);
    document.addEventListener("keydown", onKey, true);
    ok.focus();
  }
  function syncAlertTitle(sync, what) { return what + (sync.status === "failed" ? "，但同步本地端失敗" : "，但本地端沒有同步"); }

  function findConnection(ref) {
    for (var i = 0; i < state.connections.length; i++) {
      if (state.connections[i].id === ref || state.connections[i].name === ref) return state.connections[i];
    }
    return null;
  }

  /** repo 連線的顯示名稱：repo 名稱後面帶舊版取的別名（例如 PROJ-One（專案甲））。 */
  function connLabel(c) { return c.aliases && c.aliases.length ? c.name + "（" + c.aliases.join("、") + "）" : c.name; }
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  /** SVN 回傳的 ISO 時間 → 本機時間 yyyy-MM-dd HH:mm；讀不出來回傳空字串。 */
  function fmtDate(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return "";
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function fmtDuration(ms) {
    var sec = Math.round(ms / 1000);
    if (sec < 1) return "不到 1 秒";
    if (sec < 60) return sec + " 秒";
    return Math.floor(sec / 60) + " 分 " + (sec % 60) + " 秒";
  }
  /** 複製文字到剪貼簿（Edge 沒給權限時退回舊做法），完成後呼叫 done。 */
  function copyText(text, done) {
    function fallback() {
      var ta = document.createElement("textarea"); ta.value = text; ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e) { /* 複製失敗就算了 */ }
      document.body.removeChild(ta); done();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }
  function safeDecode(text) { try { return decodeURIComponent(text); } catch (e) { return text; } }
  function fmtSize(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
  }`;
