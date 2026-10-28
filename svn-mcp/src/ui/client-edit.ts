/** 控制頁前端（瀏覽器端 JS 片段）：開始編輯確認卡與進行中的編輯清單（上傳、升級版本、放棄）。
 * 這些片段會依序接進同一個立即執行函式（見 client.ts），所以彼此共用變數與函式；函式宣告會被提升，搬到哪個檔案都安全。 */
export const CLIENT_EDIT = String.raw`  function renderPending() {
    var box = document.getElementById("pending");
    var sig = JSON.stringify([pendingRequest, pendingNote, state.connections]);
    if (sig === pendingSig) return;
    pendingSig = sig;
    box.textContent = "";
    if (!pendingRequest) return;
    var req = pendingRequest;
    var select = null;
    if (!req.connection && state.connections.length !== 1) {
      select = h("select", { id: "pendingConn" }, state.connections.map(function (c) { return h("option", { value: c.id }, connLabel(c)); }));
    }
    var reqConn = req.connection ? findConnection(req.connection) : null;
    var connName = reqConn ? reqConn.name : (req.connection || (state.connections.length === 1 ? state.connections[0].name : ""));
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
    function pendingConn() { return findConnection(req.connection || (select ? select.value : (state.connections[0] && state.connections[0].id))); }
    function fullUrlOf() { var c = pendingConn(); return c ? String(c.url).replace(/[/]+$/, "") + "/" + String(req.path).replace(/^[/]+/, "") : ""; }
    var urlText = h("div", { class: "loc__url" }, fullUrlOf());
    if (select) select.addEventListener("change", function () { urlText.textContent = fullUrlOf(); });
    var copyBtn = h("button", { type: "button", class: "primary", onclick: function () {
      copyText(fullUrlOf(), function () {
        copyBtn.textContent = "已複製 ✓"; copyBtn.classList.add("copied");
        setTimeout(function () { copyBtn.textContent = "複製位置"; copyBtn.classList.remove("copied"); }, 1800);
      });
    } }, "複製位置");
    var locBox = h("div", { class: "loc" }, h("div", { class: "loc__label" }, "遠端位置（完整 URL）"), h("div", { class: "loc__row" }, urlText, copyBtn));
    box.appendChild(h("div", { class: "card" },
      h("h2", null, "要開始編輯這個檔案嗎？"),
      h("p", { class: "path" }, req.path),
      h("div", { class: "badges" }, connName ? h("span", { class: "badge" }, "連線：" + connName) : null, req.ticket ? h("span", { class: "badge" }, "票號：" + req.ticket) : null),
      select ? h("div", null, h("label", null, "選擇連線"), select) : null,
      locBox,
      h("p", { class: "hint" }, "會把檔案取到暫存資料夾並用預設程式開啟；Word、Excel 檔會先在 SVN 上鎖定，避免別人同時修改。"),
      pendingNote ? h("div", { class: "msg" }, pendingNote) : null,
      h("div", { class: "row" }, startBtn, h("button", { onclick: function () { pendingRequest = null; pendingNote = null; history.replaceState(null, "", location.pathname); render(); } }, "取消"))
    ));
  }

  // ---- 編輯清單 ----
  function upgradeSig(id) {
    var u = upgrades[id];
    return u ? JSON.stringify([u.on, u.loading, u.newName, u.plan ? [u.plan.applicable, u.plan.reason, u.plan.newName, u.plan.archiveDirExists] : null]) : "";
  }

  function renameSig(id) {
    var r = renames[id];
    return r ? JSON.stringify([r.on, r.loading, r.newName, r.plan ? [r.plan.applicable, r.plan.reason, r.plan.newName] : null]) : "";
  }

  function sessionSig(s) {
    return [s.session.id, s.modified, s.editorStillOpen, busy[s.session.id] || "", cardNotes[s.session.id] ? cardNotes[s.session.id].text : "", !!confirmDiscard[s.session.id], upgradeSig(s.session.id), renameSig(s.session.id)].join("|");
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
    var up = upgrades[id] || (upgrades[id] = { on: false, plan: null, loading: false, newName: "" });
    var rn = renames[id] || (renames[id] = { on: false, plan: null, loading: false, newName: session.fileName });
    function loadRenamePlan(newName) {
      rn.loading = true; render();
      api("GET", "/api/rename-plan?id=" + encodeURIComponent(id) + "&newName=" + encodeURIComponent(newName)).then(function (plan) {
        rn.plan = plan; rn.loading = false; render();
      }).catch(function (e) {
        rn.loading = false; rn.plan = { applicable: false, reason: e.message, newName: newName }; render();
      });
    }
    function loadPlan(newName) {
      up.loading = true; render();
      api("GET", "/api/upgrade-plan?id=" + encodeURIComponent(id) + (newName ? "&newName=" + encodeURIComponent(newName) : "")).then(function (plan) {
        up.plan = plan; up.newName = plan.newName || newName || ""; up.loading = false; render();
      }).catch(function (e) {
        up.loading = false; up.plan = { applicable: false, reason: e.message, newName: newName || null }; render();
      });
    }
    var toggle = h("input", { type: "checkbox", checked: up.on ? "checked" : null, disabled: disabled ? "disabled" : null });
    toggle.addEventListener("change", function () { up.on = toggle.checked; if (up.on) { rn.on = false; loadPlan(up.newName); } else render(); });
    var upgradeBox = h("div", { class: "upgrade" },
      h("label", null, toggle, h("span", null, "升級版本（舊版放進 old 資料夾，新版的版本號 +1）")));
    if (up.on) {
      var plan = up.plan;
      if (up.loading || !plan) {
        upgradeBox.appendChild(h("p", { class: "hint" }, "正在確認遠端目錄…"));
      } else {
        var oldPlace = plan.archiveDirName + "/" + plan.archiveFileName;
        upgradeBox.appendChild(h("p", { class: "hint" }, "舊版「" + plan.currentName + "」會複製到「" + oldPlace + "」" +
          (plan.archiveFileName !== plan.currentName ? "（原檔名沒有版次，放進 old 時自動補上 _v0.1）" : "") +
          (plan.archiveDirExists ? "。" : "。這個目錄下還沒有 old 資料夾，會自動建立。")));
        if (plan.newName !== null) {
          var nameInput = h("input", { type: "text", value: up.newName, disabled: disabled ? "disabled" : null });
          nameInput.addEventListener("change", function () { up.newName = nameInput.value.trim(); loadPlan(up.newName); });
          upgradeBox.appendChild(h("label", { class: "upgrade__name" }, "新版檔名（可以自己修改）"));
          upgradeBox.appendChild(nameInput);
          upgradeBox.appendChild(h("p", { class: "hint" }, plan.implicitVersion ? "原檔名沒有版次，新版自動加上 _v0.2。" : "版本號已自動 +1（" + plan.currentVersion + " → " + plan.newVersion + "）。"));
        }
        if (plan.reason) upgradeBox.appendChild(h("div", { class: "msg" }, plan.reason));
        upgradeBox.appendChild(h("p", { class: "hint" }, "上傳時舊版與新版會在同一個 commit 一起完成，舊版的歷史紀錄都保留。"));
      }
    }
    // ---- 改檔名（跟升級版本只能選一個）----
    var rnToggle = h("input", { type: "checkbox", checked: rn.on ? "checked" : null, disabled: (disabled || up.on) ? "disabled" : null });
    rnToggle.addEventListener("change", function () {
      rn.on = rnToggle.checked; rn.plan = null;
      if (rn.on && rn.newName !== session.fileName) loadRenamePlan(rn.newName); else render();
    });
    var renameBox = h("div", { class: "upgrade" },
      h("label", null, rnToggle, h("span", null, "改檔名（上傳時一併改成新的檔名，歷史紀錄保留）")));
    if (up.on) {
      renameBox.appendChild(h("p", { class: "hint" }, "已勾選升級版本；升級版本的新版檔名可以直接在上面修改。"));
    } else if (rn.on) {
      var rnInput = h("input", { type: "text", value: rn.newName, disabled: disabled ? "disabled" : null });
      rnInput.addEventListener("change", function () { rn.newName = rnInput.value.trim(); rn.plan = null; if (rn.newName && rn.newName !== session.fileName) loadRenamePlan(rn.newName); else render(); });
      renameBox.appendChild(h("label", { class: "upgrade__name" }, "新檔名"));
      renameBox.appendChild(rnInput);
      if (rn.newName === session.fileName) renameBox.appendChild(h("p", { class: "hint" }, "請把上面的檔名改成新的檔名（副檔名要一樣）。"));
      else if (rn.loading || !rn.plan) renameBox.appendChild(h("p", { class: "hint" }, "正在確認遠端目錄…"));
      else if (rn.plan.reason) renameBox.appendChild(h("div", { class: "msg" }, rn.plan.reason));
      else renameBox.appendChild(h("p", { class: "hint" }, "上傳後「" + rn.plan.currentName + "」會變成「" + rn.plan.newName + "」。沒有修改內容、只想改名也可以直接上傳。"));
    }
    var renameBlocked = rn.on && !up.on && (rn.loading || !rn.plan || !rn.plan.applicable || rn.newName === session.fileName);
    var renaming = rn.on && !up.on && !renameBlocked;

    var upgradeBlocked = up.on && (up.loading || !up.plan || !up.plan.applicable);
    var commitLabel = busy[id] === "上傳中…" ? "上傳中…" : (up.on && up.plan && up.plan.newVersion ? "上傳並升級到 " + up.plan.newVersion : (renaming ? "上傳並改名" : "上傳"));
    var commit = h("button", { class: "primary", disabled: (disabled || upgradeBlocked || renameBlocked) ? "disabled" : null, onclick: function () {
      run("上傳中…", function () {
        var body = { id: id, message: messages[id] };
        if (up.on) body.upgrade = up.newName ? { newName: up.newName } : true;
        else if (renaming) body.rename = { newName: rn.newName };
        return api("POST", "/api/commit", body).then(function (r) {
          delete messages[id]; delete cardNotes[id]; delete upgrades[id]; delete renames[id];
          var sync = r.localSync;
          if (r.upgrade || r.rename || sync) {
            commitNotice = (r.rename
              ? "已改名並上傳（r" + r.committedRevision + "）：「" + r.rename.from + "」→「" + r.rename.to + "」。"
              : r.upgrade
              ? "已升級並上傳（r" + r.committedRevision + "）：新版「" + r.upgrade.newName + "」；舊版放進「" + r.upgrade.archivedTo + "」。"
              : "已上傳（r" + r.committedRevision + "）：" + r.path + "。") + (sync && sync.status === "updated" ? " " + sync.message : "");
            setTimeout(function () { commitNotice = ""; render(); }, 30000);
          }
          if (sync && sync.status !== "updated") showAlert(syncAlertTitle(sync, "已上傳到 SVN"), sync.message);
          return { note: null, done: r };
        });
      });
    } }, commitLabel);
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
      upgradeBox,
      renameBox,
      note ? h("div", { class: note.info ? "msg info" : "msg" }, note.text) : null,
      h("div", { class: "row" },
        commit,
        h("button", { disabled: disabled ? "disabled" : null, onclick: function () { run("開啟中…", function () { return api("POST", "/api/reopen", { id: id }).then(function () { return { note: "已用預設程式重新開啟檔案。" }; }); }); } }, "重新開啟檔案"),
        h("button", { disabled: disabled ? "disabled" : null, onclick: function () { run("下載中…", function () { return api("POST", "/api/export-latest", { id: id }).then(function (r) { return { note: "已把遠端最新版（r" + r.revision + "）另存到：" + r.path }; }); }); } }, "下載最新版另存"),
        discard));
    return { el: el, textarea: textarea };
  }`;
