// svn_find_repo：使用者說的名稱（簡稱、舊名稱、repo 名稱、常用目錄暱稱）→ 該用哪個 connectionId、檔案大概在哪個目錄。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerConnectionTools } from "../dist/connection-tools.js";
import { searchRepos } from "../dist/repo-search.js";
import { findRepos, listConnections, resolveConnection } from "../dist/svn-client.js";

const accounts = [
  { id: "s1", name: "公司", url: "https://svn.example.com/svn", username: "alice", password: "SECRET-1", kind: "server", aliases: { 專案甲: "PROJ-One", 丙銀: "projbeta" }, legacyIds: { 20733443: "projbeta" } },
  { id: "s2", name: "第二個", url: "https://svn.example.com/svn", username: "bob", password: "SECRET-2", kind: "server" },
];
const cache = { s1: { repos: ["PROJ-One", "projbeta", "TCSociety", "PROJ-Gamma", "other"], fetchedAt: "t" }, s2: { repos: ["projbeta", "extra"], fetchedAt: "t" } };
const prefs = {
  starred: ["TCSociety", "projbeta"],
  recent: { projbeta: "2026-10-15T08:00:00.000Z", other: "2026-10-14T08:00:00.000Z" },
  nicknames: { projbeta: "丙銀簡稱", TCSociety: "台中" },
  folders: { projbeta: ["4.系統開發/規格書/後端", "4.系統開發/規格書/前端"], "PROJ-One": ["3-SD/9-SOURCE"] },
  folderNicknames: { projbeta: { "4.系統開發/規格書/後端": "後端規格" }, "PROJ-One": { "3-SD/9-SOURCE": "原始碼" } },
};
const search = (q, limit) => searchRepos(accounts, cache, prefs, q, limit);
const top = (q) => search(q)[0];

test("用 repo 名稱找：完全相同優先於包含", () => {
  assert.equal(top("projbeta").connectionId, "projbeta");
  assert.equal(top("tcsociety").connectionId, "TCSociety", "不分大小寫");
  assert.deepEqual(search("amma").map((h) => h.name), ["PROJ-Gamma"], "包含也找得到");
});

test("用舊版取的名稱（別名）找：「專案甲」→ PROJ-One", () => {
  const hit = top("專案甲");
  assert.equal(hit.name, "PROJ-One");
  assert.equal(hit.connectionId, "PROJ-One");
  assert.ok(hit.matchedOn.some((r) => r.includes("舊名稱：專案甲")));
  assert.deepEqual(hit.aliases, ["專案甲"]);
});

test("用使用者自己取的簡稱找", () => {
  assert.equal(top("台中").name, "TCSociety");
  assert.ok(top("台中").matchedOn.some((r) => r.includes("簡稱：台中")));
  assert.equal(top("丙銀簡稱").name, "projbeta");
});

test("用常用目錄的暱稱找：回傳專案與那個目錄（matched），目錄路徑可以直接當 path", () => {
  const hit = top("後端規格");
  assert.equal(hit.name, "projbeta");
  assert.ok(hit.matchedOn.some((r) => r.includes("常用目錄暱稱：後端規格")));
  assert.equal(hit.folders[0].path, "4.系統開發/規格書/後端");
  assert.equal(hit.folders[0].nickname, "後端規格");
  assert.equal(hit.folders[0].matched, true);
  assert.equal(hit.folders[1].matched, false, "沒比對到的目錄排在後面");
  assert.equal(top("原始碼").name, "PROJ-One");
});

test("用常用目錄的路徑片段找", () => {
  assert.equal(top("規格書/前端").name, "projbeta");
  assert.equal(top("規格書/前端").folders[0].path, "4.系統開發/規格書/前端");
});

test("多個關鍵字要全部符合：專案＋目錄暱稱可以一起說", () => {
  assert.deepEqual(search("丙銀 後端規格").map((h) => h.name), ["projbeta"]);
  assert.deepEqual(search("專案甲 後端規格"), [], "專案甲沒有叫後端規格的目錄");
  assert.deepEqual(search("tc 不存在"), []);
});

