// svn-edit 設定頁用的連線（帳號）讀寫：與 svn-mcp 唯讀工具共用同一份 svn-connections.json。
// 連線檔只存帳號；repo 清單放在獨立的快取檔。用假的 SVN 上層網址驗證「先測試連線才儲存」。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeSvnServer } from "./fake-svn-server.mjs";
import { deleteServer, fillMissingRepoCaches, listPublicConnections, listPublicServers, refreshAllServers, refreshServer, saveServer, testServerLogin, ConnectionInputError } from "../dist/connections-store.js";
import { getConnectionsFilePath } from "../dist/config-store.js";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "svn-conn-test-")));
const repos = ["alpha", "beta", "規格庫"];
const fake = await startFakeSvnServer({ repos, users: { alice: "pw-a", bob: "pw-b" } });
test.after(async () => {
  await fake.close();
  fs.rmSync(root, { recursive: true, force: true });
});

let counter = 0;
/** 每個測試用自己的設定檔路徑（放在還不存在的子目錄裡，順便驗證會自動建立目錄）。 */
function useFreshFile() {
  const file = path.join(root, `case${counter++}`, "info", "svn-connections.json");
  process.env.SVN_CONNECTIONS_FILE = file;
  return file;
}
/** 設定檔現在是單一檔案：accounts／repoCache／prefs 三個區塊。 */
const readProfileFile = (file) => JSON.parse(fs.readFileSync(file, "utf-8"));
const readRaw = (file) => readProfileFile(file).accounts;
const readCache = () => readProfileFile(getConnectionsFilePath()).repoCache;
const alice = { name: "我的帳號", url: fake.url, username: "alice", password: "pw-a" };

test("SVN_CONNECTIONS_FILE 決定設定檔路徑；帳號、repo 快取、偏好都在這一個檔案裡", async () => {
  const file = useFreshFile();
  assert.equal(getConnectionsFilePath(), path.resolve(file));
  await saveServer(alice);
  const profile = readProfileFile(file);
  assert.deepEqual(Object.keys(profile), ["_readme", "version", "accounts", "repoCache", "prefs"], "_readme 放最前面，AI 打開檔案先看到說明");
  assert.equal(profile.version, 2);
});

test("新增帳號：accounts 區塊只存帳號，repo 清單在 repoCache 區塊，公開清單不含密碼", async () => {
  const file = useFreshFile();
  assert.deepEqual(await listPublicConnections(), []); // 檔案不存在視為沒有任何連線
  const saved = await saveServer(alice);
  assert.equal(saved.repoCount, 3);
  assert.equal("password" in saved, false);

  const raw = readRaw(file);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].kind, "server");
  assert.equal(raw[0].password, "pw-a"); // 檔案裡有存，但不會從 API 出去
  assert.equal("repos" in raw[0], false, "帳號項目裡不能有 repo 清單（清單在 repoCache）");
  assert.deepEqual(readCache()[raw[0].id].repos, [...repos].sort());

  const servers = await listPublicServers();
  assert.deepEqual(servers.map((s) => [s.name, s.username, s.repoCount]), [["我的帳號", "alice", 3]]);
  assert.equal("password" in servers[0], false);
  const conns = await listPublicConnections();
  assert.deepEqual(conns.map((c) => c.name).sort(), [...repos].sort());
  assert.equal(conns.find((c) => c.name === "alpha").url, `${fake.url}/alpha`);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["svn-connections.json"]); // 只有一個檔案，沒留下暫存檔或鎖
});

test("連不上或密碼錯：不儲存，並回傳原因", async () => {
  const file = useFreshFile();
  await assert.rejects(saveServer({ ...alice, password: "wrong" }), (e) => e instanceof ConnectionInputError && /帳號或密碼不正確/.test(e.message));
  assert.equal(fs.existsSync(file), false, "測試失敗時連檔案都不該建立");
  await assert.rejects(saveServer({ ...alice, url: "http://127.0.0.1:1/svn" }), (e) => e instanceof ConnectionInputError && /連不上/.test(e.message));
  assert.equal(fs.existsSync(file), false);
});

