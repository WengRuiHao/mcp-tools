/** 控制頁前端（瀏覽器端 JS 片段）：往右延伸的面板：加寬視窗、並排或覆蓋、開關、寬度計算、重畫。
 * 這些片段會依序接進同一個立即執行函式（見 client.ts），所以彼此共用變數與函式；函式宣告會被提升，搬到哪個檔案都安全。 */
export const CLIENT_PANEL = String.raw`  function noConnectionCard() {
    return h("div", { class: "card" }, noConnectionHint());
  }
  function widenWindow() {
    if (window.innerWidth >= MIN_MAIN_W + EXT_W || windowBaseWidth !== null) return;
    windowBaseWidth = window.outerWidth;
    try { window.resizeTo(windowBaseWidth + EXT_W, window.outerHeight); } catch (e) { windowBaseWidth = null; return; }
    keepWindowOnScreen();
  }
  function keepWindowOnScreen() {
    setTimeout(function () {
      var screenRight = (screen.availLeft || 0) + screen.availWidth;
      var over = window.screenX + window.outerWidth - screenRight;
      if (over > 0) { try { window.moveBy(-over, 0); } catch (e) {} }
    }, 150);
  }
  /** 右邊面板的寬度（只會變寬，關閉面板時才還原）；視窗跟著往右延伸。 */
  function setExtWidth(w) {
    if (w <= EXT_W) return;
    EXT_W = w;
    document.getElementById("layout").style.setProperty("--ext-w", w + "px");
    if (windowBaseWidth !== null) {
      try { window.resizeTo(windowBaseWidth + EXT_W, window.outerHeight); } catch (e) {}
      keepWindowOnScreen();
    } else {
      widenWindow();
    }
    setTimeout(applyExtMode, 160);
  }
  /** 瀏覽清單裡最長的一列需要多寬：檔名一行放得下就加寬面板（上限內），再長才換行。 */
  function fitExtWidth() {
    if (ext.view !== "browse" || browse.picking || !browse.entries || !fitContext) return;
    var family = getComputedStyle(document.body).fontFamily;
    var need = 0;
    browse.entries.forEach(function (entry) {
      fitContext.font = "700 14.5px " + family;
      var nameW = fitContext.measureText(entry.name + (entry.kind === "dir" ? " /" : "")).width;
      fitContext.font = "12px " + family;
      var metaW = fitContext.measureText(entryMetaText(entry)).width;
      need = Math.max(need, nameW, metaW);
    });
    // 加上勾選框、圖示、星星鈕、每列內距、面板內距、捲軸與邊框
    var maxW = Math.max(EXT_MIN_W, Math.min(EXT_MAX_W, (screen.availWidth || 1280) - MIN_MAIN_W));
    setExtWidth(Math.min(maxW, Math.ceil(need + 200)));
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
  /** 清掉快取的簽章，強制右邊面板重畫。 */
  function rerenderExt() { extSig = ""; renderExt(); }
  function renderExt() {
    var box = document.getElementById("extBody");
    var sig = JSON.stringify([ext.view, state.connections, state.servers, serverBusy, serverForm.id, browse.connection, browse.path, browse.entries, browse.loading, browse.error, browse.truncated, browse.ticket, browse.notice, browse.picking, picker.tab, pick.path, pick.entries, pick.loading, pick.notice, settingsNote, deleteConfirmId, browse.del ? [browse.del.paths, browse.del.busy, browse.del.error] : null, browse.sel, state.repoPrefs.syncLocal, state.repoPrefs.localPaths, localNote, localBusy, Object.keys(localInfo).length]);
    if (sig === extSig) return;
    extSig = sig;
    box.textContent = "";
    if (ext.view === "browse") renderBrowseView(box);
    else if (ext.view === "pick") renderPickView(box);
    else if (ext.view === "conn") renderConnView(box);
    fitExtWidth();
  }
  function refreshMainCards() {
    browseSig = ""; settingsSig = ""; importerSig = "";
    renderBrowser(); renderImporter(); renderSettings();
  }
  function prepareExt(view) {
    if (view === "browse" && state.connections.length > 0) {
      if (!browse.picking && !findConnection(browse.connection)) browse.picking = true;
      if (!browse.picking && !browse.entries && !browse.loading && !browse.error) loadBrowse(browse.path);
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
    rerenderExt();
    refreshMainCards();
  }
  function closeExt() {
    favEditing = "";
    ext.view = null;
    var layout = document.getElementById("layout");
    layout.classList.remove("ext-open", "ext-inline", "ext-overlay");
    document.getElementById("scrim").classList.remove("is-on");
    restoreWindow();
    EXT_W = EXT_MIN_W;
    layout.style.removeProperty("--ext-w");
    refreshMainCards();
  }`;
