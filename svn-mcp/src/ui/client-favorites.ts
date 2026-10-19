/** 控制頁前端（瀏覽器端 JS 片段）：常用目錄（釘選）：每個專案各自釘選的資料夾與暱稱。
 * 這些片段會依序接進同一個立即執行函式（見 client.ts），所以彼此共用變數與函式；函式宣告會被提升，搬到哪個檔案都安全。 */
export const CLIENT_FAVORITES = String.raw`  function favFolders(repo) { return (prefsNow().folders || {})[repo] || []; }
  function folderNicknameOf(repo, folderPath) { return ((prefsNow().folderNicknames || {})[repo] || {})[folderPath] || ""; }
  function folderFailed(e) {
    var text = e.message || "儲存失敗";
    pick.notice = text; browse.notice = { text: text, error: true };
    refresh().then(function () { rerenderExt(); });
  }
  function copyMap(source) { var out = {}; Object.keys(source || {}).forEach(function (k) { out[k] = source[k]; }); return out; }
  /** 本地先套用（畫面立刻更新）再送出；失敗就重新讀回正確的狀態。 */
  function saveFolderNickname(repo, folderPath, text) {
    var p = prefsNow();
    var all = copyMap(p.folderNicknames);
    var mine = copyMap(all[repo]);
    if (text.trim()) mine[folderPath] = text.trim(); else delete mine[folderPath];
    if (Object.keys(mine).length) all[repo] = mine; else delete all[repo];
    setPrefs({ folderNicknames: all });
    rerenderExt();
    api("POST", "/api/repo-prefs/folder-nickname", { repo: repo, path: folderPath, nickname: text }).then(function (r) { state.repoPrefs = r.prefs; }).catch(folderFailed);
  }
  function toggleFolderStar(repo, folderPath) {
    if (!repo || !folderPath) return;
    var on = favFolders(repo).indexOf(folderPath) < 0;
    var p = prefsNow();
    var folders = copyMap(p.folders);
    var list = (folders[repo] || []).filter(function (x) { return x !== folderPath; });
    if (on) list.push(folderPath);
    if (list.length) folders[repo] = list; else delete folders[repo];
    var nickAll = copyMap(p.folderNicknames);
    if (!on && nickAll[repo]) {
      var rest = copyMap(nickAll[repo]);
      delete rest[folderPath];
      if (Object.keys(rest).length) nickAll[repo] = rest; else delete nickAll[repo];
    }
    setPrefs({ folders: folders, folderNicknames: nickAll });
    rerenderExt();
    api("POST", "/api/repo-prefs/folder", { repo: repo, path: folderPath, starred: on }).then(function (r) { state.repoPrefs = r.prefs; }).catch(folderFailed);
  }
  /** 釘選／取消釘選這個資料夾（加入或移出這個專案的常用目錄）。 */
  function folderStarButton(repo, folderPath) {
    var on = favFolders(repo).indexOf(folderPath) >= 0;
    var btn = h("button", { type: "button", class: "pin" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false", title: on ? "取消釘選" : "釘選為常用目錄（這個專案）",
      onclick: function (ev) { ev.stopPropagation(); toggleFolderStar(repo, folderPath); } });
    btn.innerHTML = PIN_SVG;
    return btn;
  }
  /** 這個專案的常用目錄區塊（沒有常用目錄就回傳 null）。goFn：點路徑要做什麼；useFn：有給就多一顆「使用」按鈕。 */
  function renderFavBox(repo, goFn, useFn) {
    var list = favFolders(repo);
    if (list.length === 0) return null;
    var rows = list.map(function (folder) {
      var nick = folderNicknameOf(repo, folder);
      var key = repo + " | " + folder;
      var label;
      if (favEditing === key) {
        var input = h("input", { class: "favnickinput", type: "text", maxlength: "30", placeholder: "暱稱（例如：後端規格）", value: nick });
        var done = false;
        var finish = function (save) {
          if (done) return; done = true; favEditing = "";
          if (save && input.value.trim() !== nick) saveFolderNickname(repo, folder, input.value);
          else { rerenderExt(); }
        };
        input.addEventListener("keydown", function (ev) { if (ev.key === "Enter") finish(true); else if (ev.key === "Escape") finish(false); });
        input.addEventListener("blur", function () { finish(true); });
        label = h("div", { class: "favlabel" }, input, h("div", { class: "favsub" }, folder));
        setTimeout(function () { input.focus(); input.select(); }, 0);
      } else {
        label = h("button", { type: "button", class: "favpath", title: "進入這個資料夾：" + folder, onclick: function () { goFn(folder); } },
          nick ? h("span", { class: "favnick" }, nick) : folder, nick ? h("span", { class: "favsub" }, folder) : null);
      }
      return h("div", { class: "favrow" },
        folderStarButton(repo, folder),
        label,
        h("button", { type: "button", class: "small", title: "替這個目錄取一個好認的暱稱（只存在你的電腦）", onclick: function () { favEditing = key; rerenderExt(); } }, nick ? "改暱稱" : "取暱稱"),
        useFn ? h("button", { type: "button", class: "primary small", title: "直接用這個資料夾當上傳位置", onclick: function () { useFn(folder); } }, "使用") : null);
    });
    return h("div", { class: "favbox" }, h("div", { class: "favbox__title" }, "📌 常用目錄（只屬於這個專案）"), rows);
  }`;
