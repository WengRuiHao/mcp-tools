// 刪暫存資料夾：被別的程式短暫鎖住（TortoiseSVN 快取、防毒會鎖 wc.db）時要自動重試，不能整個失敗。
// 在 Windows 上，「有程式把工作目錄放在資料夾裡」會讓資料夾刪不掉（跟 wc.db 被鎖住同樣是 EBUSY／EPERM）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_RETRY_MS, removeDirWithRetry } from "../dist/temp-clean.js";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "svn-tempclean-test-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function makeDir(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "wc", ".svn"), { recursive: true });
  fs.writeFileSync(path.join(dir, "wc", ".svn", "wc.db"), "db");
  fs.writeFileSync(path.join(dir, "session.json"), "{}");
  return dir;
}

/** 啟動一個把工作目錄放在 dir 裡、活 ms 毫秒的程序（Windows 上這會鎖住 dir）。 */
function holdDir(dir, ms) {
  const child = spawn(process.execPath, ["-e", `setTimeout(()=>{}, ${ms})`], { cwd: dir, stdio: "ignore", windowsHide: true });
  return new Promise((resolve) => setTimeout(() => resolve(child), 300));
}

test("沒被鎖住：直接刪掉整個資料夾，回傳 true；資料夾不存在也不出錯", async () => {
  const dir = makeDir("plain");
  assert.equal(await removeDirWithRetry(dir), true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(await removeDirWithRetry(path.join(root, "never-existed")), true);
});

test("短暫被鎖住：自動重試，鎖一放開就刪乾淨（不留目錄）", { skip: process.platform !== "win32" }, async () => {
  const dir = makeDir("short-lock");
  const child = await holdDir(dir, 1200);
  try {
    assert.equal(await removeDirWithRetry(dir), true);
    assert.equal(fs.existsSync(dir), false, "整個資料夾都要不見");
  } finally {
    child.kill();
  }
});

test("鎖太久：不丟錯誤、回傳 false，之後在背景自動補刪", { skip: process.platform !== "win32", timeout: 40000 }, async () => {
  const dir = makeDir("long-lock");
  const child = await holdDir(dir, 4500);
  const started = Date.now();
  assert.equal(await removeDirWithRetry(dir), false);
  assert.ok(Date.now() - started < 8000, "重試只能等幾秒，不能讓畫面卡住");
  child.kill();
  const deadline = Date.now() + BACKGROUND_RETRY_MS + 6000;
  while (fs.existsSync(dir) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.existsSync(dir), false, "背景重試要把它清掉");
});
