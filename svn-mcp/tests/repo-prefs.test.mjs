// 「瀏覽 SVN 目錄」的個人偏好：星星（含排序）、最近開過、簡稱。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { markOpened, normalizeFolderPath, readRepoPrefs, reorderStars, setFolderNickname, setFolderStar, setNickname, setStar, MAX_FOLDERS_PER_REPO, MAX_NICKNAME_LENGTH, MAX_RECENT } from "../dist/repo-prefs.js";
import { ConnectionInputError } from "../dist/connections-store.js";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "svn-prefs-test-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** 每個測試用自己的單一設定檔（偏好是裡面的 prefs 區塊）。 */
function useFresh() {
  const file = path.join(root, `case${counter++}`, "info", "svn-connections.json");
  process.env.SVN_CONNECTIONS_FILE = file;
  return file;
}
const readPrefsFromFile = (file) => JSON.parse(fs.readFileSync(file, "utf-8")).prefs;
const writeProfileFile = (file, prefs) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 2, accounts: [], repoCache: {}, prefs }));
};

test("沒有設定檔：偏好全部是空的", async () => {
  useFresh();
  assert.deepEqual(await readRepoPrefs(), { starred: [], recent: {}, nicknames: {}, folders: {}, folderNicknames: {}, localPaths: {}, syncLocal: false });
});

test("星星：新加的排最後、重複加不移動位置、拿掉後其他順序不變；自動建立資料夾", async () => {
  const file = useFresh();
  await setStar("b", true);
  await setStar("a", true);
  await setStar("c", true);
  assert.deepEqual((await setStar("b", true)).starred, ["b", "a", "c"], "已經有星星再加一次不能移動");
  assert.deepEqual((await setStar("a", false)).starred, ["b", "c"]);
  assert.deepEqual((await setStar("zzz", false)).starred, ["b", "c"], "拿掉沒有的星星沒事");
  assert.deepEqual(readPrefsFromFile(file), { ...(await readRepoPrefs()) }, "寫進單一設定檔的 prefs 區塊");
  assert.deepEqual(readPrefsFromFile(file).starred, ["b", "c"]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["svn-connections.json"], "沒留下暫存檔或鎖");
});

test("拖曳排序：只能重排現有的星星，不能藉由排序加入新的；沒被提到的接在後面", async () => {
  useFresh();
  for (const n of ["a", "b", "c", "d"]) await setStar(n, true);
  assert.deepEqual((await reorderStars(["d", "b", "a", "c"])).starred, ["d", "b", "a", "c"]);
  assert.deepEqual((await reorderStars(["c", "不是星星", "c", "a"])).starred, ["c", "a", "d", "b"], "未知的與重複的忽略，沒提到的 d、b 維持相對順序接在後面");
  assert.deepEqual((await reorderStars([])).starred, ["c", "a", "d", "b"]);
});

test("最近開過：記錄時間、再開一次會更新；超過上限丟掉最舊的", async () => {
  useFresh();
  const first = (await markOpened("a")).recent.a;
  await new Promise((r) => setTimeout(r, 15));
  const again = (await markOpened("a")).recent.a;
  assert.ok(again > first, "再開一次要更新時間");

  const file = process.env.SVN_CONNECTIONS_FILE;
  const many = Object.fromEntries(Array.from({ length: MAX_RECENT }, (_, i) => [`old${i}`, new Date(2000, 0, 1, 0, 0, i).toISOString()]));
  writeProfileFile(file, { starred: [], recent: many, nicknames: {} });
  const { recent } = await markOpened("新的");
  assert.equal(Object.keys(recent).length, MAX_RECENT);
  assert.ok("新的" in recent);
  assert.equal("old0" in recent, false, "最舊的被丟掉");
});

test("簡稱：可設定、可改、空白代表清掉，過長拒絕；不影響星星與最近", async () => {
  useFresh();
  await setStar("a", true);
  await markOpened("a");
  assert.equal((await setNickname("a", "  電票  ")).nicknames.a, "電票", "前後空白會去掉");
  assert.equal((await setNickname("a", "發票")).nicknames.a, "發票");
  await assert.rejects(setNickname("a", "x".repeat(MAX_NICKNAME_LENGTH + 1)), (e) => e instanceof ConnectionInputError && /太長/.test(e.message));
  const cleared = await setNickname("a", "   ");
  assert.equal("a" in cleared.nicknames, false);
  assert.deepEqual(cleared.starred, ["a"]);
  assert.ok(cleared.recent.a);
});

