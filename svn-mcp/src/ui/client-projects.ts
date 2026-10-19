/** 控制頁前端（瀏覽器端 JS 片段）：專案選擇：星星專案、近期、搜尋、簡稱、專案下拉選單。
 * 這些片段會依序接進同一個立即執行函式（見 client.ts），所以彼此共用變數與函式；函式宣告會被提升，搬到哪個檔案都安全。 */
export const CLIENT_PROJECTS = String.raw`  // ---- 專案選擇：近期／星星分頁、搜尋、星星、簡稱（專案很多時用來快速找）----
  function prefsNow() { return state.repoPrefs || { starred: [], recent: {}, nicknames: {}, folders: {}, folderNicknames: {}, localPaths: {}, syncLocal: false }; }
  /** 更新本機這份偏好：只換有變的欄位，其餘沿用目前的。 */
  function setPrefs(changes) { state.repoPrefs = Object.assign({}, prefsNow(), changes); }
  function isStarred(name) { return prefsNow().starred.indexOf(name) >= 0; }
  function nicknameOf(c) { return prefsNow().nicknames[c.name] || ""; }
  /** 簡稱欄顯示什麼：自己取的簡稱優先，沒有就顯示舊版別名當提示。 */
  function pillOf(c) { var nick = nicknameOf(c); return nick ? { text: nick, kind: "nick" } : (c.aliases && c.aliases.length ? { text: c.aliases[0], kind: "alias" } : { text: "簡稱", kind: "empty" }); }
  function byName(a, b) { return a.name.localeCompare(b.name, "zh-Hant"); }
  function recentList() {
    var recent = prefsNow().recent;
    return state.connections.slice().sort(function (a, b) {
      var ta = recent[a.name] || "", tb = recent[b.name] || "";
      if (ta !== tb) return ta < tb ? 1 : -1;
      return byName(a, b);
    });
  }
  function starList() {
    var out = [];
    prefsNow().starred.forEach(function (name) { var c = state.connections.filter(function (x) { return x.name === name; })[0]; if (c) out.push(c); });
    return out;
  }
  /** 搜尋：空白分隔的每個詞都要出現在「名稱、別名、簡稱」其中之一（不分大小寫）。 */
  function matchesQuery(c, query) {
    var hay = (c.name + " " + (c.aliases || []).join(" ") + " " + nicknameOf(c)).toLowerCase();
    return query.toLowerCase().split(" ").filter(function (t) { return t; }).every(function (t) { return hay.indexOf(t) >= 0; });
  }
  function recordOpened(name) {
    api("POST", "/api/repo-prefs/open", { name: name }).then(function (r) { state.repoPrefs = r.prefs; }).catch(function () {});
  }
  function backToPicker() { browse.picking = true; browse.entries = null; browse.error = null; browse.notice = null; renderExt(); }
  function openProject(c) {
    browse.connection = c.id; browse.picking = false; browse.path = "";
    recordOpened(c.name);
    loadBrowse("");
  }
  function savePrefs(call) {
    return call.then(function (r) { state.repoPrefs = r.prefs; renderPickerList(); importRerender(); }).catch(function (e) {
      picker.note = { text: e.message || "儲存失敗", error: true }; refresh().then(function () { rerenderExt(); });
    });
  }
  function toggleStar(c) {
    var on = !isStarred(c.name);
    var p = prefsNow();
    setPrefs({ starred: on ? p.starred.concat([c.name]) : p.starred.filter(function (n) { return n !== c.name; }) });
    renderPickerList();
    savePrefs(api("POST", "/api/repo-prefs/star", { name: c.name, starred: on }));
  }
  function starButton(c) {
    var on = isStarred(c.name);
    var btn = h("button", { type: "button", class: "star" + (on ? " on" : ""), title: on ? "取消星星" : "加入星星（放到「星星 SVN」）", onclick: function (ev) {
      ev.stopPropagation(); toggleStar(c); var now = isStarred(c.name); btn.textContent = now ? "★" : "☆"; btn.className = "star" + (now ? " on" : "");
    } }, on ? "★" : "☆");
    return btn;
  }
  function moveStar(dragged, target, after) {
    var order = starList().map(function (c) { return c.name; }).filter(function (n) { return n !== dragged; });
    var at = order.indexOf(target) + (after ? 1 : 0);
    order.splice(at < 0 ? order.length : at, 0, dragged);
    setPrefs({ starred: order });
    renderPickerList();
    savePrefs(api("POST", "/api/repo-prefs/reorder", { order: order }));
  }
  function projectRow(c, canDrag) {
    var pill = pillOf(c);
    var right;
    if (picker.editing === c.name) {
      var input = h("input", { class: "nickinput", type: "text", maxlength: "30", placeholder: "簡稱", value: nicknameOf(c), onclick: function (ev) { ev.stopPropagation(); } });
      var finished = false;
      var finish = function (save) {
        if (finished) return; finished = true; picker.editing = "";
        if (save && input.value.trim() !== nicknameOf(c)) savePrefs(api("POST", "/api/repo-prefs/nickname", { name: c.name, nickname: input.value }));
        else renderPickerList();
      };
      input.addEventListener("keydown", function (ev) { ev.stopPropagation(); if (ev.key === "Enter") finish(true); else if (ev.key === "Escape") finish(false); });
      input.addEventListener("blur", function () { finish(true); });
      right = input;
      setTimeout(function () { input.focus(); input.select(); }, 0);
    } else {
      right = h("button", { type: "button", class: "nick " + pill.kind, title: pill.kind === "alias" ? "舊版取的名稱；點一下設定你自己的簡稱" : "點一下設定簡稱（只存在你的電腦，搜尋時也會比對）", onclick: function (ev) { ev.stopPropagation(); picker.editing = c.name; renderPickerList(); } }, pill.text);
    }
    var row = h("div", { class: "proj" + (canDrag ? " draggable" : ""), role: "button", tabindex: "0", "data-name": c.name, draggable: canDrag ? "true" : null, onclick: function () { openProject(c); } },
      canDrag ? h("span", { class: "grip", title: "拖曳調整順序" }, "⋮⋮") : null,
      starButton(c),
      h("span", { class: "proj__name" }, c.name),
      right);
    row.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && ev.target === row) openProject(c); });
    if (canDrag) {
      var clearMarks = function () { row.classList.remove("drop-before", "drop-after"); };
      var isAfter = function (ev) { var r = row.getBoundingClientRect(); return ev.clientY > r.top + r.height / 2; };
      row.addEventListener("dragstart", function (ev) { dragName = c.name; row.classList.add("dragging"); try { ev.dataTransfer.setData("text/plain", c.name); ev.dataTransfer.effectAllowed = "move"; } catch (e) {} });
      row.addEventListener("dragend", function () { dragName = null; row.classList.remove("dragging"); });
      row.addEventListener("dragover", function (ev) {
        if (!dragName || dragName === c.name) return;
        ev.preventDefault(); clearMarks(); row.classList.add(isAfter(ev) ? "drop-after" : "drop-before");
      });
      row.addEventListener("dragleave", clearMarks);
      row.addEventListener("drop", function (ev) {
        ev.preventDefault(); clearMarks();
        if (!dragName || dragName === c.name) return;
        var moved = dragName; dragName = null; moveStar(moved, c.name, isAfter(ev));
      });
    }
    return row;
  }
  /** 只重畫清單與底下的說明（打字搜尋時不能重畫搜尋框，不然會失去焦點）。 */
  function renderPickerList() {
    var box = document.getElementById("pickerList");
    if (!box) return;
    var foot = document.getElementById("pickerFoot");
    var query = picker.query.trim();
    var isStar = picker.tab === "star";
    var all = isStar ? starList() : recentList();
    var shown = query ? all.filter(function (c) { return matchesQuery(c, query); }) : all;
    var canDrag = isStar && !query;
    box.textContent = "";
    if (shown.length === 0) {
      box.appendChild(h("div", { class: "empty" }, query ? "找不到符合「" + query + "」的專案。" : (isStar ? "還沒有星星專案。到「近期 SVN」點 ☆，常用的專案就會放在這裡。" : "還沒有任何專案。")));
    }
    shown.forEach(function (c) { box.appendChild(projectRow(c, canDrag)); });
    if (foot) {
      foot.textContent = isStar
        ? "共 " + all.length + " 個星星專案" + (query ? "・符合 " + shown.length + " 個" : "・拖曳 ⋮⋮ 調整順序")
        : "共 " + state.connections.length + " 個專案" + (query ? "・符合 " + shown.length + " 個" : "・點 ☆ 加入常用，點簡稱可以取自己的暱稱");
    }
  }
  function renderProjectPicker(box) {
    var search = h("input", { type: "text", placeholder: "搜尋專案（共 " + state.connections.length + " 個）", autocomplete: "off", value: picker.query, oninput: function () { picker.query = search.value; renderPickerList(); } });
    var reload = h("button", { type: "button", class: "reload", title: "重新載入專案清單（伺服器上新增專案時用）", disabled: picker.busy ? "disabled" : null, onclick: function () {
      picker.busy = true; picker.note = { text: "正在重新載入專案清單…", error: false }; rerenderExt();
      api("POST", "/api/servers/refresh-all", {}).then(function (r) {
        picker.busy = false;
        picker.note = r.failed.length ? { text: "有 " + r.failed.length + " 個帳號沒讀成功：" + r.failed.map(function (f) { return f.name + "（" + f.error + "）"; }).join("；"), error: true } : { text: "已重新載入，共 " + r.repoCount + " 個專案。", error: false };
        return refresh();
      }).then(function () { rerenderExt(); }).catch(function (e) { picker.busy = false; picker.note = { text: e.message, error: true }; rerenderExt(); });
    } }, "↻");
    function tab(key, label) {
      return h("button", { type: "button", class: picker.tab === key ? "on" : "", onclick: function () { if (picker.tab === key) return; picker.tab = key; rerenderExt(); } }, label);
    }
    box.appendChild(h("div", null,
      h("h2", null, "選擇專案，瀏覽目錄"),
      h("p", { class: "hint" }, "近期 SVN：最近點開的在最上面　｜　星星 SVN：★ 在最上面，可拖曳排序"),
      h("div", { class: "tabs" }, tab("recent", "近期 SVN"), tab("star", "星星 SVN")),
      h("div", { class: "searchrow" }, search, reload),
      picker.note ? h("div", { class: picker.note.error ? "msg" : "hint" }, picker.note.text) : null,
      h("div", { class: "projlist", id: "pickerList" }),
      h("p", { class: "hint", id: "pickerFoot" })));
    renderPickerList();
  }

  /** 可搜尋的專案選單（專案很多時取代下拉選單）：星星專案在最上面，其次是最近開過的；右側顯示簡稱。 */
  function projectCombo(currentId, disabled, onSelect) {
    var current = findConnection(currentId) || state.connections[0];
    var wrap = h("div", { class: "combo" });
    var isOpen = false;
    var panel = null;
    var closeOnOutside = function (ev) { if (!wrap.contains(ev.target)) close(); };
    var closeOnEscape = function (ev) { if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
    function ordered(query) {
      var stars = starList();
      var rest = recentList().filter(function (c) { return !isStarred(c.name); });
      return stars.concat(rest).filter(function (c) { return !query || matchesQuery(c, query); });
    }
    function fieldButton() {
      var pill = pillOf(current);
      return h("button", { type: "button", class: "combo__field", disabled: disabled ? "disabled" : null, onclick: function () { if (isOpen) close(); else open(); } },
        h("span", { class: "combo__name" }, (isStarred(current.name) ? "★ " : "") + current.name),
        pill.kind === "empty" ? null : h("span", { class: "combo__pill" }, pill.text),
        h("span", { class: "combo__caret" }, "▾"));
    }
    function fillList(list, query) {
      list.textContent = "";
      var items = ordered(query);
      if (items.length === 0) list.appendChild(h("div", { class: "empty" }, "找不到符合「" + query + "」的專案。"));
      items.forEach(function (c) {
        var pill = pillOf(c);
        list.appendChild(h("button", { type: "button", class: "combo__item" + (c.id === current.id ? " on" : ""), onclick: function () { close(); onSelect(c); } },
          h("span", { class: "combo__star" }, isStarred(c.name) ? "★" : ""),
          h("span", { class: "combo__name" }, c.name),
          pill.kind === "empty" ? null : h("span", { class: "combo__pill" }, pill.text)));
      });
    }
    function open() {
      isOpen = true;
      var search = h("input", { type: "text", placeholder: "搜尋專案（共 " + state.connections.length + " 個）", autocomplete: "off" });
      var list = h("div", { class: "combo__list" });
      search.addEventListener("input", function () { fillList(list, search.value.trim()); });
      panel = h("div", { class: "combo__panel" }, search, list);
      wrap.appendChild(panel);
      fillList(list, "");
      document.addEventListener("click", closeOnOutside, true);
      document.addEventListener("keydown", closeOnEscape, true);
      setTimeout(function () { search.focus(); }, 0);
    }
    function close() {
      isOpen = false;
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      panel = null;
      document.removeEventListener("click", closeOnOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    }
    wrap.appendChild(fieldButton());
    return wrap;
  }`;
