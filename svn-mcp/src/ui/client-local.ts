/** 控制頁前端（瀏覽器端 JS 片段）：同步本地端設定與本機資料夾點選（優先用 Windows 系統視窗，備用頁面內視窗）。
 * 這些片段會依序接進同一個立即執行函式（見 client.ts），所以彼此共用變數與函式；函式宣告會被提升，搬到哪個檔案都安全。 */
export const CLIENT_LOCAL = String.raw`  function localPathsOf(repo) { var v = (prefsNow().localPaths || {})[repo]; return Array.isArray(v) ? v : (v ? [v] : []); }
  function forgetLocalInfo(dir) { delete localInfo[dir]; delete localInfoAsked[dir]; }
  /** 向伺服器問「這些本地目錄有沒有 SVN 追蹤、對應哪個遠端位置」（問過的不再問，目錄有變動才重問）。 */
  function askLocalInfo() {
    var need = [];
    Object.keys(prefsNow().localPaths || {}).forEach(function (repo) {
      localPathsOf(repo).forEach(function (dir) { if (!localInfo[dir] && !localInfoAsked[dir]) { localInfoAsked[dir] = true; need.push(dir); } });
    });
    if (!need.length) return;
    api("POST", "/api/local/inspect", { paths: need }).then(function (r) {
      r.results.forEach(function (x) { localInfo[x.path] = x; });
      rerenderExt();
    }).catch(function () { need.forEach(function (d) { delete localInfoAsked[d]; }); });
  }
  /** 本地工作目錄對應的遠端位置（相對於專案根目錄）。 */
  function remoteOfLocal(repo, info) {
    if (!info || !info.url) return "";
    var u = safeDecode(info.url).replace(/[/]+$/, "");
    var marker = "/" + repo.toLowerCase();
    var i = u.toLowerCase().lastIndexOf(marker + "/");
    if (i >= 0) return u.slice(i + marker.length + 1);
    if (u.toLowerCase().slice(-marker.length) === marker) return "（整個專案）";
    return u;
  }

  function syncSection() {
    var prefs = prefsNow();
    function save(call, okText, after) {
      localBusy = true; rerenderExt();
      return call.then(function (r) {
        state.repoPrefs = r.prefs; localBusy = false; localNote = okText ? { text: okText, info: true } : null;
        if (after) after();
        rerenderExt();
      }).catch(function (e) { localBusy = false; localNote = { text: "儲存失敗：" + e.message, info: false }; rerenderExt(); });
    }
    var toggle = h("input", { type: "checkbox", checked: prefs.syncLocal ? "checked" : null, disabled: localBusy ? "disabled" : null });
    toggle.addEventListener("change", function () { save(api("POST", "/api/repo-prefs/sync-local", { enabled: toggle.checked }), null); });
    var head = h("div", null,
      h("h2", { style: "margin-top:22px;font-size:15px" }, "同步本地端"),
      h("label", { class: "switchrow" }, h("span", null, "上傳、刪除後自動 svn update"), h("span", { class: "switch" }, toggle, h("span", { class: "switch__track" }))));
    if (!prefs.syncLocal) return head;
    askLocalInfo();

    var rows = [];
    Object.keys(prefs.localPaths || {}).sort().forEach(function (repo) {
      localPathsOf(repo).forEach(function (dir) {
        var info = localInfo[dir];
        var status = !info ? { cls: "none", text: "檢查中…" } : !info.exists ? { cls: "warn", text: "⚠ 目錄不存在" } : info.isWc ? { cls: "ok", text: "✓ 有 SVN 追蹤" } : { cls: "warn", text: "⚠ 沒有 SVN 追蹤" };
        var remote = remoteOfLocal(repo, info);
        rows.push(h("div", { class: "conn conn--local" },
          h("div", { class: "conn__main" },
            h("div", { class: "nm" }, repo, h("span", { class: "pill pill--" + status.cls }, status.text)),
            remote ? h("div", { class: "pth" }, "遠端：" + remote) : null,
            h("div", { class: "pth" }, "本地：" + dir),
            info && info.exists && !info.isWc ? h("div", { class: "warnline" }, "同步時不會更新，請重新選擇 Checkout 出來的資料夾。") : null),
          h("span", { class: "btns" },
            h("button", { type: "button", disabled: localBusy ? "disabled" : null, onclick: function () {
              chooseLocalFolder("重新選擇「" + repo + "」的本地資料夾", function (picked) {
                save(api("POST", "/api/repo-prefs/local-path/add", { repo: repo, path: picked }).then(function () {
                  return api("POST", "/api/repo-prefs/local-path/remove", { repo: repo, path: dir });
                }), "已儲存。", function () { forgetLocalInfo(dir); forgetLocalInfo(picked); });
              });
            } }, "重新選擇…"),
            h("button", { type: "button", class: "danger", disabled: localBusy ? "disabled" : null, onclick: function () {
              save(api("POST", "/api/repo-prefs/local-path/remove", { repo: repo, path: dir }), "已清除。", function () { forgetLocalInfo(dir); });
            } }, "清除"))));
      });
    });

    var select = h("select", { onchange: function () { addRepo = select.value; } },
      [h("option", { value: "" }, "（選擇專案，指向電腦上已有的資料夾）")].concat(state.connections.map(function (c) { return h("option", { value: c.name }, connLabel(c)); })));
    select.value = addRepo;
    var pick = h("button", { type: "button", class: "primary", disabled: localBusy ? "disabled" : null, onclick: function () {
      if (!select.value) { localNote = { text: "請先選擇專案。", info: false }; rerenderExt(); return; }
      var repo = select.value;
      chooseLocalFolder("選擇「" + repo + "」的本地資料夾", function (picked) {
        save(api("POST", "/api/repo-prefs/local-path/add", { repo: repo, path: picked }), "已儲存。", function () { addRepo = ""; forgetLocalInfo(picked); });
      });
    } }, "選擇資料夾…");
    return h("div", null, head,
      rows.length ? h("div", null, rows) : null,
      h("div", { class: "addrow" }, select, pick),
      localNote ? h("div", { class: localNote.info ? "msg info" : "msg" }, localNote.text) : null,
      h("p", { class: "hint", style: "margin-top:8px" }, "還沒有本地資料夾？到「瀏覽 SVN 目錄」按「⬇ Checkout 到本地」就能建立。"));
  }

  function chooseLocalFolder(title, onPick) {
    if (nativePicking) return;
    var token = { cancelled: false };
    nativePicking = token;
    var waiting = openSheet(true);
    waiting.sheet.appendChild(h("h3", { class: "sheet2__title" }, "請在跳出的視窗選擇資料夾"));
    waiting.sheet.appendChild(h("p", { class: "hint" }, "已經叫出 Windows 的「選擇資料夾」視窗。沒看到的話，請看工作列，或找找這個視窗的後面。"));
    waiting.sheet.appendChild(h("div", { class: "row" }, h("button", { type: "button", onclick: function () { token.cancelled = true; finish(); openLocalPicker(title, onPick); } }, "改用頁面內的選擇視窗")));
    function finish() { if (nativePicking === token) nativePicking = null; waiting.close(); }
    api("POST", "/api/local/pick", { title: title, start: lastPickedDir }).then(function (r) {
      if (token.cancelled) return;
      finish();
      if (r.path) { lastPickedDir = r.path; onPick(r.path); }
    }).catch(function () {
      if (token.cancelled) return;
      finish();
      openLocalPicker(title, onPick); // 叫不出系統視窗（例如不是 Windows）就退回頁面內的選擇視窗
    });
  }

  function openLocalPicker(title, onPick) {
    closeLocalPicker();
    lp = { title: title, onPick: onPick, listing: null, loading: true, error: null };
    var sh = openSheet(true, closeLocalPicker);
    lp.sheet = sh.sheet; lp.close = sh.close;
    loadLocal("");
  }
  function closeLocalPicker() { if (lp) lp.close(); lp = null; }
  function loadLocal(p) {
    var cur = lp;
    if (!cur) return;
    cur.loading = true; cur.error = null; renderLocalPicker();
    api("GET", "/api/local/list?path=" + encodeURIComponent(p)).then(function (r) {
      if (lp !== cur) return;
      cur.listing = r; cur.loading = false; renderLocalPicker();
    }).catch(function (e) {
      if (lp !== cur) return;
      cur.loading = false; cur.error = e.message; renderLocalPicker();
    });
  }
  function renderLocalPicker() {
    if (!lp) return;
    var cur = lp;
    var sheet = cur.sheet;
    sheet.textContent = "";
    var L = cur.listing;
    sheet.appendChild(h("h3", { class: "sheet2__title" }, cur.title));
    sheet.appendChild(h("p", { class: "hint" }, "點資料夾進入，找到後按「選擇這個資料夾」。有 ", h("span", { class: "pill pill--ok", style: "margin:0" }, "SVN"), " 標記的，就是有 SVN 追蹤的資料夾。"));
    var segs = L && L.path ? L.path.split("/").filter(Boolean) : [];
    var crumbs = h("div", { class: "crumbs" });
    crumbs.appendChild(segs.length ? h("button", { type: "button", onclick: function () { loadLocal(""); } }, "本機") : h("span", { class: "cur" }, "本機"));
    segs.forEach(function (seg, i) {
      var target = segs.slice(0, i + 1).join("/") + (i === 0 ? "/" : "");
      crumbs.appendChild(h("span", { class: "sep" }, "→"));
      crumbs.appendChild(i === segs.length - 1 ? h("span", { class: "cur" }, seg) : h("button", { type: "button", onclick: function () { loadLocal(target); } }, seg));
    });
    sheet.appendChild(crumbs);
    var list = h("div", { class: "fslist" });
    if (cur.loading) list.appendChild(h("div", { class: "empty" }, "讀取中…"));
    else if (cur.error) list.appendChild(h("div", { class: "msg" }, cur.error));
    else if (L) {
      if (!L.entries.length) list.appendChild(h("div", { class: "empty" }, "（這個資料夾底下沒有子資料夾）"));
      L.entries.forEach(function (e) {
        list.appendChild(h("div", { class: "fsrow", onclick: function () { loadLocal(e.path); } },
          fileBadge({ kind: "dir", name: e.name }, true), h("span", { class: "n" }, e.name), e.isWc ? h("span", { class: "pill pill--ok" }, "SVN") : null));
      });
      if (L.truncated) list.appendChild(h("div", { class: "hint", style: "padding:8px 12px" }, "項目太多，只顯示前面一部分。"));
    }
    sheet.appendChild(list);
    var canPick = !!(L && L.path) && !cur.loading;
    sheet.appendChild(h("div", { class: "sheet2__foot" },
      h("div", { class: "cur" }, L && L.path ? "目前：" + L.path + (L.inWc ? "（在 SVN 工作目錄內）" : "") : "請先選擇磁碟"),
      h("button", { type: "button", onclick: closeLocalPicker }, "取消"),
      h("button", { type: "button", class: "primary", disabled: canPick ? null : "disabled", onclick: function () { var cb = cur.onPick; var p = L.path; closeLocalPicker(); cb(p); } }, "選擇這個資料夾")));
  }`;
