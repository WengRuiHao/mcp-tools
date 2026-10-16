// 本機資料夾瀏覽／檢查、Checkout 到本地、多個本地目錄的同步：用本機臨時 SVN 儲存庫，不連任何真實 SVN。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkoutToLocal } from "../dist/local-checkout.js";
import { inspectLocalDirs, listLocalDirs } from "../dist/local-fs.js";
import { commitEditAndSync } from "../dist/local-sync.js";
import { EditError, openEdit } from "../dist/remote-edit-client.js";
import { addLocalPath, readRepoPrefs, removeLocalPath, setSyncLocal } from "../dist/repo-prefs.js";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "svn-checkout-test-")));
const parentDir = path.join(root, "repos");
const repoDir = path.join(parentDir, "myrepo");
const profileFile = path.join(root, "info", "svn-connections.json");
const svn = (...args) => execFileSync("svn", [...args, "--non-interactive"], { encoding: "utf-8" });
const CONN = "s1:myrepo";

fs.mkdirSync(parentDir, { recursive: true });
execFileSync("svnadmin", ["create", repoDir]);
const repoUrl = pathToFileURL(repoDir).href;
fs.mkdirSync(path.dirname(profileFile), { recursive: true });
fs.writeFileSync(
  profileFile,
  JSON.stringify({
    version: 2,
    accounts: [{ id: "s1", name: "srv", url: pathToFileURL(parentDir).href, username: "u", password: "p", kind: "server" }],
    repoCache: { s1: { repos: ["myrepo"], fetchedAt: new Date().toISOString(), auth: "credentials" } },
    prefs: {},
  })
);
process.env.SVN_CONNECTIONS_FILE = profileFile;
process.env.SVN_EDIT_TEMP_DIR = path.join(root, "edit-tmp");
process.env.SVN_EDIT_AUDIT_LOG = path.join(root, "audit.log");

