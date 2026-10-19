/** 控制頁前端（瀏覽器端 JS 片段）：啟動：事件註冊、第一次畫面與定時更新（必須放在最後）。
 * 這些片段會依序接進同一個立即執行函式（見 client.ts），所以彼此共用變數與函式；函式宣告會被提升，搬到哪個檔案都安全。 */
export const CLIENT_BOOT = String.raw`  // 沒拖到框框裡時，不要讓瀏覽器把檔案直接打開
  window.addEventListener("dragover", function (ev) { ev.preventDefault(); });
  window.addEventListener("drop", function (ev) { ev.preventDefault(); });

  // Esc 先關掉最上面的視窗（本機資料夾點選 → Checkout），不要連右邊面板一起收掉
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    if (lp) closeLocalPicker();
    else if (co && co.phase !== "run") closeCheckout();
    else return;
    ev.preventDefault(); ev.stopPropagation();
  }, true);

  document.getElementById("extClose").addEventListener("click", closeExt);
  document.getElementById("scrim").addEventListener("click", closeExt);
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && ext.view !== null) closeExt(); });
  window.addEventListener("resize", applyExtMode);
  render();
  refresh();
  setInterval(refresh, 3000);
  // 視窗關閉（或重新整理）時通知伺服器；keepalive 讓請求在頁面卸載後仍會送出。伺服器會自己判斷是不是只是重新整理。
  window.addEventListener("pagehide", function () {
    try { fetch("/api/window-closing", { method: "POST", keepalive: true, headers: { "X-Edit-Token": TOKEN, "Content-Type": "application/json" }, body: "{}" }); } catch (e) { /* 關閉中，失敗就靠閒置逾時 */ }
  });`;
