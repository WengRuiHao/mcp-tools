/** 控制頁前端（瀏覽器端 JS 片段）：新增檔案到 SVN：選檔、拖曳、暫存、確認覆蓋、提交；以及「從 SVN 選擇資料夾」面板。
 * 這些片段會依序接進同一個立即執行函式（見 client.ts），所以彼此共用變數與函式；函式宣告會被提升，搬到哪個檔案都安全。 */
export const CLIENT_UPLOAD = String.raw`  function cleanDir(p) { return (p || "").trim().replace(/^[/]+|[/]+$/g, ""); }
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

  // ---- 常用目錄（針對每個專案各自的星星目錄）：常傳／常看同幾個深層資料夾時，不用每次一層一層點 ----
  // 「從 SVN 選擇資料夾」與「瀏覽 SVN 目錄」共用同一份資料與同一個元件，所以星星、暱稱兩邊同步。
  function uploadRepo() { var c = findConnection(importForm.connection); return c ? c.name : ""; }
  /** 上傳卡換專案：「放到 SVN 的哪裡」清空（舊專案的路徑在新專案多半不存在）、舊的覆蓋預覽作廢，
   *  「從 SVN 選擇」面板開著就立刻改列新專案的根目錄。 */
  function changeUploadProject(c) {
    var f = importForm;
    if (f.connection === c.id) return;
    f.connection = c.id; f.path = ""; f.plan = null;
    pick.path = ""; pick.loadedFor = null; pick.entries = null; pick.notice = null;
    recordOpened(c.name);
    if (ext.view === "pick") loadPick("");
    importRerender();
  }

  // 上傳：逐檔送到暫存區 → 比對遠端 → （有會覆蓋的檔案就先請使用者確認）→ 送出
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  /**
   * 逐檔送到暫存區。某個檔案傳不出去（選取之後被刪除、改名，或暫時連不上）：重試幾次，仍然不行就記到「讀不到的檔案」、
   * 繼續送其他的，不會因為一個檔案讓整批（六萬個檔案要傳好幾分鐘）重來；伺服器明確拒絕（路徑不合法、太大）才中止。
   * 連續很多個都失敗，代表不是個別檔案的問題（svn-edit 關了、網路斷了），直接中止。
   */
  function stageAll(batch) {
    var files = importForm.files.slice();
    var next = 0;
    var consecutive = 0;
    importForm.unreadable = [];
    function sendOne(item, attempt) {
      var q = new URLSearchParams({ batch: batch, path: item.rel, mtime: String(item.file.lastModified || 0) });
      return fetch("/api/import/stage?" + q.toString(), { method: "POST", headers: { "X-Edit-Token": TOKEN, "Content-Type": "application/octet-stream" }, body: item.file })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            if (!r.ok) { var err = new Error((d.error || "傳送失敗") + "（" + item.rel + "）"); err.rejected = true; throw err; }
          });
        })
        .catch(function (e) {
          if (e.rejected) throw e;
          if (attempt < STAGE_RETRIES) return wait(400 * attempt).then(function () { return sendOne(item, attempt + 1); });
          var bad = new Error("無法傳送（" + item.rel + "）"); bad.unreadable = true; throw bad;
        });
    }
    function worker() {
      if (next >= files.length) return Promise.resolve();
      var item = files[next++];
      return sendOne(item, 1).then(function () { consecutive = 0; }, function (e) {
        if (!e.unreadable) throw e;
        importForm.unreadable.push(item.rel);
        consecutive++;
        if (consecutive >= STAGE_MAX_CONSECUTIVE_FAILS) throw new Error("連續 " + consecutive + " 個檔案都傳送失敗，svn-edit 可能已經關閉、網路中斷，或這些檔案被別的程式移走了。已停止上傳（最後一個：" + item.rel + "）。");
      }).then(function () { importForm.progress++; updateProgressText(); return worker(); });
    }
    var workers = [];
    for (var i = 0; i < STAGE_PARALLEL; i++) workers.push(worker());
    return Promise.all(workers);
  }
  function committingText() {
    var secs = Math.floor((Date.now() - (importForm.commitStartedAt || Date.now())) / 1000);
    var took = secs >= 60 ? Math.floor(secs / 60) + " 分 " + (secs % 60) + " 秒" : secs + " 秒";
    return "正在送出到 SVN（已經 " + took + "）。檔案很多時需要很久，請不要關閉這個視窗。";
  }
  function updateProgressText() {
    var el = document.getElementById("importProgress");
    if (!el) return;
    if (importForm.phase === "committing") el.textContent = committingText();
    else if (importForm.phase === "staging") el.textContent = "正在傳送檔案… " + importForm.progress + " / " + importForm.files.length;
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
    f.phase = "staging"; f.progress = 0; f.note = null; f.plan = null; f.startedAt = Date.now(); f.stagingMs = 0;
    importRerender();
    f.unreadable = []; f.commitError = "";
    api("POST", "/api/import/start", {}).then(function (s) {
      f.batch = s.batch;
      return stageAll(s.batch);
    }).then(function () {
      if (f.unreadable.length > 0) { f.phase = "unreadable"; importRerender(); return null; }
      return planStaged();
    }).catch(importFailed);
  }
  /** 檔案都傳到暫存區之後：比對遠端（檔案多的話要幾分鐘），沒有要覆蓋的就直接送出，有的話先請使用者確認。 */
  function planStaged() {
    var f = importForm;
    f.phase = "planning"; importRerender();
    return api("POST", "/api/import/plan", { batch: f.batch, connection: f.connection, targetDir: f.path }).then(function (plan) {
      f.stagingMs = Date.now() - f.startedAt;
      if (plan.overwrite.length === 0) return commitUpload();
      f.plan = plan; f.phase = "planned"; importRerender();
    });
  }
  function commitUpload() {
    var f = importForm;
    f.phase = "committing"; f.commitError = ""; f.commitStartedAt = Date.now(); importRerender();
    var commitStartedAt = f.commitStartedAt;
    var commitTimer = setInterval(updateProgressText, 1000);
    return api("POST", "/api/import/commit", { batch: f.batch, connection: f.connection, targetDir: f.path, message: f.message, ticket: browse.ticket || undefined }).then(function (r) {
      clearInterval(commitTimer);
      var skippedBad = f.unreadable.length;
      var parts = ["新增 " + r.added + " 個"];
      if (r.modified) parts.push("更新 " + r.modified + " 個");
      if (r.unchanged) parts.push("內容相同略過 " + r.unchanged + " 個");
      // 耗時 = 傳檔案 + 送出 commit；不含使用者在覆蓋確認畫面停留的時間
      var tookMs = (f.stagingMs || 0) + (Date.now() - commitStartedAt);
      f.files = []; f.skipped = { temp: 0, empty: 0, big: 0 }; f.message = ""; f.batch = null; f.plan = null; f.phase = "idle"; f.unreadable = []; f.commitError = "";
      f.note = { text: "已上傳到 SVN" + (r.committedRevision ? "（r" + r.committedRevision + "）" : "") + "：" + parts.join("、") + (skippedBad ? "（另有 " + skippedBad + " 個檔案讀取失敗，已略過）" : "") + "。位置：" + (r.targetDir || "（連線根目錄）") + "。耗時：" + fmtDuration(tookMs), info: true };
      pick.loadedFor = null;
      importRerender();
    }).catch(function (e) { clearInterval(commitTimer); commitFailed(e); });
  }
  /**
   * 送出失敗：檔案都已經傳到暫存區，不要清掉（六萬個檔案重傳一次要好幾分鐘），讓使用者看原因後直接重試，或放棄。
   */
  function commitFailed(e) {
    var f = importForm;
    f.phase = "commitfailed"; f.commitError = e && e.message ? e.message : "送出失敗";
    importRerender();
  }
  function cancelUpload() {
    var batch = importForm.batch;
    importForm.batch = null; importForm.plan = null; importForm.phase = "idle"; importForm.unreadable = []; importForm.commitError = "";
    if (batch) api("POST", "/api/import/cancel", { batch: batch }).catch(function () {});
    importRerender();
  }

  function renderImporter() {
    var box = document.getElementById("importer");
    var f = importForm;
    var sig = JSON.stringify([state.connections, state.repoPrefs, f.phase, f.unreadable.length, f.commitError, f.note, f.files.length, f.skipped, f.plan, f.connection, ext.view === "pick"]);
    if (sig === importerSig) return;
    importerSig = sig;
    box.textContent = "";
    if (state.connections.length === 0) { box.appendChild(noConnectionCard()); return; }
    // 第一次、或原本選的專案不見了：預設選最近開過的專案（沒有就第一個）
    if (!state.connections.some(function (c) { return c.id === f.connection; })) f.connection = recentList()[0].id;
    var idle = f.phase === "idle";

    var connSelect = projectCombo(f.connection, !idle, changeUploadProject);

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

    var unreadableBox = null;
    if (f.phase === "unreadable") {
      var bad = f.unreadable;
      unreadableBox = h("div", { class: "banner" },
        h("div", null, "有 " + bad.length + " 個檔案沒辦法傳送（可能在你選取之後被刪除、改名，或被別的程式移走，例如 IDE 或建置工具正在更新檔案）。其他 " + (f.files.length - bad.length) + " 個檔案已經傳送完成。"),
        bad.slice(0, 10).map(function (p) { return h("div", { class: "path", style: "margin:0" }, p); }),
        bad.length > 10 ? h("div", { class: "path", style: "margin:0" }, "…另外還有 " + (bad.length - 10) + " 個") : null,
        h("div", { class: "row" },
          h("button", { type: "button", class: "primary", onclick: function () { planStaged().catch(importFailed); } }, "略過這些檔案，繼續上傳"),
          h("button", { type: "button", onclick: cancelUpload }, "取消")));
    }
    var commitFailBox = null;
    if (f.phase === "commitfailed") {
      commitFailBox = h("div", { class: "banner" },
        h("div", { class: "msg" }, f.commitError),
        h("p", { class: "hint" }, "檔案已經傳到暫存區，沒有清掉；修正問題後可以直接重試，不必重新選檔案。如果上面說「已經在送出中」，代表上一次送出還在進行，請等它完成。"),
        h("div", { class: "row" },
          h("button", { type: "button", class: "primary", onclick: function () { commitUpload(); } }, "重試送出"),
          h("button", { type: "button", onclick: cancelUpload }, "放棄並清除暫存")));
    }
    var busyText = f.phase === "staging" ? "正在傳送檔案… " + f.progress + " / " + f.files.length : (f.phase === "planning" ? "正在比對遠端已經有的檔案…（檔案很多時需要幾分鐘）" : (f.phase === "committing" ? committingText() : null));
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
      overwriteBox, unreadableBox, commitFailBox,
      f.note ? h("div", { class: f.note.info ? "msg info" : "msg" }, f.note.text) : null,
      (f.phase === "planned" || f.phase === "unreadable" || f.phase === "commitfailed") ? null : h("div", { class: "row" }, send));
    card.addEventListener("dragover", function (ev) { ev.preventDefault(); });
    card.addEventListener("drop", handleDrop);
    box.appendChild(card);
  }

  function renderPickView(box) {
    var segments = pick.path ? pick.path.split("/") : [];
    var crumbs = crumbNodes(segments, loadPick);
    var rows = (pick.entries || []).map(function (e) {
      var full = pick.path ? pick.path + "/" + e.name : e.name;
      var row = h("div", { class: "entry entry--row", role: "button", tabindex: "0", onclick: function () { loadPick(full); } },
        folderStarButton(uploadRepo(), full), h("span", { class: "entry__name" }, "📁 " + e.name), h("span", { class: "path" }, "進入"));
      row.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && ev.target === row) loadPick(full); });
      return row;
    });
    var favBox = renderFavBox(uploadRepo(), loadPick, function (folder) { importForm.path = folder; closeExt(); importRerender(); });
    box.appendChild(h("div", null,
      h("h2", null, "從 SVN 選擇資料夾"),
      h("p", { class: "hint" }, "目前專案：" + (findConnection(importForm.connection) ? connLabel(findConnection(importForm.connection)) : "（未選擇）") + "。點資料夾進入；選好之後按下方「使用這個位置」。"),
      favBox,
      h("div", { class: "crumbs" }, crumbs),
      pick.loading ? h("div", { class: "empty" }, "讀取中…") : null,
      pick.notice ? h("div", { class: "hint" }, pick.notice) : null,
      !pick.loading && pick.entries && pick.entries.length === 0 && !pick.notice ? h("div", { class: "hint" }, "這個資料夾底下沒有子資料夾。") : null,
      rows,
      h("div", { class: "foot" },
        h("div", { class: "hint", style: "margin:0 0 8px;display:flex;align-items:center;gap:8px" },
          pick.path ? folderStarButton(uploadRepo(), pick.path) : null,
          h("span", { style: "flex:1;min-width:0;overflow-wrap:anywhere" }, "目前位置：" + (pick.path || "（連線根目錄）") + (pick.path ? (favFolders(uploadRepo()).indexOf(pick.path) >= 0 ? "　（已是常用目錄）" : "　（點 📌 釘選為常用目錄）") : ""))),
        h("div", { class: "row", style: "margin-top:0" },
          h("button", { type: "button", class: "primary", onclick: function () { importForm.path = pick.path; closeExt(); importRerender(); } }, "使用這個位置"),
          h("button", { type: "button", onclick: closeExt }, "取消")))));
  }`;
