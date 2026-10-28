// 大量檔案上傳（上萬個檔案）的穩定性與效率：分批規則、鎖定重試、遞迴比對、送出中的保護、平行複製。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createSvnFixture } from "./helpers/svn-fixture.mjs";
import { chunkByLength, commitImport, cancelImport, planImport, stageImportFile, startImportBatch, withDbLockRetry } from "../dist/remote-import-batch.js";
import { EditError } from "../dist/remote-edit-client.js";

const { svn, seed, repoUrl, root } = createSvnFixture({ prefix: "svn-batch-large-", noLaunch: true });
const svnRepoUrl = () => repoUrl;
let seedCounter = 0;
/** 用一個 commit 準備好遠端的多個檔案（{ 相對路徑: 內容 }）；逐檔 commit 太慢，尤其是寫入儲存庫很慢的機器。 */
function seedMany(files) {
  const wc = path.join(root, `seed-many-${seedCounter++}`);
  svn("checkout", repoUrl, wc);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(wc, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  svn("add", "--force", "--depth", "infinity", wc);
  svn("commit", "-m", "seed", wc);
}
// 這台電腦的 svn 文字輸出是 Big5，中文檔名會變亂碼；--xml 一律是 UTF-8
const remoteFiles = (dir) => {
  const xml = svn("list", "-R", "--xml", `${repoUrl}/${encodeURI(dir)}`);
  return [...xml.matchAll(/<entry\s+kind="file">\s*<name>([^<]*)<\/name>/g)].map((m) => m[1]).sort();
};
// 設了 svn:eol-style=native 的檔案，svn cat 會轉成本機換行（CRLF）；比對內容前先統一成 LF
const catRemote = (rel) => svn("cat", `${repoUrl}/${encodeURI(rel)}`).replace(/\r\n/g, "\n");

async function stage(batch, count, dirs, { prefix = "d", content = (i) => `內容 ${i}\n` } = {}) {
  for (let i = 0; i < count; i++) await stageImportFile(batch, `${prefix}${i % dirs}/檔案${i}.md`, Buffer.from(content(i)));
}

async function assertEditError(promise, code, pattern) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof EditError, `應該是 EditError，實際：${e?.constructor?.name}：${e?.message}`);
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

// ---- 純函式 ----

test("chunkByLength：依總長度與數量切批，順序與內容不變、不遺漏", () => {
  const items = Array.from({ length: 1000 }, (_, i) => `C:\\很長的路徑\\批次\\wc\\資料夾${i}\\檔案名稱${i}.md`);
  const groups = chunkByLength(items, 2000, 50);
  assert.deepEqual(groups.flat(), items, "攤平後跟原本一模一樣");
  for (const g of groups) {
    assert.ok(g.length <= 50, "不超過數量上限");
    assert.ok(g.reduce((sum, p) => sum + p.length + 3, 0) <= 2000 || g.length === 1, "不超過長度上限");
  }
  assert.ok(groups.length > 1);
  assert.deepEqual(chunkByLength([]), []);
  assert.deepEqual(chunkByLength(["x".repeat(30_000)]), [["x".repeat(30_000)]], "單一路徑就算超長也自己一批，不會被丟掉");
  // 預設值：六萬個檔案不會變成上千次 svn 呼叫（以前固定 40 個一批 = 1500 次）
  const many = Array.from({ length: 60000 }, (_, i) => `C:\\Users\\x\\logs\\batch-0000\\wc\\src\\module${i % 300}\\File${i}.java`);
  const calls = chunkByLength(many).length;
  assert.ok(calls < 600, `預設分批後 ${calls} 次（舊的固定 40 個一批要 1500 次）`);
});

