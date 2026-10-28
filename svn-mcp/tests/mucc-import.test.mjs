// 批次上傳的快速路徑（svnmucc，不建立工作副本）：純函式、系統內碼頁編碼、與實際上傳（本機臨時 SVN 儲存庫）。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createSvnFixture } from "./helpers/svn-fixture.mjs";
import { buildEncoder, buildMuccArgsFile, findSvnmucc, isAscii, MuccUnavailableError, percentEncodePath, prepareNativeEol, systemMessageEncoder } from "../dist/mucc-import.js";
import { cancelImport, commitImport, planImport, stageImportFile, startImportBatch } from "../dist/remote-import-batch.js";

// ---- 純函式 ----

test("percentEncodePath：每一段做百分比編碼，結果純 ASCII，解回來跟原本一樣", () => {
  const rel = "資料夾 一/檔案 (1)+#.md";
  const encoded = percentEncodePath(rel);
  assert.ok(isAscii(encoded), encoded);
  assert.equal(encoded.split("/").length, 2, "路徑分隔符號維持不動");
  assert.equal(encoded.split("/").map(decodeURIComponent).join("/"), rel);
  assert.equal(percentEncodePath("a/b.txt"), "a/b.txt", "純英數不變");
});

test("buildMuccArgsFile：資料夾先建（由呼叫端給的順序）、檔案後放、屬性接在對應的檔案後面；全部純 ASCII", () => {
  const text = buildMuccArgsFile(
    ["專案", "專案/子層"],
    [
      { remoteRel: "專案/子層/規格.docx", localPath: "C:/tmp/b/f0", props: [["svn:needs-lock", "*"]] },
      { remoteRel: "專案/說明.md", localPath: "C:/tmp/b/f1", props: [["svn:eol-style", "native"]] },
      { remoteRel: "專案/plain.bin", localPath: "C:/tmp/b/f2", props: [] },
    ]
  );
  assert.ok(isAscii(text));
  const lines = text.trimEnd().split("\n");
  assert.deepEqual(lines.slice(0, 4), ["mkdir", percentEncodePath("專案"), "mkdir", percentEncodePath("專案/子層")]);
  const iDocx = lines.indexOf("C:/tmp/b/f0");
  assert.deepEqual(lines.slice(iDocx - 1, iDocx + 6), ["put", "C:/tmp/b/f0", percentEncodePath("專案/子層/規格.docx"), "propset", "svn:needs-lock", "*", percentEncodePath("專案/子層/規格.docx")]);
  assert.equal(lines.filter((l) => l === "put").length, 3);
  assert.equal(lines.filter((l) => l === "propset").length, 2, "沒有屬性的檔案不會多出 propset");
  assert.throws(() => buildMuccArgsFile([], [{ remoteRel: "a.md", localPath: "C:/中文/f0", props: [] }]), MuccUnavailableError);
});

test("prepareNativeEol：只有 LF 或沒有換行＝設屬性；只有 CRLF＝轉成 LF 並設屬性；混用、單獨 CR、含 NUL＝不設屬性且內容不動", () => {
  const b = (s) => Buffer.from(s, "latin1");
  assert.deepEqual([prepareNativeEol(b("a\nb\n")).content.toString("latin1"), prepareNativeEol(b("a\nb\n")).setProp], ["a\nb\n", true]);
  assert.deepEqual([prepareNativeEol(b("no newline")).content.toString("latin1"), prepareNativeEol(b("no newline")).setProp], ["no newline", true]);
  assert.deepEqual([prepareNativeEol(b("a\r\nb\r\n")).content.toString("latin1"), prepareNativeEol(b("a\r\nb\r\n")).setProp], ["a\nb\n", true]);
  for (const mixed of ["a\r\nb\nc\n", "a\rb\r", "a\nb\r"]) {
    const r = prepareNativeEol(b(mixed));
    assert.equal(r.setProp, false, JSON.stringify(mixed));
    assert.equal(r.content.toString("latin1"), mixed, "內容不動");
  }
  const nul = Buffer.from([0x61, 0x00, 0x0a]);
  assert.deepEqual([prepareNativeEol(nul).setProp, prepareNativeEol(nul).content.equals(nul)], [false, true]);
  assert.deepEqual([prepareNativeEol(Buffer.alloc(0)).setProp, prepareNativeEol(Buffer.alloc(0)).content.length], [true, 0]);
});

