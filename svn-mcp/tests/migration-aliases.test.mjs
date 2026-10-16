// 舊格式（每個 repo 一筆連線）→ 新格式（每個帳號一筆）的遷移，以及別名／舊 id 的查找。
// 這攸關其他工具（dev-pipeline 的設定用「專案甲」「20733443」找連線），所以每個情境都要鎖住。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeSvnServer } from "./fake-svn-server.mjs";
import { migrateLegacyConnections, splitRepoUrl, listPublicConnections, listPublicServers } from "../dist/connections-store.js";
import { findConnection, expandConnections, knownNames } from "../dist/connection-expand.js";
import { getConnectionsFilePath } from "../dist/config-store.js";
import { listConnections, resolveConnection } from "../dist/svn-client.js";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "svn-migrate-test-")));
const repos = ["ef", "tc", "gy", "extra"];
const fake = await startFakeSvnServer({ repos, users: { alice: "pw-a", bob: "pw-b" } });
test.after(async () => {
  await fake.close();
  fs.rmSync(root, { recursive: true, force: true });
});

let counter = 0;
function useFile(entries) {
  const file = path.join(root, `case${counter++}`, "svn-connections.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
  process.env.SVN_CONNECTIONS_FILE = file;
  return file;
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf-8"));
/** 設定檔現在是單一檔案：accounts／repoCache／prefs 三個區塊。 */
const readRaw = (file) => readJson(file).accounts;
const readCacheFromFile = () => readJson(getConnectionsFilePath()).repoCache;
const writeProfilePatch = (change) => {
  const file = getConnectionsFilePath();
  const profile = readJson(file);
  change(profile);
  fs.writeFileSync(file, JSON.stringify(profile));
};
const backups = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.includes(".backup-"));

/** 模擬使用者實際的舊檔：4 筆單一 repo（其中兩筆是同一個人只差大小寫）＋ 1 筆已載入過 repo 的伺服器。 */
const legacy = () => [
  { id: "id-ef", name: "專案甲", url: `${fake.url}/ef`, username: "bob", password: "pw-b", webUrl: "https://web/x" },
  { id: "id-tc", name: "台中法人", url: `${fake.url}/tc`, username: "alice", password: "pw-a" },
  { id: "id-gy", name: "丙銀", url: `${fake.url}/gy`, username: "ALICE", password: "pw-a" },
  { id: "srv-1", name: "公司伺服器", url: fake.url, username: "alice", password: "pw-a", kind: "server", repos: ["ef", "tc", "gy"] },
];

test("splitRepoUrl：拆出上層網址與 repo 名稱（中文、結尾斜線、百分比編碼）", () => {
  assert.deepEqual(splitRepoUrl("https://h/svn/PROJ-One"), { parent: "https://h/svn", repo: "PROJ-One" });
  assert.deepEqual(splitRepoUrl("https://h/svn/a%20b/"), { parent: "https://h/svn", repo: "a b" });
  assert.deepEqual(splitRepoUrl("https://h/repo"), { parent: "https://h", repo: "repo" });
  assert.equal(splitRepoUrl("https://h"), null);
  assert.equal(splitRepoUrl("not a url"), null);
});

test("遷移：同上層網址＋同帳號（不分大小寫）併進同一個帳號，不同帳號另開一個；連線檔只剩帳號", async () => {
  const file = useFile(legacy());
  const result = await migrateLegacyConnections();
  assert.equal(result.migrated, 3);
  assert.equal(result.kept, 0);
  assert.ok(result.backup && fs.existsSync(result.backup), "有變動前要先備份");

  const raw = readRaw(file);
  assert.equal(raw.length, 2, "兩個帳號：alice（含大小寫變體）與 bob");
  assert.ok(raw.every((e) => e.kind === "server"), "不能再有單一 repo 的連線");
  assert.ok(raw.every((e) => !("repos" in e)), "repo 清單搬去快取檔");

  const aliceEntry = raw.find((e) => e.id === "srv-1");
  assert.deepEqual(aliceEntry.aliases, { 台中法人: "tc", 丙銀: "gy" });
  assert.deepEqual(aliceEntry.legacyIds, { "id-tc": "tc", "id-gy": "gy" });
  const bobEntry = raw.find((e) => e.id !== "srv-1");
  assert.equal(bobEntry.username, "bob");
  assert.equal(bobEntry.password, "pw-b");
  assert.equal(bobEntry.name, "專案甲", "只有一筆舊連線的帳號，沿用那筆的名稱");
  assert.deepEqual(bobEntry.aliases, { 專案甲: "ef" });

  const cache = readCacheFromFile();
  assert.deepEqual(cache["srv-1"].repos, ["ef", "tc", "gy"], "原本存在連線檔裡的清單原樣搬過去");
  assert.deepEqual(cache[bobEntry.id].repos, [...repos].sort(), "新帳號的清單是向伺服器讀的");

  // 備份是原樣的舊檔，萬一要還原
  assert.equal(readJson(result.backup).length, 4, "備份是原樣的舊檔（4 筆）");
});

test("遷移是冪等的：已經是新格式就什麼都不做，不重複備份", async () => {
  const file = useFile(legacy());
  await migrateLegacyConnections();
  const backupsAfterFirst = backups(file).length;
  const after = fs.readFileSync(file, "utf-8");
  const second = await migrateLegacyConnections();
  assert.deepEqual(second, { migrated: 0, kept: 0, backup: null });
  assert.equal(fs.readFileSync(file, "utf-8"), after);
  assert.equal(backups(file).length, backupsAfterFirst, "第二次不能再產生備份");
});

test("遷移：連不上的舊連線維持原樣不轉換（不丟資料），其餘照轉；重複執行不會一直留備份", async () => {
  const file = useFile([...legacy(), { id: "id-dead", name: "連不上", url: "http://127.0.0.1:1/svn/dead", username: "x", password: "y" }]);
  const first = await migrateLegacyConnections();
  assert.equal(first.migrated, 3);
  assert.equal(first.kept, 1);
  const raw = readRaw(file);
  assert.equal(raw.filter((e) => e.kind !== "server").length, 1);
  assert.equal(raw.find((e) => e.kind !== "server").id, "id-dead");

  const backupsAfterFirst = backups(file).length;
  const second = await migrateLegacyConnections();
  assert.equal(second.backup, null, "沒有新的變動就不該再備份");
  assert.equal(backups(file).length, backupsAfterFirst);
});

test("遷移：帳號名稱重複時自動加編號；同一個帳號有多筆舊連線時用「網址（帳號）」當名稱", async () => {
  const file = useFile([
    { id: "a1", name: "公司伺服器", url: `${fake.url}/ef`, username: "bob", password: "pw-b" },
    { id: "a2", name: "第二個", url: `${fake.url}/tc`, username: "bob", password: "pw-b" },
    { id: "s", name: "127.0.0.1", url: fake.url, username: "alice", password: "pw-a", kind: "server" },
  ]);
  await migrateLegacyConnections();
  const names = readRaw(file).map((e) => e.name);
  assert.equal(new Set(names).size, names.length);
  const bob = readRaw(file).find((e) => e.username === "bob");
  assert.match(bob.name, /\(?（?bob/);
  assert.deepEqual(bob.aliases, { 公司伺服器: "ef", 第二個: "tc" });
});

test("遷移後：所有舊名稱與舊 id 仍找得到連線，而且用的是當初那個帳號的帳密", async () => {
  useFile(legacy());
  await migrateLegacyConnections();

  const byOldName = await resolveConnection("專案甲");
  assert.equal(byOldName.username, "bob", "別名用擁有它的那個帳號（bob）");
  assert.equal(byOldName.url, `${fake.url}/ef`);
  assert.equal((await resolveConnection("丙銀")).url, `${fake.url}/gy`);
  assert.equal((await resolveConnection("id-gy")).url, `${fake.url}/gy`, "舊 id（例如 dev-pipeline 設定裡的 20733443）");
  assert.equal((await resolveConnection("tc")).username, "alice", "直接用 repo 名稱也行");
  assert.equal((await resolveConnection("srv-1:tc")).url, `${fake.url}/tc`, "展開後的 id");

  await assert.rejects(resolveConnection("不存在的名稱"), (e) => /找不到 SVN 連線/.test(e.message) && /專案甲/.test(e.message), "錯誤訊息要列出可用名稱（含別名）");
});

test("svn_list_connections 的資料：每個 repo 一筆，帶別名，不含帳密", async () => {
  useFile(legacy());
  await migrateLegacyConnections();
  const result = await listConnections();
  assert.equal(result.success, true);
  const list = result.data;
  assert.deepEqual(list.map((c) => c.name).sort(), [...repos].sort());
  assert.deepEqual(list.find((c) => c.name === "ef").aliases, ["專案甲"], "別名會合併所有帳號的設定");
  assert.ok(list.every((c) => !("password" in c) && !("username" in c)));
});

test("畫面用的清單：下拉選單的 repo 名稱帶別名；帳號清單只有帳號", async () => {
  useFile(legacy());
  await migrateLegacyConnections();
  const conns = await listPublicConnections();
  assert.deepEqual(conns.find((c) => c.name === "gy").aliases, ["丙銀"]);
  const servers = await listPublicServers();
  assert.equal(servers.length, 2);
  assert.ok(servers.every((s) => typeof s.repoCount === "number" && !("password" in s)));
});

test("快取檔被刪掉：第一次用到時自動向伺服器補回來，不需要人工處理", async () => {
  useFile(legacy());
  await migrateLegacyConnections();
  writeProfilePatch((profile) => { profile.repoCache = {}; });
  assert.equal((await resolveConnection("extra")).url, `${fake.url}/extra`);
  assert.ok(Object.keys(readCacheFromFile()).length > 0, "補回來的清單要寫回 repoCache 區塊");
});

test("伺服器上新建的 repo：快取過期後找不到就自動重新讀一次；別名即使快取沒有也查得到", async () => {
  const file = useFile(legacy());
  await migrateLegacyConnections();
  writeProfilePatch((profile) => {
    for (const entry of Object.values(profile.repoCache)) entry.fetchedAt = "2000-01-01T00:00:00.000Z";
    profile.repoCache["srv-1"].repos = ["tc"]; // 快取裡只剩一個，模擬「舊清單」
  });
  assert.equal((await resolveConnection("丙銀")).url, `${fake.url}/gy`, "別名不依賴快取");

  repos.push("brandnew");
  try {
    fake.requests.length = 0;
    assert.equal((await resolveConnection("brandnew")).url, `${fake.url}/brandnew`);
    assert.ok(fake.requests.length > 0, "找不到才會連伺服器");
    fake.requests.length = 0;
    await resolveConnection("tc");
    assert.equal(fake.requests.length, 0, "找得到時不連網路");
  } finally {
    repos.pop();
  }
  assert.ok(fs.existsSync(file));
});

test("純函式：別名優先用擁有它的帳號；同一個 repo 在多個帳號底下只列一次", () => {
  const entries = [
    { id: "s1", name: "A", url: "https://h/svn", username: "alice", password: "pa", kind: "server", aliases: { 小名: "r1" } },
    { id: "s2", name: "B", url: "https://h/svn", username: "bob", password: "pb", kind: "server", aliases: { 專案甲: "r1" }, legacyIds: { old1: "r1" } },
  ];
  const cache = { s1: { repos: ["r1", "r2"], fetchedAt: "" }, s2: { repos: ["r1", "r2"], fetchedAt: "" } };
  const list = expandConnections(entries, cache);
  assert.deepEqual(list.map((c) => c.name), ["r1", "r2"]);
  assert.equal(list[0].username, "alice", "直接用 repo 名稱時，以排在前面的帳號為準");
  assert.deepEqual(list[0].aliases.sort(), ["小名", "專案甲"].sort(), "別名合併顯示，舊 id 不顯示");
  assert.equal(findConnection(entries, cache, "專案甲").username, "bob");
  assert.equal(findConnection(entries, cache, "old1").username, "bob");
  assert.equal(findConnection(entries, cache, "小名").username, "alice");
  assert.equal(findConnection(entries, cache, "沒有"), undefined);
  assert.deepEqual(knownNames(entries, cache).sort(), ["r1", "r2", "小名", "專案甲"].sort());
});

test("簡稱也能當 connectionId：使用者取的簡稱直接生效（舊別名被刪掉後，dev-pipeline 用「專案甲」之類的名稱仍找得到）", () => {
  const entries = [{ id: "s1", name: "帳號", url: "https://h/svn", username: "u", password: "p", kind: "server" }];
  const cache = { s1: { repos: ["PROJ-One", "projbeta", "other"], fetchedAt: "t" } };
  const nicknames = { "PROJ-One": "專案甲", projbeta: "丙銀" };
  assert.equal(findConnection(entries, cache, "專案甲", nicknames).name, "PROJ-One");
  assert.equal(findConnection(entries, cache, "丙銀", nicknames).url, "https://h/svn/projbeta");
  assert.equal(findConnection(entries, cache, "專案甲"), undefined, "沒帶簡稱表就找不到（純函式不會自己去讀偏好）");
  assert.equal(findConnection(entries, cache, "projbeta", nicknames).name, "projbeta", "repo 名稱優先於簡稱");
  assert.deepEqual(knownNames(entries, cache, nicknames).sort(), ["PROJ-One", "projbeta", "other", "專案甲", "丙銀"].sort(), "錯誤訊息的可用名稱也列出簡稱");
});

test("簡稱重複（兩個專案取了同一個簡稱）：無法判斷就當作找不到，不要猜", () => {
  const entries = [{ id: "s1", name: "帳號", url: "https://h/svn", username: "u", password: "p", kind: "server" }];
  const cache = { s1: { repos: ["a", "b"], fetchedAt: "t" } };
  assert.equal(findConnection(entries, cache, "同名", { a: "同名", b: "同名" }), undefined);
  assert.equal(findConnection(entries, cache, "同名", { a: "同名", b: "別的" }).name, "a");
});

test("經由設定檔：prefs 裡的簡稱可以拿來 resolveConnection（MCP 工具與 dev-pipeline 實際走的路徑）", async () => {
  const file = path.join(root, "nick-profile.json");
  process.env.SVN_CONNECTIONS_FILE = file;
  fs.writeFileSync(file, JSON.stringify({
    version: 2,
    accounts: [{ id: "s1", name: "帳號", url: "https://h/svn", username: "u", password: "p", kind: "server" }],
    repoCache: { s1: { repos: ["PROJ-One", "projbeta"], fetchedAt: new Date().toISOString() } },
    prefs: { starred: [], recent: {}, nicknames: { "PROJ-One": "專案甲" }, folders: {}, folderNicknames: {} },
  }));
  assert.equal((await resolveConnection("專案甲")).url, "https://h/svn/PROJ-One");
  await assert.rejects(resolveConnection("不存在"), (e) => /專案甲/.test(e.message), "可用名稱裡也列出簡稱");
});