test("不合法的專案名稱一律拒絕，且不動檔案", async () => {
  const file = useFresh();
  await setStar("a", true);
  const before = fs.readFileSync(file, "utf-8");
  for (const bad of ["", "   ", null, undefined, 123, {}, "x".repeat(201)]) {
    await assert.rejects(setStar(bad, true), ConnectionInputError, String(bad));
    await assert.rejects(markOpened(bad), ConnectionInputError);
    await assert.rejects(setNickname(bad, "x"), ConnectionInputError);
  }
  await assert.rejects(reorderStars("not-array"), ConnectionInputError);
  await assert.rejects(reorderStars(["a", 5]), ConnectionInputError);
  assert.equal(fs.readFileSync(file, "utf-8"), before);
});

test("設定檔壞掉：偏好讀成空的，但寫入絕不覆蓋壞掉的檔案；內容怪怪的會被整理掉", async () => {
  const file = useFresh();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ 壞掉");
  assert.deepEqual(await readRepoPrefs(), { starred: [], recent: {}, nicknames: {}, folders: {}, folderNicknames: {}, localPaths: {}, syncLocal: false });
  await assert.rejects(setStar("a", true), /不是合法的 JSON/);
  assert.equal(fs.readFileSync(file, "utf-8"), "{ 壞掉", "壞掉的檔案可能是人工改到一半的，不能被蓋掉");

  writeProfileFile(file, { starred: ["a", "a", 5, "", "b"], recent: { a: "2020", 7: 8, "": "x" }, nicknames: [1, 2] });
  assert.deepEqual(await readRepoPrefs(), { starred: ["a", "b"], recent: { a: "2020" }, nicknames: {}, folders: {}, folderNicknames: {}, localPaths: {}, syncLocal: false });
  assert.deepEqual((await setStar("c", true)).starred, ["a", "b", "c"]);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf-8")));
});

test("同時送出很多操作不會互相蓋掉", async () => {
  useFresh();
  await Promise.all(Array.from({ length: 20 }, (_, i) => setStar(`repo${i}`, true)));
  const prefs = await readRepoPrefs();
  assert.equal(prefs.starred.length, 20);
  assert.equal(new Set(prefs.starred).size, 20);
});

test("常用目錄：每個專案各自一份、新加的排最後、重複加不移動、拿掉到空就刪掉那個專案的項目", async () => {
  useFresh();
  await setFolderStar("規格庫", "3-SD/9-SOURCE", true);
  await setFolderStar("規格庫", "2-SA", true);
  await setFolderStar("別的專案", "docs", true);
  assert.deepEqual((await setFolderStar("規格庫", "3-SD/9-SOURCE", true)).folders["規格庫"], ["3-SD/9-SOURCE", "2-SA"], "已經有再加一次不能移動");
  const prefs = await readRepoPrefs();
  assert.deepEqual(prefs.folders, { 規格庫: ["3-SD/9-SOURCE", "2-SA"], 別的專案: ["docs"] }, "兩個專案互不影響");

  assert.deepEqual((await setFolderStar("規格庫", "3-SD/9-SOURCE", false)).folders["規格庫"], ["2-SA"]);
  assert.deepEqual((await setFolderStar("規格庫", "不存在的", false)).folders["規格庫"], ["2-SA"], "拿掉沒有的沒事");
  const emptied = await setFolderStar("別的專案", "docs", false);
  assert.equal("別的專案" in emptied.folders, false, "沒有常用目錄的專案不留空陣列");
  assert.deepEqual(emptied.starred, [], "不影響專案星星");
});

