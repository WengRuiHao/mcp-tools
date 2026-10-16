// 端到端：AI 透過 dev-pipeline-mcp 的 svn_find_repo 找專案庫——真的啟動 svn-mcp 子程序，讀「單一設定檔」，
// 確認使用者說的名稱（簡稱、舊名稱、常用目錄暱稱）能找到 connectionId 與目錄，而且回傳不含帳密。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callSvnTool, closeChildMcpClients } from "../dist/mcp-clients.js";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dp-find-repo-test-")));
const file = path.join(root, "svn-connections.json");
const profile = {
  _readme: ["測試用"],
  version: 2,
  accounts: [
    { id: "acct1", name: "測試帳號", url: "https://svn.example.invalid/svn", username: "tester", password: "TOP-SECRET-PW", kind: "server", aliases: { 舊系統: "order-repo" }, legacyIds: { 12345: "order-repo" } },
  ],
  repoCache: { acct1: { repos: ["order-repo", "billing-repo"], fetchedAt: new Date().toISOString() } },
  prefs: {
    starred: ["billing-repo"],
    recent: {},
    nicknames: { "billing-repo": "帳務" },
    folders: { "order-repo": ["docs/specs/backend"] },
    folderNicknames: { "order-repo": { "docs/specs/backend": "後端規格" } },
  },
};
fs.writeFileSync(file, JSON.stringify(profile));
// svn-mcp 子程序會繼承這個環境變數，讀同一份設定檔
process.env.SVN_CONNECTIONS_FILE = file;
process.env.SVN_EDIT_AUTOSTART = "0";

test.after(async () => {
  await closeChildMcpClients();
  fs.rmSync(root, { recursive: true, force: true });
});

test("用簡稱找：回傳 connectionId，不含帳密", { timeout: 60000 }, async () => {
  const result = await callSvnTool("svn_find_repo", { query: "帳務" });
  assert.equal(result.success, true);
  assert.equal(result.data.hits[0].connectionId, "billing-repo");
  assert.equal(result.data.hits[0].starred, true);
  const text = JSON.stringify(result);
  assert.equal(text.includes("TOP-SECRET-PW"), false);
  assert.equal(text.includes("password"), false);
});

test("用舊名稱找、用常用目錄暱稱找：回傳專案與可直接用的目錄路徑", { timeout: 60000 }, async () => {
  const byAlias = await callSvnTool("svn_find_repo", { query: "舊系統" });
  assert.equal(byAlias.data.hits[0].connectionId, "order-repo");

  const byFolder = await callSvnTool("svn_find_repo", { query: "後端規格" });
  const hit = byFolder.data.hits[0];
  assert.equal(hit.connectionId, "order-repo");
  assert.deepEqual(hit.folders[0], { path: "docs/specs/backend", nickname: "後端規格", matched: true });
  assert.match(byFolder.data.hint, /connectionId/);
});

test("svn_list_connections 也帶簡稱、星星、常用目錄；舊 id 與舊名稱都還能當 connectionId", { timeout: 60000 }, async () => {
  const list = await callSvnTool("svn_list_connections", {});
  const order = list.data.find((c) => c.name === "order-repo");
  assert.deepEqual(order.aliases, ["舊系統"]);
  assert.deepEqual(order.folders, [{ path: "docs/specs/backend", nickname: "後端規格" }]);
  assert.equal(list.data.find((c) => c.name === "billing-repo").nickname, "帳務");
  assert.equal(JSON.stringify(list).includes("TOP-SECRET-PW"), false);
});

test("找不到時成功回傳空清單與提示（不丟錯誤）", { timeout: 60000 }, async () => {
  const none = await callSvnTool("svn_find_repo", { query: "完全不存在的專案" });
  assert.equal(none.success, true);
  assert.equal(none.data.count, 0);
  assert.match(none.data.hint, /svn_list_connections/);
});
