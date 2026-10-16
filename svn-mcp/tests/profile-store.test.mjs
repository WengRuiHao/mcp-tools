// 單一設定檔（accounts／repoCache／prefs 合在一起）：格式、舊版升級、跨程式的鎖。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PROFILE_README, normalizeProfile, readProfile, readProfileStrict, serializeProfile, updateProfile } from "../dist/profile-store.js";
import { setStar, readRepoPrefs } from "../dist/repo-prefs.js";
import { readRepoCache, setRepoCacheEntry } from "../dist/repo-cache.js";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "svn-profile-test-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let counter = 0;
function useFresh() {
  const dir = path.join(root, `case${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "svn-connections.json");
  process.env.SVN_CONNECTIONS_FILE = file;
  delete process.env.SVN_REPOS_CACHE;
  delete process.env.SVN_REPO_PREFS;
  return { dir, file };
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf-8"));
const names = (dir, part) => fs.readdirSync(dir).filter((n) => n.includes(part));
const account = { id: "a1", name: "公司", url: "https://h/svn", username: "u", password: "p", kind: "server" };

test("格式 v2：_readme 在最前面，接著是 version、accounts、repoCache、prefs；說明裡有怎麼找專案庫", async () => {
  const { file } = useFresh();
  await updateProfile((p) => ({ ...p, accounts: [account] }));
  const raw = readJson(file);
  assert.deepEqual(Object.keys(raw), ["_readme", "version", "accounts", "repoCache", "prefs"]);
  assert.equal(raw.version, 2);
  assert.ok(Array.isArray(raw._readme) && raw._readme.length >= 4);
  assert.deepEqual(raw._readme, [...PROFILE_README]);
  const text = raw._readme.join("\n");
  for (const must of ["svn_find_repo", "svn_list_connections", "connectionId", "password", "accounts", "repoCache", "prefs", "folderNicknames", "nicknames"]) {
    assert.ok(text.includes(must), `_readme 要提到 ${must}`);
  }
  assert.ok(fs.readFileSync(file, "utf-8").startsWith('{\n  "_readme"'), "檔案一打開就先看到說明");
});

test("每次寫入都重新產生 _readme；檔案裡手動改過的說明不會留著", async () => {
  const { file } = useFresh();
  await updateProfile((p) => ({ ...p, accounts: [account] }));
  const raw = readJson(file);
  raw._readme = ["亂改的"];
  fs.writeFileSync(file, JSON.stringify(raw));
  await setStar("x", true);
  assert.deepEqual(readJson(file)._readme, [...PROFILE_README]);
});

test("normalizeProfile：缺的區塊補空、亂掉的項目丟掉；陣列視為舊格式；其他格式丟錯誤", () => {
  const empty = normalizeProfile({});
  assert.deepEqual(empty.profile, { version: 2, accounts: [], repoCache: {}, prefs: { starred: [], recent: {}, nicknames: {}, folders: {}, folderNicknames: {}, localPaths: {}, syncLocal: false } });
  assert.equal(empty.legacy, false);
  const messy = normalizeProfile({ accounts: [account, "壞", null, 5], repoCache: { a1: { repos: ["x", 5], fetchedAt: "t", auth: "windows" }, bad: { repos: "不是陣列" } }, prefs: { starred: ["a", 5] } });
  assert.deepEqual(messy.profile.accounts, [account]);
  assert.deepEqual(messy.profile.repoCache, { a1: { repos: ["x"], fetchedAt: "t", auth: "windows" } });
  assert.deepEqual(messy.profile.prefs.starred, ["a"]);
  const legacy = normalizeProfile([account, "壞"]);
  assert.equal(legacy.legacy, true);
  assert.deepEqual(legacy.profile.accounts, [account]);
  assert.throws(() => normalizeProfile("字串"));
  assert.throws(() => normalizeProfile(null));
  assert.equal(JSON.parse(serializeProfile(empty.profile)).version, 2);
});

test("舊格式（陣列）＋旁邊兩個舊檔：讀的時候自動併起來，不改檔案", async () => {
  const { dir, file } = useFresh();
  fs.writeFileSync(file, JSON.stringify([account]));
  fs.writeFileSync(path.join(dir, "svn-repos-cache.json"), JSON.stringify({ a1: { repos: ["r1", "r2"], fetchedAt: "t" } }));
  fs.writeFileSync(path.join(dir, "svn-repo-prefs.json"), JSON.stringify({ starred: ["r1"], nicknames: { r1: "一號" } }));
  const before = fs.readdirSync(dir).sort();
  const profile = await readProfileStrict();
  assert.deepEqual(profile.accounts, [account]);
  assert.deepEqual(profile.repoCache.a1.repos, ["r1", "r2"]);
  assert.deepEqual(profile.prefs.starred, ["r1"]);
  assert.equal(profile.prefs.nicknames.r1, "一號");
  assert.deepEqual(fs.readdirSync(dir).sort(), before, "只是讀，不能動任何檔案");
  assert.deepEqual(readJson(file), [account]);
});

test("舊格式第一次寫入：升級成 v2、備份原檔、旁邊兩個舊檔改名 .merged.bak；之後不再備份", async () => {
  const { dir, file } = useFresh();
  fs.writeFileSync(file, JSON.stringify([account]));
  fs.writeFileSync(path.join(dir, "svn-repos-cache.json"), JSON.stringify({ a1: { repos: ["r1"], fetchedAt: "t" } }));
  fs.writeFileSync(path.join(dir, "svn-repo-prefs.json"), JSON.stringify({ starred: ["r1"] }));

  await setStar("r2", true);
  const raw = readJson(file);
  assert.equal(raw.version, 2);
  assert.deepEqual(raw.accounts, [account]);
  assert.deepEqual(raw.repoCache.a1.repos, ["r1"], "舊快取檔的內容併進來了");
  assert.deepEqual(raw.prefs.starred, ["r1", "r2"], "舊偏好檔的內容併進來了，新的星星接在後面");

  const backups = names(dir, ".backup-v1-");
  assert.equal(backups.length, 1);
  assert.deepEqual(readJson(path.join(dir, backups[0])), [account], "備份是原樣的舊檔");
  assert.equal(fs.existsSync(path.join(dir, "svn-repos-cache.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "svn-repo-prefs.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "svn-repos-cache.json.merged.bak")), true);
  assert.equal(fs.existsSync(path.join(dir, "svn-repo-prefs.json.merged.bak")), true);

  await setStar("r3", true);
  assert.equal(names(dir, ".backup-v1-").length, 1, "已經是 v2，不再備份");
});

test("舊格式但沒有旁邊的檔案（只有連線陣列）也能升級", async () => {
  const { file } = useFresh();
  fs.writeFileSync(file, JSON.stringify([account]));
  await setStar("x", true);
  assert.equal(readJson(file).version, 2);
  assert.deepEqual(readJson(file).accounts, [account]);
});

test("變更函式丟錯誤：不寫檔、鎖照樣放掉（之後還能繼續寫）", async () => {
  const { dir, file } = useFresh();
  await setStar("a", true);
  const before = fs.readFileSync(file, "utf-8");
  await assert.rejects(updateProfile(() => { throw new Error("故意失敗"); }), /故意失敗/);
  assert.equal(fs.readFileSync(file, "utf-8"), before);
  assert.equal(fs.existsSync(`${file}.lock`), false, "鎖要放掉");
  await setStar("b", true);
  assert.deepEqual((await readRepoPrefs()).starred, ["a", "b"]);
  assert.deepEqual(fs.readdirSync(dir), ["svn-connections.json"]);
});

test("變更函式回傳 undefined：代表沒有要改，v2 檔案不會被重寫", async () => {
  const { file } = useFresh();
  await setStar("a", true);
  const before = fs.readFileSync(file, "utf-8");
  const mtimeBefore = fs.statSync(file).mtimeMs;
  await new Promise((r) => setTimeout(r, 30));
  await updateProfile(() => undefined);
  assert.equal(fs.readFileSync(file, "utf-8"), before);
  assert.equal(fs.statSync(file).mtimeMs, mtimeBefore);
});

test("設定檔壞掉：寬鬆讀取當成空的，嚴格讀取與寫入都拒絕，而且絕不覆蓋", async () => {
  const { file } = useFresh();
  fs.writeFileSync(file, "{ 人工改到一半");
  assert.deepEqual((await readProfile()).accounts, []);
  await assert.rejects(readProfileStrict(), /不是合法的 JSON/);
  await assert.rejects(updateProfile((p) => p), /不是合法的 JSON/);
  assert.equal(fs.readFileSync(file, "utf-8"), "{ 人工改到一半");
  fs.writeFileSync(file, '"只是個字串"');
  await assert.rejects(readProfileStrict(), /格式不正確/);
});

test("鎖：別人正拿著鎖時會等到放掉再寫；超過 60 秒的殘留鎖會被拆掉", async () => {
  const { file } = useFresh();
  const lockDir = `${file}.lock`;
  fs.mkdirSync(lockDir);
  setTimeout(() => fs.rmSync(lockDir, { recursive: true, force: true }), 400);
  const started = Date.now();
  await setStar("等鎖", true);
  assert.ok(Date.now() - started >= 300, "要等對方放掉鎖");
  assert.deepEqual((await readRepoPrefs()).starred, ["等鎖"]);

  fs.mkdirSync(lockDir);
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lockDir, old, old);
  const t2 = Date.now();
  await setStar("殘留鎖", true);
  assert.ok(Date.now() - t2 < 5000, "殘留的鎖不能卡住寫入");
  assert.deepEqual((await readRepoPrefs()).starred, ["等鎖", "殘留鎖"]);
});

/** 另開一個 node 程序，對同一個設定檔連續做 count 次寫入（模擬 svn-edit 與 MCP 是不同程式）。 */
function runWriter(kind, count, file) {
  const dist = pathToFileURL(path.resolve("dist")).href;
  const code = `
    const { setStar } = await import(process.env.DIST + "/repo-prefs.js");
    const { setRepoCacheEntry, newCacheEntry } = await import(process.env.DIST + "/repo-cache.js");
    for (let i = 0; i < ${count}; i++) {
      if ("${kind}".startsWith("stars")) await setStar("proc-${kind}-" + i, true);
      else await setRepoCacheEntry("acct-${kind}-" + i, newCacheEntry(["r" + i]));
    }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, SVN_CONNECTIONS_FILE: file, DIST: dist }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (exit) => (exit === 0 ? resolve() : reject(new Error(`寫入程序失敗（exit ${exit}）：${stderr}`))));
  });
}