test("withDbLockRetry：資料庫被鎖住就等一下重試，成功就回傳；重試用完仍鎖住照實丟出；其他錯誤不重試", async () => {
  let attempts = 0;
  const lockError = () => new Error("svn: E200033: Another process is blocking the working copy database\nsvn: E200033: sqlite[S5]: database is locked");
  assert.equal(await withDbLockRetry(async () => { attempts++; if (attempts < 3) throw lockError(); return "ok"; }, [0, 0, 0]), "ok");
  assert.equal(attempts, 3, "鎖了兩次，第三次成功");

  attempts = 0;
  await assert.rejects(withDbLockRetry(async () => { attempts++; throw lockError(); }, [0, 0]), /database is locked/);
  assert.equal(attempts, 3, "第一次加兩次重試，之後照實丟出");

  attempts = 0;
  await assert.rejects(withDbLockRetry(async () => { attempts++; throw new Error("svn: E170013: Unable to connect"); }, [0, 0, 0]), /E170013/);
  assert.equal(attempts, 1, "不是鎖定的錯誤，一次就丟出，不白等");
});

// ---- 收檔 ----

test("收檔寫入失敗（路徑跟已存在的檔案衝突）：不會留下『其實不存在的檔案』，之後預覽與送出不受影響", async () => {
  const { batch } = await startImportBatch();
  await stageImportFile(batch, "x", Buffer.from("我是檔案\n"));
  await assert.rejects(stageImportFile(batch, "x/y.md", Buffer.from("要放進 x 底下\n")));
  await stageImportFile(batch, "ok/a.md", Buffer.from("a\n"));
  const plan = await planImport({ batch, connectionId: "t1", targetDir: "stage-fail" });
  assert.deepEqual([...plan.add].sort(), ["ok/a.md", "x"], "只有真的收到的兩個檔案");
  await cancelImport(batch);
});

// ---- 比對遠端：遞迴列出 vs 逐層列出 ----

test("資料夾很多時一次遞迴列出遠端，結果跟逐層列出完全一樣（新增、覆蓋、遠端不存在的資料夾）", async () => {
  // 遠端已有：base/d0..d11 各幾個檔案，以及 base/other/ 一個不相干的資料夾
  seedMany({
    ...Object.fromEntries(Array.from({ length: 12 }, (_, d) => [`base/d${d}/檔案${d}.md`, `遠端原本 ${d}\n`])),
    "base/other/not-mine.md": "別人的\n",
  });
  const batch1 = (await startImportBatch()).batch;
  // 要上傳：d0..d11 各兩個（其中 檔案{d}.md 會覆蓋遠端）、d12..d14（遠端不存在的資料夾）、深一層 d3/sub/x.md（sub 不存在）
  for (let d = 0; d < 15; d++) {
    await stageImportFile(batch1, `d${d}/檔案${d}.md`, Buffer.from(`新內容 ${d}\n`));
    await stageImportFile(batch1, `d${d}/新增${d}.md`, Buffer.from(`新增 ${d}\n`));
  }
  await stageImportFile(batch1, "d3/sub/x.md", Buffer.from("深層\n"));

  process.env.SVN_EDIT_RECURSIVE_LIST_MIN_DIRS = "100000"; // 強制逐層
  const oneByOne = await planImport({ batch: batch1, connectionId: "t1", targetDir: "base" });
  process.env.SVN_EDIT_RECURSIVE_LIST_MIN_DIRS = "0"; // 強制遞迴
  const recursive = await planImport({ batch: batch1, connectionId: "t1", targetDir: "base" });
  delete process.env.SVN_EDIT_RECURSIVE_LIST_MIN_DIRS;

  const normalize = (p) => ({ add: [...p.add].sort(), overwrite: [...p.overwrite].sort(), details: p.overwriteDetails.map((d) => [d.path, d.remoteRevision, d.remoteAuthor]).sort() });
  assert.deepEqual(normalize(recursive), normalize(oneByOne), "兩種做法的預覽結果必須一致");
  assert.equal(recursive.overwrite.length, 12, "d0..d11 的 檔案N.md 會覆蓋");
  assert.equal(recursive.add.length, 15 * 2 - 12 + 1, "其餘新增（含遠端不存在的資料夾與深層檔案）");
  assert.ok(recursive.add.includes("d3/sub/x.md"));
  assert.ok(recursive.overwriteDetails.every((d) => d.remoteRevision !== null), "覆蓋的檔案都帶著遠端的版本資訊");
  await cancelImport(batch1);
});

