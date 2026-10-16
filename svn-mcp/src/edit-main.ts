#!/usr/bin/env node
/**
 * svn-edit 的執行入口（也是打包成 svn-edit.exe 的進入點）。
 *
 * - 預設埠 9097（SVN_EDIT_PORT 可覆蓋），只綁 127.0.0.1；
 * - 沒有 `--no-open` 時會開一個獨立的桌面視窗顯示控制頁（使用者手動雙擊執行檔，見 edit-window.ts）；由 svn-mcp 自動拉起時會帶 `--no-open`；
 * - 已經有另一個實例在跑（埠被占用）就直接結束，手動啟動的話順便把那個實例的視窗叫到最前面（叫不到才再開一個）；
 * - 手動開視窗時，視窗一關（網頁會通知）就結束；有請求在處理或有進行中的編輯就等它們做完再結束。
 * - 啟動時與結束時，清掉暫存資料夾裡的檢視檔、批次上傳殘留、空殼資料夾；進行中的編輯（有 session.json）一律保留。
 * - 沒有任何進行中的編輯、且閒置超過 SVN_EDIT_IDLE_MINUTES 就自己結束。預設：手動開視窗的 3 分鐘（視窗一關很快就結束）、
 *   自動拉起的 30 分鐘；0 代表永不結束。
 */
import { createEditServer } from "./edit-server.js";
import { activateExistingWindow, openAppWindow } from "./edit-window.js";
import { fillMissingRepoCaches, migrateLegacyConnections } from "./connections-store.js";
import { cleanupTransientDirs, listEdits } from "./remote-edit-client.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SVN_EDIT_PORT) || 9097;
const IDLE_CHECK_MS = 60_000;
const noOpen = process.argv.includes("--no-open");
/** 手動開視窗的情況：控制頁每 3 秒會來問一次狀態，視窗關掉就沒有請求了；留 3 分鐘餘裕給「視窗縮到背景被瀏覽器降速」。 */
const DEFAULT_IDLE_MINUTES_WINDOWED = 3;
const DEFAULT_IDLE_MINUTES_BACKGROUND = 30;
const idleMinutes =
  process.env.SVN_EDIT_IDLE_MINUTES === undefined
    ? noOpen ? DEFAULT_IDLE_MINUTES_BACKGROUND : DEFAULT_IDLE_MINUTES_WINDOWED
    : Number(process.env.SVN_EDIT_IDLE_MINUTES);
const pageUrl = `http://${HOST}:${PORT}/`;

process.on("unhandledRejection", (reason) => console.error("[svn-edit] unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("[svn-edit] uncaughtException:", err));

const { server, lastActivity, inflight, onWindowClosing } = createEditServer();

/** 視窗關掉後等這麼久，確認不是重新整理（重新整理會馬上有新請求）才結束。 */
const CLOSE_GRACE_MS = 4000;
const CLOSE_RETRY_MS = 5000;

/** 手動開視窗時：視窗一關就結束；還有請求在處理或有進行中的編輯就先不結束，等它們做完。 */
function exitAfterWindowClosed(closedAt: number): void {
  if (lastActivity() > closedAt) return; // 有新請求進來：只是重新整理，或又開了新視窗
  const retry = (): void => void setTimeout(() => exitAfterWindowClosed(closedAt), CLOSE_RETRY_MS);
  if (inflight() > 0) return retry();
  listEdits()
    .then((sessions) => {
      if (sessions.length > 0) return retry();
      console.error("svn-edit 視窗已關閉，結束。");
      process.exit(0);
    })
    .catch(retry);
}

if (!noOpen) {
  onWindowClosing(() => {
    const closedAt = Date.now();
    setTimeout(() => exitAfterWindowClosed(closedAt), CLOSE_GRACE_MS);
  });
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`svn-edit 已經在執行中（${pageUrl}）。`);
    if (noOpen) process.exit(0);
    activateExistingWindow()
      .then((activated) => {
        if (!activated) openAppWindow(pageUrl);
      })
      .finally(() => setTimeout(() => process.exit(0), 500));
    return;
  }
  console.error("svn-edit 啟動失敗：", err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // 只有真的接手了這個埠（不是「已有另一個實例在跑」）才清理，免得清到另一個實例正在用的暫存
  cleanupTransientDirs();
  process.on("exit", () => cleanupTransientDirs());
  // 舊版「每個 repo 一筆」的連線檔轉成「每個帳號一筆」（有變動前會先備份；已經是新格式就什麼都不做）
  migrateLegacyConnections()
    .then((r) => {
      if (r.backup) console.error(`[svn-edit] 連線檔已轉成帳號格式：併入 ${r.migrated} 筆、維持原樣 ${r.kept} 筆，備份：${r.backup}`);
    })
    .catch((e) => console.error(`[svn-edit] 連線檔遷移失敗（維持原樣）：${e instanceof Error ? e.message : String(e)}`))
    // 帳號還沒有 repo 清單快取（快取檔不見、連線檔剛複製過來）：自動向伺服器補一次
    .then(() => fillMissingRepoCaches())
    .catch(() => undefined);
  console.error(`svn-edit 已啟動：${pageUrl}（關閉這個視窗就會結束；沒有進行中的編輯且閒置 ${idleMinutes} 分鐘會自動結束）`);
  if (!noOpen) openAppWindow(pageUrl);
});

if (Number.isFinite(idleMinutes) && idleMinutes > 0) {
  const timer = setInterval(() => {
    if (Date.now() - lastActivity() < idleMinutes * 60_000) return;
    listEdits()
      .then((sessions) => {
        if (sessions.length === 0) {
          console.error("svn-edit 閒置太久，自動結束。");
          process.exit(0);
        }
      })
      .catch(() => undefined);
  }, IDLE_CHECK_MS);
  timer.unref();
}