test("buildEncoder：Big5／GBK／單位元組內碼頁都能編碼、解回來一致；表示不了的字元（表情符號）會列出來", () => {
  const big5 = buildEncoder("big5");
  const msg = "[PROJ-1234] 上傳規格書：中文說明（含全形標點）";
  const r = big5(msg);
  assert.deepEqual(r.unsupported, []);
  assert.equal(new TextDecoder("big5").decode(r.bytes), msg);
  assert.deepEqual(big5("ok 🙂 好").unsupported, ["🙂"]);
  assert.ok(big5("ASCII only 123").bytes.equals(Buffer.from("ASCII only 123", "latin1")), "英數字不變");

  const gbk = buildEncoder("gbk");
  const simplified = "简体中文说明";
  assert.deepEqual(gbk(simplified).unsupported, []);
  assert.equal(new TextDecoder("gbk").decode(gbk(simplified).bytes), simplified);

  const latin = buildEncoder("windows-1252");
  assert.equal(new TextDecoder("windows-1252").decode(latin("café").bytes), "café");
  assert.deepEqual(latin("中").unsupported, ["中"], "這個內碼頁沒有的字元會列出來（呼叫端就退回別的做法）");
});

test("systemMessageEncoder：這台電腦的系統內碼頁有支援時，英數說明原樣編碼；讀不到內碼頁就回 null（呼叫端退回別的做法）", () => {
  const encoder = systemMessageEncoder();
  if (!encoder) return; // 不支援的內碼頁：呼叫端會退回工作副本，這裡沒有東西好驗證
  const r = encoder("plain ascii message");
  assert.deepEqual(r.unsupported, []);
  assert.equal(r.bytes.toString("latin1"), "plain ascii message");
});