test("找不到回傳空陣列；關鍵字留空＝列出常用（星星依畫面順序在最前面，其次最近開過的，最後依名稱）", () => {
  assert.deepEqual(search("完全沒有的專案"), []);
  const all = search("", 50).map((h) => h.name);
  assert.deepEqual(all.slice(0, 3), ["TCSociety", "projbeta", "other"], "星星 TCSociety、projbeta 在最前，之後是最近開過的 other");
  assert.equal(all.length, 6, "同名 repo 只列一次（projbeta 在兩個帳號底下）");
  assert.equal(search("", 2).length, 2, "limit 有效");
  assert.equal(search("", 0).length, 1, "limit 至少 1");
});

test("名稱同樣吻合時，星星專案排前面；回傳的 url 是帳號網址加 repo 名稱", () => {
  const twoRepos = { s1: { repos: ["alpha1", "alpha2", "alpha3"], fetchedAt: "t" } };
  const hits = searchRepos([accounts[0]], twoRepos, { ...prefs, starred: ["alpha2"], recent: {}, nicknames: {}, folders: {}, folderNicknames: {} }, "alpha");
  assert.deepEqual(hits.map((h) => h.name), ["alpha2", "alpha1", "alpha3"], "三個都是開頭吻合，有星星的 alpha2 排最前面，其餘依名稱");
  assert.equal(top("projbeta").url, "https://svn.example.com/svn/projbeta");
});

test("回傳內容絕不含帳密", () => {
  const text = JSON.stringify(search("", 50));
  assert.equal(text.includes("SECRET-1"), false);
  assert.equal(text.includes("SECRET-2"), false);
  assert.equal(text.includes("password"), false);
});

// ---- 經由設定檔與 MCP 工具實際呼叫 ----

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "svn-find-test-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function useProfile() {
  const file = path.join(root, "svn-connections.json");
  process.env.SVN_CONNECTIONS_FILE = file;
  fs.writeFileSync(file, JSON.stringify({ version: 2, accounts, repoCache: cache, prefs }));
  return file;
}

test("findRepos（svn-client）：讀單一設定檔，找得到；connectionId 真的能拿去 resolveConnection", async () => {
  useProfile();
  const result = await findRepos("後端規格", 5);
  assert.equal(result.success, true);
  assert.equal(result.data.count, 1);
  const hit = result.data.hits[0];
  assert.match(result.data.hint, /connectionId/);
  const conn = await resolveConnection(hit.connectionId);
  assert.equal(conn.url, "https://svn.example.com/svn/projbeta");
  assert.equal((await resolveConnection("專案甲")).name, "PROJ-One", "舊名稱仍可當 connectionId");
  assert.equal((await resolveConnection("20733443")).name, "projbeta", "舊 id 也行");
});

test("svn_list_connections 的資料：每個專案帶簡稱、星星、常用目錄，不含帳密", async () => {
  useProfile();
  const result = await listConnections();
  const projbeta = result.data.find((c) => c.name === "projbeta");
  assert.equal(projbeta.nickname, "丙銀簡稱");
  assert.equal(projbeta.starred, true);
  assert.deepEqual(projbeta.folders[0], { path: "4.系統開發/規格書/後端", nickname: "後端規格" });
  assert.deepEqual(projbeta.aliases, ["丙銀"]);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});

test("MCP 工具 svn_find_repo：有註冊、參數說明清楚、實際呼叫回傳 JSON；沒有設定檔時不會當掉", async () => {
  useProfile();
  const server = new McpServer({ name: "svn-mcp-test", version: "0.0.0" });
  registerConnectionTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === "svn_find_repo");
    assert.ok(tool, "svn_find_repo 要被註冊");
    assert.match(tool.description, /簡稱/);
    assert.match(tool.description, /常用目錄/);
    assert.match(tool.description, /connectionId/);
    assert.deepEqual(tool.inputSchema.required, ["query"]);

    const reply = await client.callTool({ name: "svn_find_repo", arguments: { query: "丙銀 後端規格" } });
    assert.equal(reply.isError, false);
    const body = JSON.parse(reply.content[0].text);
    assert.equal(body.success, true);
    assert.equal(body.data.hits[0].connectionId, "projbeta");
    assert.equal(body.data.hits[0].folders[0].path, "4.系統開發/規格書/後端");

    fs.rmSync(process.env.SVN_CONNECTIONS_FILE);
    const empty = JSON.parse((await client.callTool({ name: "svn_find_repo", arguments: { query: "projbeta" } })).content[0].text);
    assert.equal(empty.success, true);
    assert.equal(empty.data.count, 0);
    assert.match(empty.data.hint, /svn_list_connections/);
  } finally {
    await client.close();
    await server.close();
  }
});