test("測試連線：只測不存；編輯既有帳號時密碼留空就用已存的", async () => {
  const file = useFreshFile();
  assert.deepEqual(await testServerLogin(alice), { repoCount: 3, auth: "credentials" });
  assert.equal(fs.existsSync(file), false, "只測試不能寫檔");
  await assert.rejects(testServerLogin({ ...alice, password: "wrong" }), ConnectionInputError);

  const saved = await saveServer(alice);
  assert.equal((await testServerLogin({ id: saved.id, url: fake.url, username: "alice", password: "" })).repoCount, 3);
  await assert.rejects(testServerLogin({ id: "nope", url: fake.url, username: "alice" }), /找不到/);
});

test("更新帳號：可改名稱、網址、帳號；密碼留空不變更；保留別名等其他欄位", async () => {
  const file = useFreshFile();
  const saved = await saveServer(alice);
  const profile = readProfileFile(file);
  profile.accounts[0].aliases = { 舊名: "alpha" };
  profile.accounts[0].note = "人工加的欄位";
  fs.writeFileSync(file, JSON.stringify(profile));

  const updated = await saveServer({ id: saved.id, name: "新名稱", url: `${fake.url}/`, username: "bob", password: "pw-b" });
  assert.equal(updated.name, "新名稱");
  assert.deepEqual(readRaw(file).length, 1);
  assert.equal(readRaw(file)[0].username, "bob");
  assert.deepEqual(readRaw(file)[0].aliases, { 舊名: "alpha" });
  assert.equal(readRaw(file)[0].note, "人工加的欄位");

  await saveServer({ id: saved.id, name: "新名稱", url: fake.url, username: "bob", password: "" }); // 留空沿用 pw-b，仍可通過測試
  assert.equal(readRaw(file)[0].password, "pw-b");
  assert.equal(readRaw(file)[0].url, fake.url, "網址結尾斜線會被去掉");
});

test("沒指定 id 但網址與帳號已登記過，視為更新同一個帳號，不重複新增", async () => {
  const file = useFreshFile();
  await saveServer(alice);
  await saveServer({ ...alice, name: "改名了" });
  const raw = readRaw(file);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].name, "改名了");
});

test("不合法的輸入一律拒絕，且不動檔案", async () => {
  const file = useFreshFile();
  await saveServer(alice);
  const before = fs.readFileSync(file, "utf-8");
  const bad = [
    [{ ...alice, name: "x".repeat(61) }, /太長/],
    [{ ...alice, name: "另一個", url: "file:///c:/repo" }, /https/],
    [{ ...alice, name: "另一個", url: "ftp://x/y" }, /https/],
    [{ ...alice, name: "我的帳號", username: "bob", password: "pw-b" }, /已經有名稱/], // 名稱重複
    [{ id: "nope", ...alice }, /找不到/],
  ];
  for (const [input, pattern] of bad) {
    await assert.rejects(saveServer(input), (e) => e instanceof ConnectionInputError && pattern.test(e.message), JSON.stringify(input).slice(0, 60));
  }
  assert.equal(fs.readFileSync(file, "utf-8"), before);
});

test("重新載入：伺服器上新增的 repo 會出現在 repoCache 區塊，accounts 區塊不變", async () => {
  const file = useFreshFile();
  const saved = await saveServer(alice);
  const accountsBefore = JSON.stringify(readRaw(file));
  repos.push("gamma");
  try {
    const refreshed = await refreshServer(saved.id);
    assert.equal(refreshed.repoCount, 4);
    assert.ok(readCache()[saved.id].repos.includes("gamma"));
    assert.equal(JSON.stringify(readRaw(file)), accountsBefore, "帳號區塊不能被動到");
    await assert.rejects(refreshServer("nope"), /找不到/);
  } finally {
    repos.pop();
  }
});

