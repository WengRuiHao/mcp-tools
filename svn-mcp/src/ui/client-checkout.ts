/** 控制頁前端（瀏覽器端 JS 片段）：Checkout 到本地的設定視窗。
 * 這些片段會依序接進同一個立即執行函式（見 client.ts），所以彼此共用變數與函式；函式宣告會被提升，搬到哪個檔案都安全。 */
export const CLIENT_CHECKOUT = String.raw`  function openCheckout(current) {
    closeCheckout();
    var leaf = browse.path ? browse.path.split("/").pop() : current.name;
    co = { conn: current, remotePath: browse.path || "", name: leaf, parent: "", scope: "all", setSync: true, phase: "form", error: null, result: null, status: { k: "none", m: "" } };
    var state0 = co;
    var sh = openSheet(false, function () { if (state0.phase !== "run" && co === state0) closeCheckout(); });
    co.sheet = sh.sheet; co.close = sh.close;
    renderCheckout();
  }
  function closeCheckout() { clearTimeout(coTimer); if (co) co.close(); co = null; }
  function coTarget() { return co && co.parent ? co.parent + "/" + co.name.trim() : ""; }
  /** 預先檢查放的位置（只是讓使用者早點知道；真正的保護在伺服器端）。 */
  function checkCoTarget() {
    var cur = co;
    if (!cur) return;
    if (!cur.parent || !cur.name.trim()) { cur.status = { k: "none", m: "" }; updateCoStatus(); return; }
    api("POST", "/api/local/inspect", { paths: [coTarget(), cur.parent] }).then(function (r) {
      if (co !== cur) return;
      var t = r.results[0], p = r.results[1];
      if (t.exists && t.isWc) cur.status = { k: "info", m: "這個位置已經是 SVN 工作目錄，不需要 Checkout。可以到「管理連線」直接指定它。", blocked: true };
      else if (t.exists && t.nonEmpty) cur.status = { k: "err", m: "這個資料夾已經有內容，為了不弄亂你原有的檔案，不能 Checkout 到這裡。請換一個新的資料夾名稱。", blocked: true };
      else if (!t.exists && p.inWc) cur.status = { k: "err", m: "選的位置已經在另一個 SVN 工作目錄裡面，不能在裡面再 Checkout 一層。請換一個位置。", blocked: true };
      else cur.status = { k: "ok", m: t.exists ? "✓ 可以 Checkout（這是空的資料夾）" : "✓ 可以 Checkout（會自動建立這個資料夾）" };
      updateCoStatus();
    }).catch(function () { /* 預先檢查失敗不擋，交給伺服器判斷 */ });
  }
  function updateCoStatus() {
    if (!co || !co.statusEl) return;
    co.statusEl.className = "st " + (co.status.k === "none" ? "" : co.status.k);
    co.statusEl.textContent = co.status.m;
    co.statusEl.style.display = co.status.m ? "" : "none";
    co.previewEl.textContent = co.parent ? "會建立：" + coTarget() : "";
    var ready = !!co.parent && !!co.name.trim() && !co.status.blocked;
    co.startBtn.disabled = !ready;
  }
  function renderCheckout() {
    if (!co) return;
    var cur = co;
    var sheet = cur.sheet;
    sheet.textContent = "";
    sheet.appendChild(h("h3", { class: "sheet2__title" }, "Checkout 到本地"));

    if (cur.phase === "run") {
      sheet.appendChild(h("p", { class: "hint" }, "正在 Checkout，請不要關閉視窗…（整個目錄很大時需要一陣子）"));
      sheet.appendChild(h("div", { class: "bar" }, h("i", null)));
      return;
    }
    if (cur.phase === "done") {
      var r = cur.result;
      sheet.appendChild(h("div", { class: "st ok" }, "✓ 完成：" + (r.revision ? "r" + r.revision + "，" : "") + r.itemCount + " 個項目，放在 " + r.target));
      if (r.synced) {
        sheet.appendChild(h("div", { class: "st info" }, "已設為「" + cur.conn.name + "」的同步目錄。" + (prefsNow().syncLocal ? "之後上傳、刪除會自動更新這裡。" : "目前「同步本地端」是關閉的，到「管理連線」打開後，上傳、刪除才會自動更新這裡。")));
      }
      sheet.appendChild(h("div", { class: "row", style: "margin-top:12px" }, h("button", { type: "button", class: "primary", onclick: closeCheckout }, "完成")));
      return;
    }

    sheet.appendChild(h("div", { class: "lbl" }, "遠端目錄"));
    sheet.appendChild(h("div", { class: "loc__url", style: "border:1px solid var(--line-strong);background:var(--field);border-radius:10px;padding:7px 10px" },
      String(cur.conn.url).replace(/[/]+$/, "") + (cur.remotePath ? "/" + cur.remotePath : "")));

    sheet.appendChild(h("div", { class: "lbl" }, "放到本地哪個資料夾底下"));
    sheet.appendChild(h("div", { class: "pathrow" },
      h("div", { class: "v" + (cur.parent ? "" : " empty") }, cur.parent || "（尚未選擇）"),
      h("button", { type: "button", class: "primary", onclick: function () {
        chooseLocalFolder("Checkout 要放在哪個資料夾底下？", function (picked) { cur.parent = picked; renderCheckout(); checkCoTarget(); });
      } }, "選擇資料夾…")));

    sheet.appendChild(h("div", { class: "lbl" }, "新資料夾名稱（預設跟遠端目錄同名，可以改）"));
    var nameIn = h("input", { type: "text", autocomplete: "off" });
    nameIn.value = cur.name;
    nameIn.addEventListener("input", function () { cur.name = nameIn.value; cur.status = { k: "none", m: "" }; updateCoStatus(); clearTimeout(coTimer); coTimer = setTimeout(checkCoTarget, 250); });
    cur.previewEl = h("div", { class: "hint", style: "margin:6px 0 0" });
    cur.statusEl = h("div", { class: "st" });
    sheet.appendChild(nameIn); sheet.appendChild(cur.previewEl); sheet.appendChild(cur.statusEl);

    sheet.appendChild(h("div", { class: "lbl" }, "Checkout 範圍"));
    CO_SCOPES.forEach(function (o) {
      var radio = h("input", { type: "radio", name: "coScope", checked: cur.scope === o.k ? "checked" : null });
      radio.addEventListener("change", function () { cur.scope = o.k; renderCheckout(); checkCoTarget(); });
      sheet.appendChild(h("label", { class: "opt" + (cur.scope === o.k ? " on" : "") }, radio, h("div", null, h("b", null, o.t), h("small", null, o.d))));
    });

    var chk = h("input", { type: "checkbox", checked: cur.setSync ? "checked" : null });
    chk.addEventListener("change", function () { cur.setSync = chk.checked; });
    sheet.appendChild(h("label", { class: "chk" }, chk, h("span", null, "完成後設為「" + cur.conn.name + "」的同步目錄（上傳、刪除後自動更新這裡）")));
    if (cur.error) sheet.appendChild(h("div", { class: "st err" }, cur.error));

    cur.startBtn = h("button", { type: "button", class: "primary", onclick: function () {
      cur.phase = "run"; cur.error = null; renderCheckout();
      api("POST", "/api/checkout", { connection: cur.conn.id, remotePath: cur.remotePath, parent: cur.parent, name: cur.name.trim(), scope: cur.scope, setSync: cur.setSync }).then(function (res) {
        if (co !== cur) return;
        forgetLocalInfo(res.target);
        cur.phase = "done"; cur.result = res; renderCheckout();
        refresh();
      }).catch(function (e) {
        if (co !== cur) return;
        cur.phase = "form"; cur.error = e.message + (HINTS[e.code] ? String.fromCharCode(10) + HINTS[e.code] : "");
        renderCheckout(); checkCoTarget();
      });
    } }, "開始 Checkout");
    sheet.appendChild(h("div", { class: "sheet2__foot", style: "margin-top:14px" }, h("div", { class: "cur" }), h("button", { type: "button", onclick: closeCheckout }, "取消"), cur.startBtn));
    updateCoStatus();
  }`;
