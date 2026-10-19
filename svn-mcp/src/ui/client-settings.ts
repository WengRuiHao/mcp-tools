/** 控制頁前端（瀏覽器端 JS 片段）：管理連線面板：SVN 帳號（新增、編輯、刪除、重新載入）與主畫面的連線摘要。
 * 這些片段會依序接進同一個立即執行函式（見 client.ts），所以彼此共用變數與函式；函式宣告會被提升，搬到哪個檔案都安全。 */
export const CLIENT_SETTINGS = String.raw`  /** 帳號的顯示文字：名稱是使用者自己填的就只顯示名稱；留空（系統自動用主機名稱）才補上帳號，不然分不出是誰。 */
  function accountLabel(sv) {
    var host = String(sv.url || "").replace(/^[a-z]+:[/][/]/i, "").split("/")[0];
    var named = sv.name && sv.name !== host && sv.name !== sv.url;
    return (named ? sv.name : sv.name + "（" + sv.username + "）") + "・" + sv.repoCount + " 個 repo";
  }
  function renderSettings() {
    var box = document.getElementById("settings");
    var sig = JSON.stringify([state.servers, ext.view === "conn"]);
    if (sig === settingsSig) return;
    settingsSig = sig;
    box.textContent = "";
    var list = state.servers.map(function (sv) {
      return h("div", { class: "conn" }, h("span", null, accountLabel(sv), h("br", null), h("span", { class: "path" }, sv.url)));
    });
    box.appendChild(h("div", { class: "card" },
      h("h2", null, "連線設定" + (state.servers.length ? "（" + state.servers.length + " 個帳號）" : "（尚未設定）")),
      list.length ? h("div", null, list) : h("p", { class: "hint" }, "還沒有任何帳號，請按「管理連線」填寫伺服器網址與帳密。"),
      h("div", { class: "row" }, openerButton("conn", "管理連線", "wide"))));
  }

  // 帳號：只填上層網址＋帳密，就能用這個帳號看得到的所有 repo。新增、更新、測試都會實際連線一次。
  function serverSection() {
    var inputs = {};
    function sfield(key, label, type, placeholder) {
      inputs[key] = h("input", { type: type, placeholder: placeholder || "", autocomplete: "off", oninput: function () { serverForm[key] = inputs[key].value; } });
      inputs[key].value = serverForm[key];
      return h("div", null, h("label", null, label), inputs[key]);
    }
    function authNote(r) { return r.auth === "windows" ? "驗證方式：Windows 登入（這個伺服器用你目前登入電腦的帳號驗證，填的密碼沒有被用到）。" : "驗證方式：你填的帳號密碼。"; }
    function resetForm() { serverForm = { id: "", name: "", url: "", username: "", password: "" }; }
    function note(text, info) { serverBusy = false; settingsNote = { text: text, info: info }; rerenderExt(); }
    function fail(e) { note("連線失敗：" + e.message, false); }
    function busy(text) { serverBusy = true; settingsNote = { text: text, info: true }; rerenderExt(); }
    var disabled = serverBusy ? "disabled" : null;
    var testBtn = h("button", { type: "button", disabled: disabled, onclick: function () {
      busy("正在測試連線…");
      api("POST", "/api/servers/test", serverForm).then(function (r) {
        note("連線成功：找得到 " + r.test.repoCount + " 個 repo。" + authNote(r.test) + "（只是測試，還沒有儲存）", true);
      }).catch(fail);
    } }, "測試連線");
    var save = h("button", { type: "button", class: "primary", disabled: disabled, onclick: function () {
      var editing = !!serverForm.id;
      busy("正在測試連線並儲存…");
      api("POST", "/api/servers", serverForm).then(function (r) {
        resetForm();
        settingsNote = { text: "連線成功，已" + (editing ? "更新" : "新增") + "「" + r.server.name + "」：找得到 " + r.server.repoCount + " 個 repo。" + authNote(r.server), info: true };
        serverBusy = false; return refresh();
      }).catch(fail);
    } }, serverForm.id ? "測試並更新" : "測試並儲存");
    var list = state.servers.map(function (sv) {
      var aliasNames = Object.keys(sv.aliases || {});
      var buttons;
      if (deleteConfirmId === sv.id) {
        buttons = [
          h("button", { type: "button", class: "danger", disabled: disabled, onclick: function () {
            busy("正在刪除…");
            api("POST", "/api/servers/delete", { id: sv.id }).then(function () {
              deleteConfirmId = null; if (serverForm.id === sv.id) resetForm();
              settingsNote = { text: "已刪除「" + sv.name + "」（SVN 上的資料完全沒有動）。", info: true }; serverBusy = false; return refresh();
            }).catch(fail);
          } }, "確定刪除"),
          h("button", { type: "button", onclick: function () { deleteConfirmId = null; rerenderExt(); } }, "取消")];
      } else {
        buttons = [
          h("button", { type: "button", disabled: disabled, onclick: function () {
            busy("正在重新載入 repo 清單…");
            api("POST", "/api/servers/refresh", { id: sv.id }).then(function (r) {
              settingsNote = { text: "已重新載入，共 " + r.server.repoCount + " 個 repo。" + authNote(r.server), info: true }; serverBusy = false; return refresh();
            }).catch(fail);
          } }, "重新載入"),
          h("button", { type: "button", onclick: function () { serverForm = { id: sv.id, name: sv.name, url: sv.url, username: sv.username, password: "" }; settingsNote = null; deleteConfirmId = null; rerenderExt(); } }, "編輯"),
          h("button", { type: "button", class: "danger", onclick: function () { deleteConfirmId = sv.id; settingsNote = null; rerenderExt(); } }, "刪除")];
      }
      return h("div", { class: "conn" },
        h("span", null, accountLabel(sv), h("br", null), h("span", { class: "path" }, sv.url),
          aliasNames.length ? h("span", { class: "path" }, h("br", null), "別名：" + aliasNames.join("、")) : null),
        h("span", { class: "btns" }, buttons));
    });
    return h("div", null,
      h("h2", { style: "margin-top:14px;font-size:15px" }, "SVN 伺服器（填帳密就能用所有 repo）"),
      list.length ? h("div", null, list) : h("div", { class: "empty" }, "還沒有任何帳號，請在下方新增。"),
      h("form", { autocomplete: "off", onsubmit: function (ev) { ev.preventDefault(); } },
        h("h2", { style: "margin-top:18px;font-size:15px" }, serverForm.id ? "編輯帳號" : "新增帳號"),
        sfield("name", "名稱（留空＝用網址）", "text", "例如：公司 SVN"),
        sfield("url", "伺服器網址", "text", "https://svn.example.com/svn"),
        sfield("username", "帳號（請使用你自己的 SVN 帳號；留空＝目前的 Windows 帳號）", "text"),
        sfield("password", serverForm.id ? "密碼（留空代表不變更）" : "密碼（Windows 登入驗證可留空）", "password"),
        settingsNote ? h("div", { class: settingsNote.info ? "msg info" : "msg" }, settingsNote.text) : null,
        h("div", { class: "row" }, testBtn, save, serverForm.id ? h("button", { type: "button", onclick: function () { resetForm(); settingsNote = null; rerenderExt(); } }, "取消編輯") : null)));
  }

  function renderConnView(box) {
    box.appendChild(h("div", null,
      h("h2", null, "連線設定" + (state.servers.length ? "（" + state.servers.length + " 個帳號）" : "（尚未設定）")),
      h("p", { class: "hint" }, "這裡的設定跟 svn-mcp 的唯讀工具共用同一份檔案，只存在這台電腦；只記帳號，底下的 repo 由伺服器自動帶出。密碼不會再顯示出來；編輯時密碼留空代表不變更。"),
      serverSection(),
      syncSection()));
  }`;