test("刪除帳號：連同 repo 快取一起移除；其他帳號不受影響；找不到的 id 拒絕", async () => {
  const file = useFreshFile();
  const a = await saveServer(alice);
  const b = await saveServer({ name: "第二個", url: fake.url, username: "bob", password: "pw-b" });
  assert.equal(readRaw(file).length, 2);

  assert.deepEqual(await deleteServer(a.id), { id: a.id });
  assert.deepEqual(readRaw(file).map((e) => e.id), [b.id]);
  assert.deepEqual(Object.keys(readCache()), [b.id]);
  await assert.rejects(deleteServer(a.id), /找不到/);
  assert.equal((await listPublicServers()).length, 1);
});

test("設定檔壞掉（不是合法 JSON）時拒絕寫入，絕不覆蓋", async () => {
  const file = useFreshFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ 這是人工改到一半的檔案");
  await assert.rejects(saveServer(alice), /不是合法的 JSON/);
  assert.equal(fs.readFileSync(file, "utf-8"), "{ 這是人工改到一半的檔案");
});

test("同時送出多個新增請求不會互相蓋掉", async () => {
  const file = useFreshFile();
  await Promise.all([1, 2, 3, 4].map((n) => saveServer({ name: `帳號${n}`, url: fake.url, username: n % 2 ? "alice" : "bob", password: n % 2 ? "pw-a" : "pw-b", id: undefined }).catch(() => null)));
  // 網址＋帳號相同的會被視為同一個帳號（只留一筆）；不同帳號的不能互相蓋掉
  const usernames = readRaw(file).map((e) => e.username).sort();
  assert.deepEqual([...new Set(usernames)], ["alice", "bob"]);
  assert.equal(usernames.length, new Set(usernames).size);
});

test("設定檔有 UTF-8 BOM 也讀得進來", async () => {
  const file = useFreshFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `\uFEFF${JSON.stringify([{ id: "s1", name: "BOM 帳號", url: fake.url, username: "alice", password: "pw-a", kind: "server", repos: ["alpha"] }])}`);
  assert.deepEqual((await listPublicServers()).map((s) => s.name), ["BOM 帳號"]);
  assert.deepEqual((await listPublicConnections()).map((c) => c.name), ["alpha"]);
});

test("補齊快取：只補沒有快取的帳號、連不上的略過、已有快取的不重讀", async () => {
  const file = useFreshFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 2, prefs: {}, repoCache: { have: { repos: ["舊的"], fetchedAt: "2020-01-01T00:00:00.000Z" } }, accounts: [
    { id: "ok", name: "要補的", url: fake.url, username: "alice", password: "pw-a", kind: "server" },
    { id: "dead", name: "連不上", url: "http://127.0.0.1:1/svn", username: "x", password: "y", kind: "server" },
    { id: "have", name: "已有快取", url: fake.url, username: "bob", password: "pw-b", kind: "server" },
  ] }));

  assert.equal(await fillMissingRepoCaches(), 1);
  const cache = readCache();
  assert.deepEqual(cache.ok.repos, [...repos].sort());
  assert.equal("dead" in cache, false);
  assert.deepEqual(cache.have.repos, ["舊的"], "已有快取的不能被覆蓋");
  assert.equal(await fillMissingRepoCaches(), 0, "再跑一次沒有東西要補（連不上的不算）");
});

test("全部重新載入：單一帳號失敗不影響其他，回報成功數、repo 總數與失敗原因", async () => {
  const file = useFreshFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([
    { id: "a", name: "好的", url: fake.url, username: "alice", password: "pw-a", kind: "server" },
    { id: "b", name: "密碼錯", url: fake.url, username: "alice", password: "wrong", kind: "server" },
  ]));
  const result = await refreshAllServers();
  assert.equal(result.refreshed, 1);
  assert.equal(result.repoCount, repos.length);
  assert.deepEqual(result.failed.map((f) => f.name), ["密碼錯"]);
  assert.match(result.failed[0].error, /帳號或密碼不正確/);
  assert.deepEqual(Object.keys(readCache()), ["a"]);
});