test("常用目錄：路徑會整理成 a/b/c；跳出專案、根目錄、不允許的字元、過長、過多都拒絕", async () => {
  assert.equal(normalizeFolderPath("  /a//b/./c/ "), "a/b/c");
  assert.equal(normalizeFolderPath("a" + String.fromCharCode(92) + "b"), "a/b", "反斜線視為斜線");
  for (const bad of ["", "   ", "/", ".", "a/../b", "a/b:c", "a/b?", "a/*", null, 5, "x".repeat(501)]) {
    assert.throws(() => normalizeFolderPath(bad), ConnectionInputError, String(bad));
  }
  const file = useFresh();
  await setFolderStar("p", "ok", true);
  const before = fs.readFileSync(file, "utf-8");
  await assert.rejects(setFolderStar("p", "../escape", true), ConnectionInputError);
  await assert.rejects(setFolderStar("", "ok", true), ConnectionInputError);
  assert.equal(fs.readFileSync(file, "utf-8"), before, "被拒絕就不能動檔案");

  for (let i = 1; i < MAX_FOLDERS_PER_REPO; i++) await setFolderStar("p", `d${i}`, true);
  assert.equal((await readRepoPrefs()).folders.p.length, MAX_FOLDERS_PER_REPO);
  await assert.rejects(setFolderStar("p", "one-too-many", true), (e) => e instanceof ConnectionInputError && /太多/.test(e.message));
});

test("常用目錄：偏好檔裡亂掉的內容會被整理掉", async () => {
  const file = useFresh();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeProfileFile(file, { folders: { 好: ["a", "a", "", 5, "b"], 壞: "不是陣列", 空: [], "": ["x"] } });
  assert.deepEqual((await readRepoPrefs()).folders, { 好: ["a", "b"] });
});

test("常用目錄暱稱：可設定、可改、空白清掉；每個專案各自；拿掉常用目錄時暱稱一起消失", async () => {
  useFresh();
  await setFolderStar("規格庫", "3-SD/9-SOURCE", true);
  await setFolderStar("規格庫", "2-SA", true);
  await setFolderStar("別的庫", "docs", true);
  assert.deepEqual((await setFolderNickname("規格庫", "3-SD/9-SOURCE", "  後端規格 ")).folderNicknames, { 規格庫: { "3-SD/9-SOURCE": "後端規格" } });
  await setFolderNickname("別的庫", "docs", "文件");
  const both = await setFolderNickname("規格庫", "2-SA", "分析");
  assert.deepEqual(both.folderNicknames, { 規格庫: { "3-SD/9-SOURCE": "後端規格", "2-SA": "分析" }, 別的庫: { docs: "文件" } });
  assert.deepEqual(both.folders["規格庫"], ["3-SD/9-SOURCE", "2-SA"], "取暱稱不能動順序");

  assert.equal((await setFolderNickname("規格庫", "2-SA", "")).folderNicknames["規格庫"]["2-SA"], undefined, "空白清掉");
  const removed = await setFolderStar("規格庫", "3-SD/9-SOURCE", false);
  assert.equal("規格庫" in removed.folderNicknames, false, "拿掉常用目錄，暱稱跟著消失，專案沒有暱稱了就不留空物件");
  assert.deepEqual(removed.folderNicknames, { 別的庫: { docs: "文件" } });
  const again = await setFolderStar("規格庫", "3-SD/9-SOURCE", true);
  assert.equal(again.folderNicknames["規格庫"], undefined, "重新加入時不會冒出舊暱稱");
});

test("常用目錄暱稱：只能替常用目錄取；過長、壞輸入拒絕且不動檔案", async () => {
  const file = useFresh();
  await setFolderStar("p", "a/b", true);
  const before = fs.readFileSync(file, "utf-8");
  await assert.rejects(setFolderNickname("p", "不是常用的", "x"), (e) => e instanceof ConnectionInputError && /先按/.test(e.message));
  await assert.rejects(setFolderNickname("p", "a/b", "x".repeat(MAX_NICKNAME_LENGTH + 1)), (e) => e instanceof ConnectionInputError && /太長/.test(e.message));
  await assert.rejects(setFolderNickname("", "a/b", "x"), ConnectionInputError);
  await assert.rejects(setFolderNickname("p", "../x", "x"), ConnectionInputError);
  assert.equal(fs.readFileSync(file, "utf-8"), before);
});

test("常用目錄暱稱：偏好檔裡沒有對應常用目錄的暱稱、空白或過長的會被整理掉", async () => {
  const file = useFresh();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeProfileFile(file, { folders: { p: ["a", "b"] }, folderNicknames: { p: { a: " 好 ", b: "", c: "孤兒", d: "x".repeat(31) }, q: { z: "沒有這個專案" }, r: "壞" } });
  assert.deepEqual((await readRepoPrefs()).folderNicknames, { p: { a: "好" } });
});