test("跨程式：三個程序同時寫同一個檔案（兩個存星星、一個寫 repo 快取），所有寫入都留著、沒有互相蓋掉", { timeout: 120000 }, async () => {
  const { dir, file } = useFresh();
  await updateProfile((p) => ({ ...p, accounts: [account] }));
  await Promise.all([runWriter("stars", 25, file), runWriter("stars2", 25, file), runWriter("cache", 25, file)]);

  const profile = readJson(file);
  const starred = profile.prefs.starred;
  assert.equal(starred.filter((n) => n.startsWith("proc-stars-")).length, 25, "第一個程序的 25 筆星星都在");
  assert.equal(starred.filter((n) => n.startsWith("proc-stars2-")).length, 25, "第二個程序的 25 筆星星都在");
  assert.equal(Object.keys(profile.repoCache).filter((k) => k.startsWith("acct-cache-")).length, 25, "第三個程序的 25 筆快取都在");
  assert.deepEqual(profile.accounts, [account], "原本的帳號沒被動到");
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf-8")), "檔案始終是合法的 JSON");
  assert.deepEqual(fs.readdirSync(dir), ["svn-connections.json"], "沒留下暫存檔或鎖");
});

test("同一個程序內：repo 快取與偏好交錯寫入也不會互相蓋掉", async () => {
  useFresh();
  await Promise.all([
    ...Array.from({ length: 15 }, (_, i) => setStar(`s${i}`, true)),
    ...Array.from({ length: 15 }, (_, i) => setRepoCacheEntry(`c${i}`, { repos: [`r${i}`], fetchedAt: "t" })),
  ]);
  assert.equal((await readRepoPrefs()).starred.length, 15);
  assert.equal(Object.keys(await readRepoCache()).length, 15);
});
