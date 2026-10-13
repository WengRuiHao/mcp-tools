#!/usr/bin/env node
/**
 * svn-edit 的執行入口（也是打包成 svn-edit.exe 的進入點）。
 *
 * - 預設埠 8096（SVN_EDIT_PORT 可覆蓋），只綁 127.0.0.1；
 * - 沒有 `--no-open` 時會開一個獨立的桌面視窗顯示控制頁（使用者手動雙擊執行檔，見 edit-window.ts）；由 svn-mcp 自動拉起時會帶 `--no-open`；
 * - 已經有另一個實例在跑（埠被占用）就直接結束，手動啟動的話順便把那個實例的視窗叫到最前面（叫不到才再開一個）；
 * - 沒有任何進行中的編輯、且閒置超過 SVN_EDIT_IDLE_MINUTES 就自己結束。預設：手動開視窗的 3 分鐘（視窗一關很快就結束）、
 *   自動拉起的 30 分鐘；0 代表永不結束。
 */
import { createEditServer } from "./edit-server.js";
import { activateExistingWindow, openAppWindow } from "./edit-window.js";
import { listEdits } from "./remote-edit-client.js";

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

const { server, lastActivity } = createEditServer();

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
