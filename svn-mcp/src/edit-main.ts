#!/usr/bin/env node
/**
 * svn-edit 的執行入口（也是打包成 svn-edit.exe 的進入點）。
 *
 * - 預設埠 8096（SVN_EDIT_PORT 可覆蓋），只綁 127.0.0.1；
 * - 沒有 `--no-open` 時會用瀏覽器打開控制頁（使用者手動雙擊執行檔）；由 svn-mcp 自動拉起時會帶 `--no-open`；
 * - 已經有另一個實例在跑（埠被占用）就直接結束，手動啟動的話順便幫使用者打開那個實例的控制頁；
 * - 沒有任何進行中的編輯、且閒置超過 SVN_EDIT_IDLE_MINUTES（預設 30，0 代表永不結束）就自己結束。
 */
import { createEditServer } from "./edit-server.js";
import { openUrl } from "./os-open.js";
import { listEdits } from "./remote-edit-client.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SVN_EDIT_PORT) || 8096;
const IDLE_CHECK_MS = 60_000;
const noOpen = process.argv.includes("--no-open");
const idleMinutes = process.env.SVN_EDIT_IDLE_MINUTES === undefined ? 30 : Number(process.env.SVN_EDIT_IDLE_MINUTES);
const pageUrl = `http://${HOST}:${PORT}/`;

process.on("unhandledRejection", (reason) => console.error("[svn-edit] unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("[svn-edit] uncaughtException:", err));

const { server, lastActivity } = createEditServer();

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`svn-edit 已經在執行中（${pageUrl}）。`);
    if (!noOpen) openUrl(pageUrl);
    process.exit(0);
  }
  console.error("svn-edit 啟動失敗：", err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.error(`svn-edit 已啟動：${pageUrl}（關閉這個視窗就會結束；沒有進行中的編輯且閒置 ${idleMinutes} 分鐘會自動結束）`);
  if (!noOpen) openUrl(pageUrl);
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