test("上傳到連線根目錄時不用遞迴列出（整個專案庫列一遍太大），照樣能正確比對", async () => {
  seed("rootfile-a/keep.md", "a\n");
  const { batch } = await startImportBatch();
  for (let d = 0; d < 5; d++) await stageImportFile(batch, `rootfile-${"abcde"[d]}/n${d}.md`, Buffer.from(`n${d}\n`));
  process.env.SVN_EDIT_RECURSIVE_LIST_MIN_DIRS = "0";
  const plan = await planImport({ batch, connectionId: "t1", targetDir: "" });
  delete process.env.SVN_EDIT_RECURSIVE_LIST_MIN_DIRS;
  assert.equal(plan.add.length, 5);
  assert.equal(plan.overwrite.length, 0);
  await cancelImport(batch);
});

// ---- 大量檔案實際上傳（平行複製、分批 svn add／propset）----

test("上傳 120 個檔案（含覆蓋、含中文檔名、md 檔設換行屬性）：內容全部正確、只有一個 commit", async () => {
  seedMany(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`bulk/d${i}/檔案${i}.md`, `遠端舊內容 ${i}\n`])));
  const before = Number(/(\d+)/.exec(svn("info", "--show-item", "revision", svnRepoUrl()))[1]);
  const { batch } = await startImportBatch();
  await stage(batch, 120, 10, { prefix: "d", content: (i) => `第 ${i} 份的新內容\n` });
  const plan = await planImport({ batch, connectionId: "t1", targetDir: "bulk" });
  assert.equal(plan.totalFiles, 120);
  assert.equal(plan.overwrite.length, 10, "d0..d9 底下 檔案0..9 剛好跟遠端同名");
  const result = await commitImport({ batch, connectionId: "t1", targetDir: "bulk", message: "大量上傳測試" });
  assert.equal(result.added, 110);
  assert.equal(result.modified, 10);
  const after = Number(/(\d+)/.exec(svn("info", "--show-item", "revision", svnRepoUrl()))[1]);
  assert.equal(after, before + 1, "整批只產生一個 commit");
  assert.equal(remoteFiles("bulk").length, 120);
  for (const i of [0, 7, 9, 10, 63, 119]) assert.equal(catRemote(`bulk/d${i % 10}/檔案${i}.md`), `第 ${i} 份的新內容\n`, `第 ${i} 個檔案內容`);
  assert.match(svn("proplist", "-v", `${svnRepoUrl()}/${encodeURI("bulk/d5/檔案25.md")}`), /svn:eol-style/, "新增的 md 有設換行屬性");
});

// ---- 送出中的保護 ----

test("送出中：同一批再按一次送出、或按取消，都被擋下（不會把正在使用的工作副本刪掉）；第一個照常完成", async () => {
  const { batch } = await startImportBatch();
  await stage(batch, 40, 4, { prefix: "g" });
  const first = commitImport({ batch, connectionId: "t1", targetDir: "guard", message: "第一次送出" });
  await new Promise((resolve) => setTimeout(resolve, 80)); // 讓第一個進入送出階段
  await assertEditError(commitImport({ batch, connectionId: "t1", targetDir: "guard", message: "重複送出" }), "ALREADY_EDITING", /已經在送出中/);
  await assertEditError(cancelImport(batch), "ALREADY_EDITING", /不能取消/);
  const result = await first;
  assert.equal(result.added, 40);
  assert.equal(remoteFiles("guard").length, 40, "第一次送出完整成功，沒有被後面的操作破壞");
  // 完成之後，這個批次已經清掉，再取消也不會出事
  await cancelImport(batch);
});