const seedWc = path.join(root, "seed");
svn("checkout", repoUrl, seedWc);
for (const [rel, content] of [
  ["spec/a.md", "a\n"],
  ["spec/b.md", "b\n"],
  ["spec/deep/c.md", "c\n"],
  ["other/o.md", "o\n"],
  ["file-only.md", "f\n"],
]) {
  const abs = path.join(seedWc, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
svn("add", "--force", seedWc);
svn("commit", "-m", "seed", "--encoding", "UTF-8", seedWc);

const slash = (p) => p.split(path.sep).join("/");
let counter = 0;
/** 每個測試用自己的空資料夾當「放在哪裡」。 */
function freshParent() {
  const dir = path.join(root, `place${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const code = (c) => (e) => e instanceof EditError && e.code === c;
async function resetPrefs() {
  await setSyncLocal(false);
  for (const dir of (await readRepoPrefs()).localPaths.myrepo ?? []) await removeLocalPath("myrepo", dir);
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// ---- 本機資料夾瀏覽 ----

test("本機資料夾瀏覽：只列資料夾、依名稱排序、標出 SVN 工作目錄、回報上一層與是否在工作目錄裡", () => {
  const base = path.join(root, "browse-fs");
  fs.mkdirSync(path.join(base, "b-plain"), { recursive: true });
  fs.mkdirSync(path.join(base, "a-wc", ".svn"), { recursive: true });
  fs.mkdirSync(path.join(base, "a-wc", "inner"), { recursive: true });
  fs.writeFileSync(path.join(base, "just-a-file.txt"), "x");

  const top = listLocalDirs(base);
  assert.equal(top.path, slash(base));
  assert.deepEqual(top.entries.map((e) => e.name), ["a-wc", "b-plain"], "只有資料夾、依名稱排序");
  assert.deepEqual(top.entries.map((e) => e.isWc), [true, false]);
  assert.equal(top.inWc, false);
  assert.equal(top.parent, slash(path.dirname(base)));

  const inner = listLocalDirs(path.join(base, "a-wc"));
  assert.deepEqual(inner.entries.map((e) => e.name), ["inner"], ".svn 不會列出來");
  assert.equal(inner.inWc, true, "工作目錄自己算在工作目錄裡");
  assert.equal(listLocalDirs(path.join(base, "a-wc", "inner")).inWc, true, "子資料夾也算");
});

test("本機資料夾瀏覽：空字串列出磁碟機；不存在、不是資料夾、不是完整路徑都拒絕", () => {
  const drives = listLocalDirs("");
  assert.equal(drives.path, "");
  assert.equal(drives.parent, null);
  assert.ok(drives.entries.length >= 1);
  assert.throws(() => listLocalDirs(path.join(root, "nope")), code("NOT_FOUND"));
  assert.throws(() => listLocalDirs(path.join(root, "info", "svn-connections.json")), code("INVALID_INPUT"));
  assert.throws(() => listLocalDirs("relative/dir"), code("INVALID_INPUT"));
});

test("檢查本地目錄：回報存在與否、有沒有 SVN 追蹤、對應的遠端網址", async () => {
  const wc = path.join(root, "inspect-wc");
  svn("checkout", `${repoUrl}/spec`, wc);
  const plain = freshParent();
  const results = await inspectLocalDirs([wc, plain, path.join(root, "missing-dir"), "relative"]);
  assert.equal(results[0].isWc, true);
  assert.match(results[0].url, /\/myrepo\/spec$/);
  assert.deepEqual([results[1].exists, results[1].isWc], [true, false]);
  assert.deepEqual([results[2].exists, results[2].isWc], [false, false]);
  assert.equal(results[3].exists, false);
  assert.deepEqual([results[0].inWc, results[1].inWc, results[2].inWc], [true, false, false], "在不在工作目錄裡面");
  assert.deepEqual([results[0].nonEmpty, results[1].nonEmpty, results[2].nonEmpty], [true, false, false], "資料夾裡有沒有東西");
  await assert.rejects(inspectLocalDirs("not-a-list"), code("INVALID_INPUT"));
});

// ---- Checkout ----

test("Checkout 整個目錄：建立工作目錄、取回所有檔案（含子資料夾），回報版本與項目數", async () => {
  await resetPrefs();
  const parent = freshParent();
  const result = await checkoutToLocal({ connectionId: CONN, remotePath: "spec", parent: slash(parent), name: "spec", scope: "all", setSync: false });
  const target = path.join(parent, "spec");
  assert.equal(result.target, slash(target));
  assert.ok(result.revision > 0);
  assert.ok(result.itemCount >= 4, `應該至少有 3 個檔案加 1 個子資料夾，實際 ${result.itemCount}`);
  assert.equal(result.synced, false);
  for (const rel of ["a.md", "b.md", path.join("deep", "c.md")]) assert.ok(fs.existsSync(path.join(target, rel)), `${rel} 應該被取回`);
  assert.ok(fs.existsSync(path.join(target, ".svn")), "有 SVN 追蹤");
  assert.equal(svn("info", "--show-item", "url", target).trim(), `${repoUrl}/spec`);
  assert.deepEqual((await readRepoPrefs()).localPaths, {}, "沒勾「設為同步目錄」就不會寫進設定");
});

test("Checkout 只取這一層的檔案：不含子資料夾", async () => {
  const parent = freshParent();
  await checkoutToLocal({ connectionId: CONN, remotePath: "spec", parent: slash(parent), name: "spec-files", scope: "files", setSync: false });
  const target = path.join(parent, "spec-files");
  assert.ok(fs.existsSync(path.join(target, "a.md")));
  assert.equal(fs.existsSync(path.join(target, "deep")), false, "子資料夾不會被取回");
  assert.ok(fs.existsSync(path.join(target, ".svn")));
});

test("Checkout 只建立追蹤：不下載檔案，之後編輯到哪個檔案才取回哪個", async () => {
  await resetPrefs();
  const parent = freshParent();
  await checkoutToLocal({ connectionId: CONN, remotePath: "spec", parent: slash(parent), name: "spec-empty", scope: "empty", setSync: true });
  const target = path.join(parent, "spec-empty");
  assert.deepEqual(fs.readdirSync(target), [".svn"], "只有追蹤資料，沒有任何檔案");

  // 設為同步目錄之後，編輯上傳 spec/a.md 會只把這一個檔案取回本地
  await setSyncLocal(true);
  const session = await openEdit({ connectionId: CONN, path: "spec/a.md" });
  fs.writeFileSync(session.filePath, "a edited\n");
  const result = await commitEditAndSync(session.id, "改 a");
  assert.equal(result.localSync?.status, "updated", result.localSync?.message);
  assert.equal(fs.readFileSync(path.join(target, "a.md"), "utf-8"), "a edited\n");
  assert.equal(fs.existsSync(path.join(target, "b.md")), false, "沒動到的檔案不會被順便取回");
  await resetPrefs();
});

test("Checkout 整個專案（遠端路徑留空）與勾選「設為同步目錄」", async () => {
  await resetPrefs();
  const parent = freshParent();
  const result = await checkoutToLocal({ connectionId: CONN, remotePath: "", parent: slash(parent), name: "whole", scope: "all", setSync: true });
  assert.equal(result.synced, true);
  assert.ok(fs.existsSync(path.join(parent, "whole", "file-only.md")));
  assert.deepEqual((await readRepoPrefs()).localPaths.myrepo, [slash(path.join(parent, "whole"))]);
  await resetPrefs();
});

test("Checkout 保護：目標已有內容、已是工作目錄、在工作目錄裡面、同名檔案都拒絕，原有的檔案不受影響", async () => {
  const parent = freshParent();
  const full = path.join(parent, "has-stuff");
  fs.mkdirSync(full);
  fs.writeFileSync(path.join(full, "mine.txt"), "我的檔案");
  await assert.rejects(checkoutToLocal({ connectionId: CONN, remotePath: "spec", parent: slash(parent), name: "has-stuff", scope: "all", setSync: false }), code("ALREADY_EXISTS"));
  assert.equal(fs.readFileSync(path.join(full, "mine.txt"), "utf-8"), "我的檔案", "原有檔案完全沒動");
  assert.deepEqual(fs.readdirSync(full), ["mine.txt"]);

  fs.writeFileSync(path.join(parent, "same-name"), "x");
  await assert.rejects(checkoutToLocal({ connectionId: CONN, remotePath: "spec", parent: slash(parent), name: "same-name", scope: "all", setSync: false }), code("ALREADY_EXISTS"));

  const wcParent = path.join(root, "guard-wc");
  svn("checkout", `${repoUrl}/other`, wcParent);
  await assert.rejects(checkoutToLocal({ connectionId: CONN, remotePath: "spec", parent: slash(wcParent), name: "nested", scope: "all", setSync: false }), code("ALREADY_EXISTS"));
  assert.equal(fs.existsSync(path.join(wcParent, "nested")), false, "不會在工作目錄裡面再建一層");
  await assert.rejects(checkoutToLocal({ connectionId: CONN, remotePath: "spec", parent: slash(path.dirname(wcParent)), name: "guard-wc", scope: "all", setSync: false }), code("ALREADY_EXISTS"), "已經是工作目錄");
});

test("Checkout 可以放進空的既有資料夾", async () => {
  const parent = freshParent();
  fs.mkdirSync(path.join(parent, "empty-existing"));
  await checkoutToLocal({ connectionId: CONN, remotePath: "other", parent: slash(parent), name: "empty-existing", scope: "all", setSync: false });
  assert.ok(fs.existsSync(path.join(parent, "empty-existing", "o.md")));
});

test("Checkout 輸入檢查：資料夾名稱、位置、遠端不是資料夾或不存在；失敗不留殘渣", async () => {
  const parent = freshParent();
  const base = { connectionId: CONN, remotePath: "spec", parent: slash(parent), scope: "all", setSync: false };
  for (const bad of ["", "  ", "..", "a/b", "x:y", "bad|name", "trailing."]) {
    await assert.rejects(checkoutToLocal({ ...base, name: bad }), code("INVALID_INPUT"), `名稱應該被拒絕：${JSON.stringify(bad)}`);
  }
  await assert.rejects(checkoutToLocal({ ...base, parent: "", name: "x" }), code("INVALID_INPUT"));
  await assert.rejects(checkoutToLocal({ ...base, parent: slash(path.join(root, "no-such-parent")), name: "x" }), code("INVALID_INPUT"));
  await assert.rejects(checkoutToLocal({ ...base, remotePath: "file-only.md", name: "x" }), code("INVALID_INPUT"), "遠端是檔案不是資料夾");
  await assert.rejects(checkoutToLocal({ ...base, remotePath: "no/such/dir", name: "x" }), code("NOT_FOUND"));
  await assert.rejects(checkoutToLocal({ ...base, remotePath: "../escape", name: "x" }), code("INVALID_INPUT"));
  assert.deepEqual(fs.readdirSync(parent), [], "任何失敗都不會在位置底下留下資料夾");
});

// ---- 多個本地目錄的同步 ----

test("一個專案有多個本地目錄：挑對應位置包含這個檔案的那一個更新", async () => {
  await resetPrefs();
  const parent = freshParent();
  const specWc = path.join(parent, "spec-wc");
  const otherWc = path.join(parent, "other-wc");
  svn("checkout", `${repoUrl}/spec`, specWc);
  svn("checkout", `${repoUrl}/other`, otherWc);
  await addLocalPath("myrepo", slash(otherWc));
  await addLocalPath("myrepo", slash(specWc));
  await setSyncLocal(true);

  const session = await openEdit({ connectionId: CONN, path: "spec/b.md" });
  fs.writeFileSync(session.filePath, "b multi\n");
  const result = await commitEditAndSync(session.id, "改 b");
  assert.equal(result.localSync?.status, "updated", result.localSync?.message);
  assert.equal(fs.readFileSync(path.join(specWc, "b.md"), "utf-8"), "b multi\n");
  assert.equal(fs.readFileSync(path.join(otherWc, "o.md"), "utf-8"), "o\n", "另一個目錄不受影響");
  await resetPrefs();
});

test("多個本地目錄都對不上：警示會逐一列出每個目錄的原因", async () => {
  await resetPrefs();
  const parent = freshParent();
  const otherWc = path.join(parent, "other-wc");
  svn("checkout", `${repoUrl}/other`, otherWc);
  const plain = path.join(parent, "plain");
  fs.mkdirSync(plain);
  await addLocalPath("myrepo", slash(otherWc));
  await addLocalPath("myrepo", slash(plain));
  await addLocalPath("myrepo", slash(path.join(parent, "gone")));
  await setSyncLocal(true);

  const session = await openEdit({ connectionId: CONN, path: "spec/a.md" });
  fs.writeFileSync(session.filePath, "a again\n");
  const result = await commitEditAndSync(session.id, "改 a");
  assert.equal(result.localSync?.status, "warning");
  assert.match(result.localSync.message, /3 個本地目錄/);
  assert.match(result.localSync.message, /不包含/);
  assert.match(result.localSync.message, /沒有 SVN 追蹤/);
  assert.match(result.localSync.message, /目錄不存在/);
  assert.equal(svn("cat", `${repoUrl}/spec/a.md`), "a again\n", "遠端上傳仍然成功");
  await resetPrefs();
});

test("舊版設定（一個專案一個字串）會自動升級成清單", async () => {
  const { normalizePrefs } = await import("../dist/prefs-model.js");
  const prefs = normalizePrefs({ localPaths: { old: "D:/svn/old/", mixed: ["D:/a", "d:/A", "bad", 5], none: "relative" } });
  assert.deepEqual(prefs.localPaths, { old: ["D:/svn/old"], mixed: ["D:/a"] });
});
