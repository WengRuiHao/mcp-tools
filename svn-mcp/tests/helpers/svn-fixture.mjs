// 測試共用：建立臨時 SVN 測試環境（svnadmin + file://），不連任何真實 SVN。
// 放在 helpers/ 底下，`node --test` 不會把它當成測試檔。
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 建立臨時 SVN 儲存庫與連線設定，並設定測試用環境變數
 * （SVN_CONNECTIONS_FILE、SVN_EDIT_TEMP_DIR、SVN_EDIT_AUDIT_LOG，稽核紀錄不會寫進真正的 logs/）。
 *
 * options：
 *  - prefix：暫存資料夾名稱前綴
 *  - connections：舊版單一儲存庫連線陣列，或 (repoUrl) => 陣列；預設一筆 id=t1 的連線
 *  - v2：true 時改寫 v2 伺服器帳號格式（帳號 s1 指向 root/repos，儲存庫在 root/repos/myrepo）
 *  - connFile：連線設定檔相對 root 的路徑（預設 connections.json；v2 預設 info/svn-connections.json）
 *  - noLaunch：true 時設定 SVN_EDIT_NO_LAUNCH（不要真的打開 Word 或檔案總管）
 *  - autoCleanup：預設 true，在 test.after 刪掉 root；false 時請自行呼叫 cleanup()
 *
 * 回傳 { root, repoDir, repoUrl, connFile, svn, seed, checkoutLocal, cleanup }。
 */
export function createSvnFixture({ prefix = "svn-test-", connections, v2 = false, connFile: connRel, noLaunch = false, autoCleanup = true } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const parentDir = v2 ? path.join(root, "repos") : root;
  const repoDir = path.join(parentDir, v2 ? "myrepo" : "repo");
  const connFile = path.join(root, connRel ?? (v2 ? path.join("info", "svn-connections.json") : "connections.json"));
  const svn = (...args) => execFileSync("svn", [...args, "--non-interactive"], { encoding: "utf-8" });

  fs.mkdirSync(parentDir, { recursive: true });
  execFileSync("svnadmin", ["create", repoDir]);
  const repoUrl = pathToFileURL(repoDir).href;
  const profile = v2
    ? {
        version: 2,
        accounts: [{ id: "s1", name: "srv", url: pathToFileURL(parentDir).href, username: "u", password: "p", kind: "server" }],
        repoCache: { s1: { repos: ["myrepo"], fetchedAt: new Date().toISOString(), auth: "credentials" } },
        prefs: {},
      }
    : typeof connections === "function"
      ? connections(repoUrl)
      : (connections ?? [{ id: "t1", name: "test", url: repoUrl, username: "u", password: "p" }]);
  fs.mkdirSync(path.dirname(connFile), { recursive: true });
  fs.writeFileSync(connFile, JSON.stringify(profile));
  process.env.SVN_CONNECTIONS_FILE = connFile;
  process.env.SVN_EDIT_TEMP_DIR = path.join(root, "edit-tmp");
  process.env.SVN_EDIT_AUDIT_LOG = path.join(root, "audit.log");
  if (noLaunch) process.env.SVN_EDIT_NO_LAUNCH = "1";

  let counter = 0;
  /** 在遠端新增（或覆蓋）一個檔案。 */
  function seed(relPath, content) {
    const wc = path.join(root, `seed${counter++}`);
    svn("checkout", repoUrl, wc);
    const abs = path.join(wc, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const existed = fs.existsSync(abs);
    fs.writeFileSync(abs, content);
    if (!existed) svn("add", "--parents", abs);
    svn("commit", "-m", "seed", "--encoding", "UTF-8", wc);
  }
  /** 本機工作目錄：checkout 整個專案，或只 checkout 某個子目錄。 */
  function checkoutLocal(name, sub = "") {
    const dir = path.join(root, name);
    svn("checkout", sub ? `${repoUrl}/${sub}` : repoUrl, dir);
    return dir;
  }
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  if (autoCleanup) test.after(cleanup);

  return { root, repoDir, repoUrl, connFile, svn, seed, checkoutLocal, cleanup };
}