test("findSvnmucc：SVN_EDIT_DISABLE_MUCC=1 就關閉；SVN_EDIT_MUCC_PATH 指到不存在的檔案＝找不到，指到存在的檔案＝用它", () => {
  const saved = { off: process.env.SVN_EDIT_DISABLE_MUCC, path: process.env.SVN_EDIT_MUCC_PATH };
  try {
    delete process.env.SVN_EDIT_MUCC_PATH;
    process.env.SVN_EDIT_DISABLE_MUCC = "1";
    assert.equal(findSvnmucc(), null);
    delete process.env.SVN_EDIT_DISABLE_MUCC;
    process.env.SVN_EDIT_MUCC_PATH = path.join(process.cwd(), "definitely-not-here", "svnmucc.exe");
    assert.equal(findSvnmucc(), null);
    process.env.SVN_EDIT_MUCC_PATH = process.execPath;
    assert.equal(findSvnmucc(), process.execPath);
  } finally {
    for (const [k, v] of [["SVN_EDIT_DISABLE_MUCC", saved.off], ["SVN_EDIT_MUCC_PATH", saved.path]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---- 實際上傳（需要 svnmucc；找不到就跳過）----

const canRun = findSvnmucc() !== null && systemMessageEncoder() !== null;
const itest = (name, fn) => test(name, { skip: canRun ? false : "這台電腦沒有 svnmucc 或不支援系統內碼頁" }, fn);

const { repoDir, repoUrl, svn, seed } = createSvnFixture({ prefix: "svn-mucc-test-", noLaunch: true });
const head = () => Number(/(\d+)/.exec(svn("info", "--show-item", "revision", repoUrl))[1]);
const enc = (rel) => rel.split("/").map(encodeURIComponent).join("/");
// 這台電腦的 svn 文字輸出是系統內碼頁，中文會變亂碼；--xml 一律是 UTF-8
const listFiles = (dir) => [...svn("list", "-R", "--xml", `${repoUrl}/${enc(dir)}`).matchAll(/<entry\s+kind="file">\s*<name>([^<]*)<\/name>/g)].map((m) => m[1]).sort();
const listDirs = (dir) => [...svn("list", "-R", "--xml", `${repoUrl}/${enc(dir)}`).matchAll(/<entry\s+kind="dir">\s*<name>([^<]*)<\/name>/g)].map((m) => m[1]).sort();
const logMessage = (rev) => (/<msg>([\s\S]*?)<\/msg>/.exec(svn("log", "--xml", "-r", String(rev), repoUrl)) || [])[1];
const propsOf = (rel) => svn("proplist", `${repoUrl}/${enc(rel)}`).replace(/\s+/g, " ").trim();
const raw = (rel) => execFileSync("svnlook", ["cat", repoDir, rel]); // 儲存庫裡「原始」的內容（svn cat 會依換行屬性轉成本機換行）

async function upload(files, targetDir, message) {
  const { batch } = await startImportBatch();
  for (const [rel, content] of Object.entries(files)) await stageImportFile(batch, rel, Buffer.isBuffer(content) ? content : Buffer.from(content));
  const plan = await planImport({ batch, connectionId: "t1", targetDir });
  const result = await commitImport({ batch, connectionId: "t1", targetDir, message });
  return { plan, result };
}

itest("全部都是新檔案：用 svnmucc 一次送出（只有一個 commit）；中文檔名與資料夾、中文提交說明、屬性、換行都正確", async () => {
  const before = head();
  const message = "[PROJ-1234] 上傳整包規格：中文說明（含全形標點）";
  const { plan, result } = await upload(
    {
      "規格/需求 規格.md": "# 需求\n第二行\n",
      "規格/子層/CRLF.md": "line1\r\nline2\r\n",
      "規格/子層/mixed.md": "a\r\nb\nc\n",
      "規格/子層/規格書.docx": "fake docx bytes",
      "規格/子層/notes.txt": "plain\n",
      "規格/sheet.xlsx": "fake xlsx",
    },
    "新上傳",
    message
  );
  assert.equal(plan.overwrite.length, 0);
  assert.equal(result.method, "mucc", "全部是新檔案要走快速路徑");
  assert.equal(result.added, 6);
  assert.equal(head(), before + 1, "整批只產生一個 commit");
  assert.deepEqual(listFiles("新上傳"), ["規格/sheet.xlsx", "規格/子層/CRLF.md", "規格/子層/notes.txt", "規格/子層/mixed.md", "規格/子層/規格書.docx", "規格/需求 規格.md"].sort());
  assert.deepEqual(listDirs("新上傳"), ["規格", "規格/子層"]);
  assert.equal(logMessage(head()), message, "中文提交說明完整還原（沒有變亂碼）");
  assert.match(propsOf("新上傳/規格/子層/規格書.docx"), /svn:needs-lock/);
  assert.match(propsOf("新上傳/規格/sheet.xlsx"), /svn:needs-lock/);
  assert.match(propsOf("新上傳/規格/需求 規格.md"), /svn:eol-style/);
  assert.match(propsOf("新上傳/規格/子層/notes.txt"), /svn:eol-style/);
  assert.match(propsOf("新上傳/規格/子層/CRLF.md"), /svn:eol-style/);
  assert.doesNotMatch(propsOf("新上傳/規格/子層/mixed.md"), /svn:eol-style/, "換行混用的檔案不設換行屬性（SVN 本來也會拒絕）");
  // 儲存庫裡的原始內容：CRLF 已轉成 LF（跟工作副本 commit 的行為一致）；混用的檔案內容不動
  const crlfRaw = execFileSync("svnlook", ["cat", repoDir, "新上傳/規格/子層/CRLF.md"]).toString("latin1");
  assert.equal(crlfRaw, "line1\nline2\n");
  assert.equal(execFileSync("svnlook", ["cat", repoDir, "新上傳/規格/子層/mixed.md"]).toString("latin1"), "a\r\nb\nc\n");
  assert.equal(execFileSync("svnlook", ["cat", repoDir, "新上傳/規格/子層/規格書.docx"]).toString("latin1"), "fake docx bytes");
});

itest("放進已經存在的資料夾底下的新資料夾（中間層已存在、葉層不存在、跟全新的資料夾混在一起）：逐層比對與一次遞迴列出，結果一樣", async () => {
  seed("existing/d1/keep.md", "遠端原有\n");
  seed("existing/d2/keep.md", "遠端原有\n");
  for (const threshold of ["100000", "0"]) {
    process.env.SVN_EDIT_RECURSIVE_LIST_MIN_DIRS = threshold; // 100000＝強制逐層；0＝強制遞迴
    try {
      const sub = `new-${threshold}`;
      const before = head();
      const { result } = await upload(
        { [`d1/${sub}/a.md`]: "a\n", [`d1/${sub}/deeper/b.md`]: "b\n", [`d2/c-${threshold}.md`]: "c\n", [`d3-全新/${sub}/e.md`]: "e\n" },
        "existing",
        `快速路徑 ${threshold}`
      );
      assert.equal(result.method, "mucc", `門檻 ${threshold}`);
      assert.equal(head(), before + 1);
      assert.deepEqual(
        listFiles("existing").filter((f) => f.includes(sub) || f === `d2/c-${threshold}.md`),
        [`d1/${sub}/a.md`, `d1/${sub}/deeper/b.md`, `d2/c-${threshold}.md`, `d3-全新/${sub}/e.md`].sort(),
        `門檻 ${threshold}：每個檔案都放在正確的位置`
      );
      assert.ok(listFiles("existing").includes("d1/keep.md"), "遠端原有的檔案沒有被動到");
    } finally {
      delete process.env.SVN_EDIT_RECURSIVE_LIST_MIN_DIRS;
    }
  }
});

itest("有要覆蓋的檔案、又放進「已存在但沒有直接放檔案」的中間層底下的新資料夾：工作副本路徑也要成功（以前會報 d1 已存在而失敗）", async () => {
  seed("wcfix/a/b/keep.md", "舊內容\n"); // a 與 a/b 已存在；a 這一層沒有直接放檔案
  const before = head();
  const { plan, result } = await upload({ "a/b/keep.md": "覆蓋\n", "a/newdir/x.md": "x\n", "a/b/newer/y.md": "y\n" }, "wcfix", "覆蓋加新增");
  assert.equal(plan.overwrite.length, 1);
  assert.equal(result.method, "wc", "有要覆蓋的檔案，走工作副本");
  assert.equal(head(), before + 1);
  assert.deepEqual(listFiles("wcfix"), ["a/b/keep.md", "a/b/newer/y.md", "a/newdir/x.md"]);
});

itest("不適用快速路徑時退回工作副本：有要覆蓋的檔案、SVN_EDIT_DISABLE_MUCC=1、說明含系統內碼頁表示不了的字元（表情符號）；結果跟快速路徑一樣正確", async () => {
  seed("fb/exists.md", "舊內容\n");
  // 1. 有要覆蓋的檔案
  let r = await upload({ "exists.md": "新內容\n", "extra.md": "新增\n" }, "fb", "覆蓋與新增");
  assert.equal(r.result.method, "wc");
  assert.equal(r.result.modified, 1);
  assert.equal(r.result.added, 1);
  assert.equal(logMessage(head()), "覆蓋與新增");
  // 2. 關閉快速路徑
  process.env.SVN_EDIT_DISABLE_MUCC = "1";
  try {
    r = await upload({ "off/x.md": "x\n" }, "fb", "關閉快速路徑");
    assert.equal(r.result.method, "wc");
  } finally {
    delete process.env.SVN_EDIT_DISABLE_MUCC;
  }
  assert.deepEqual(listFiles("fb").filter((f) => f.startsWith("off/")), ["off/x.md"]);
  // 3. 說明有表情符號：改用工作副本（UTF-8 說明檔），說明仍然完整
  r = await upload({ "emoji/y.md": "y\n" }, "fb", "上傳完成 🙂 好");
  assert.equal(r.result.method, "wc", "系統內碼頁寫不出表情符號，不能走 svnmucc（會存成亂碼）");
  assert.equal(logMessage(head()), "上傳完成 🙂 好");
  // 4. svnmucc 找不到（路徑指到不存在的檔案）
  process.env.SVN_EDIT_MUCC_PATH = path.join(process.cwd(), "no-such-dir", "svnmucc.exe");
  try {
    r = await upload({ "nomucc/z.md": "z\n" }, "fb", "找不到 svnmucc");
    assert.equal(r.result.method, "wc");
  } finally {
    delete process.env.SVN_EDIT_MUCC_PATH;
  }
  assert.ok(listFiles("fb").includes("nomucc/z.md"));
});

itest("svnmucc 執行失敗（例如遠端已經有同名資料夾被別人建了）：錯誤原樣回報、暫存檔保留可以重試，不會留下半套資料", async () => {
  const { batch } = await startImportBatch();
  await stageImportFile(batch, "race/a.md", Buffer.from("a\n"));
  // 比對遠端之後、送出之前，別人把同一個路徑建成「檔案」：commit 一開始會重新比對，所以要在比對完成後才破壞；
  // 這裡改成直接讓 svnmucc 看到衝突：先把 target 建成一個「檔案」，目標資料夾變成不合法
  seed("blocked", "我是檔案，不是資料夾\n");
  await assert.rejects(commitImport({ batch, connectionId: "t1", targetDir: "blocked", message: "會失敗" }));
  // 失敗之後暫存檔還在，修正問題（換一個目標）可以直接重試
  const result = await commitImport({ batch, connectionId: "t1", targetDir: "after-fail", message: "換目標重試" });
  assert.equal(result.method, "mucc");
  assert.deepEqual(listFiles("after-fail"), ["race/a.md"]);
  await cancelImport(batch).catch(() => undefined);
});
