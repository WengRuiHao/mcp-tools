// 「移動遠端檔案／資料夾」：遠端 svn move 到另一個資料夾，全有或全無、不蓋掉同名檔案、不動編輯中或被鎖定的項目。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createSvnFixture } from "./helpers/svn-fixture.mjs";
import { EditError, openEdit, discardEdit } from "../dist/remote-edit-client.js";
import { addLocalPath, readRepoPrefs, removeLocalPath, setSyncLocal } from "../dist/repo-prefs.js";
import { moveRemoteFiles, moveRemoteFilesAndSync } from "../dist/remote-move.js";

const { repoUrl, root, svn, seed, checkoutLocal } = createSvnFixture({ prefix: "svn-move-test-", v2: true });
const CONN = "s1:myrepo";
/** 設定開關與這個專案的本地目錄（先清掉舊的再加上）。 */
async function configure({ sync, localPath }) {
  await setSyncLocal(sync);
  for (const existing of (await readRepoPrefs()).localPaths.myrepo ?? []) await removeLocalPath("myrepo", existing);
  for (const dir of [].concat(localPath || [])) await addLocalPath("myrepo", dir);
}
// 這台電腦的 svn 文字輸出是 Big5，中文檔名會變亂碼；--xml 一律是 UTF-8
const list = (rel) => [...svn("list", "--xml", `${repoUrl}/${encodeURI(rel)}`.replace(/\/$/, "")).matchAll(/<name>([^<]*)<\/name>/g)].map((m) => m[1]).sort();
const head = () => Number(/(\d+)/.exec(svn("info", "--show-item", "revision", repoUrl))[1]);

async function assertEditError(promise, code, pattern) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof EditError, `應該是 EditError，實際：${e?.constructor?.name}：${e?.message}`);
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

test("移動單一檔案：一個新 revision，舊位置消失、新位置出現，歷史保留", async () => {
  seed("m1/src/規格.md", "內容");
  seed("m1/dst/別的.md", "別的");
  const before = head();
  const r = await moveRemoteFiles({ connectionId: CONN, paths: ["m1/src/規格.md"], targetDir: "m1/dst", message: "整理規格" });
  assert.equal(r.movedRevision, before + 1);
  assert.deepEqual(r.moved, [{ from: "m1/src/規格.md", to: "m1/dst/規格.md" }]);
  assert.equal(head(), before + 1, "只產生一個 revision");
  assert.deepEqual(list("m1/dst"), ["別的.md", "規格.md"]);
  assert.deepEqual(list("m1/src"), []);
  assert.match(svn("log", "-v", "--xml", "-r", "HEAD", repoUrl), /copyfrom-path/, "svn move 保留歷史（有 copyfrom）");
});

test("一次移動多個檔案與資料夾（資料夾連同底下內容），只產生一個 revision", async () => {
  seed("m2/a.md", "a");
  seed("m2/b.md", "b");
  seed("m2/folder/inner.md", "inner");
  seed("m2/target/keep.md", "keep");
  const before = head();
  const r = await moveRemoteFiles({ connectionId: CONN, paths: ["m2/a.md", "m2/folder", "m2/b.md"], targetDir: "m2/target", message: "批次移動" });
  assert.equal(head(), before + 1);
  assert.equal(r.moved.length, 3);
  assert.deepEqual(list("m2/target"), ["a.md", "b.md", "folder", "keep.md"]);
  assert.deepEqual(list("m2/target/folder"), ["inner.md"]);
  assert.deepEqual(list("m2"), ["target"]);
});

test("移到連線根目錄（targetDir 空字串）", async () => {
  seed("m3/deep/root-me.md", "x");
  const r = await moveRemoteFiles({ connectionId: CONN, paths: ["m3/deep/root-me.md"], targetDir: "", message: "移到根目錄" });
  assert.deepEqual(r.moved, [{ from: "m3/deep/root-me.md", to: "root-me.md" }]);
  assert.ok(list("").includes("root-me.md"));
});

test("目標已有同名項目（不分大小寫）：整批拒絕，什麼都不動、不蓋掉別人的檔案", async () => {
  seed("m4/src/one.md", "one");
  seed("m4/src/dup.md", "from-src");
  seed("m4/dst/DUP.md", "keep-me");
  const before = head();
  await assertEditError(
    moveRemoteFiles({ connectionId: CONN, paths: ["m4/src/one.md", "m4/src/dup.md"], targetDir: "m4/dst", message: "x" }),
    "ALREADY_EXISTS",
    /已經有「dup\.md」/,
  );
  assert.equal(head(), before, "沒有產生新 revision");
  assert.deepEqual(list("m4/src"), ["dup.md", "one.md"], "來源原封不動（全有或全無）");
  assert.equal(svn("cat", `${repoUrl}/m4/dst/DUP.md`), "keep-me");
});

test("不能把資料夾移到它自己或子孫裡；項目本來就在目標資料夾也算錯誤", async () => {
  seed("m5/parent/child/f.md", "f");
  await assertEditError(moveRemoteFiles({ connectionId: CONN, paths: ["m5/parent"], targetDir: "m5/parent/child", message: "x" }), "INVALID_INPUT", /自己或它的子資料夾/);
  await assertEditError(moveRemoteFiles({ connectionId: CONN, paths: ["m5/parent"], targetDir: "m5/parent", message: "x" }), "INVALID_INPUT", /自己或它的子資料夾/);
  await assertEditError(moveRemoteFiles({ connectionId: CONN, paths: ["m5/parent/child/f.md"], targetDir: "m5/parent/child", message: "x" }), "INVALID_INPUT", /本來就在/);
});

test("目標資料夾不存在（或是檔案）：拒絕，不會自動建立", async () => {
  seed("m6/a.md", "a");
  const before = head();
  await assertEditError(moveRemoteFiles({ connectionId: CONN, paths: ["m6/a.md"], targetDir: "m6/not-here", message: "x" }), "NOT_FOUND", /不存在/);
  seed("m6/file-not-dir", "x");
  await assertEditError(moveRemoteFiles({ connectionId: CONN, paths: ["m6/a.md"], targetDir: "m6/file-not-dir", message: "x" }), "NOT_FOUND", /不存在|不是資料夾/);
  assert.equal(head(), before + 1, "只有 seed 那一次，沒有多出移動的 revision");
});

test("說明不是必填：留空（或只有空白）會自動補「移動 N 個項目到「目標」」", async () => {
  seed("m12/a.md", "a");
  seed("m12/b.md", "b");
  seed("m12/dst/keep.md", "k");
  await moveRemoteFiles({ connectionId: CONN, paths: ["m12/a.md", "m12/b.md"], targetDir: "m12/dst", message: "   " });
  assert.deepEqual(list("m12/dst"), ["a.md", "b.md", "keep.md"]);
  assert.match(svn("log", "--xml", "-r", "HEAD", repoUrl), /移動 2 個項目到「m12\/dst」/);
});

test("來源不存在：整批拒絕；數量與格式檢查；兩個同名來源衝突", async () => {
  seed("m7/x/a.md", "a");
  seed("m7/y/a.md", "a2");
  seed("m7/dst/keep.md", "k");
  await assertEditError(moveRemoteFiles({ connectionId: CONN, paths: ["m7/x/a.md", "m7/ghost.md"], targetDir: "m7/dst", message: "x" }), "NOT_FOUND");
  assert.deepEqual(list("m7/x"), ["a.md"], "存在的那個也沒被移動");
  await assertEditError(moveRemoteFiles({ connectionId: CONN, paths: [], targetDir: "m7/dst", message: "x" }), "INVALID_INPUT", /請選擇/);
  await assertEditError(moveRemoteFiles({ connectionId: CONN, paths: ["m7/../x"], targetDir: "m7/dst", message: "x" }), "INVALID_INPUT", /\.\./);
  await assertEditError(moveRemoteFiles({ connectionId: CONN, paths: ["m7/x/a.md"], targetDir: "m7/../etc", message: "x" }), "INVALID_INPUT", /\.\./);
  await assertEditError(moveRemoteFiles({ connectionId: CONN, paths: ["m7/x/a.md", "m7/y/a.md"], targetDir: "m7/dst", message: "x" }), "INVALID_INPUT", /兩個同名/);
});

test("被鎖定、正在編輯中的項目（含資料夾底下有編輯中的檔案）不能移動", async () => {
  seed("m8/lockme.md", "l");
  seed("m8/dir/editing.docx", "docx");
  seed("m8/dst/keep.md", "k");
  svn("lock", `${repoUrl}/m8/lockme.md`);
  try {
    await assertEditError(moveRemoteFiles({ connectionId: CONN, paths: ["m8/lockme.md"], targetDir: "m8/dst", message: "x" }), "FILE_LOCKED", /鎖定/);
  } finally {
    svn("unlock", `${repoUrl}/m8/lockme.md`);
  }
  const session = await openEdit({ connectionId: CONN, path: "m8/dir/editing.docx" });
  try {
    await assertEditError(moveRemoteFiles({ connectionId: CONN, paths: ["m8/dir"], targetDir: "m8/dst", message: "x" }), "ALREADY_EDITING", /編輯中/);
    await assertEditError(moveRemoteFiles({ connectionId: CONN, paths: ["m8/dir/editing.docx"], targetDir: "m8/dst", message: "x" }), "ALREADY_EDITING", /編輯中/);
  } finally {
    await discardEdit(session.id);
  }
  assert.deepEqual(list("m8/dir"), ["editing.docx"], "沒有任何東西被移動");
});

test("寫稽核紀錄：成功與失敗各一行", async () => {
  seed("m9/a.md", "a");
  seed("m9/dst/keep.md", "k");
  await moveRemoteFiles({ connectionId: CONN, paths: ["m9/a.md"], targetDir: "m9/dst", message: "稽核測試" });
  await assertEditError(moveRemoteFiles({ connectionId: CONN, paths: ["m9/dst/keep.md"], targetDir: "m9/dst", message: "稽核測試" }), "INVALID_INPUT");
  const lines = fs.readFileSync(path.join(root, "audit.log"), "utf-8").trim().split(/\r?\n/).map((l) => JSON.parse(l)).filter((l) => l.op === "move");
  assert.ok(lines.some((l) => l.ok === true && l.moved?.[0]?.to === "m9/dst/a.md"));
  assert.ok(lines.some((l) => l.ok === false && l.error));
});

test("moveRemoteFilesAndSync：同步本地端關閉時沒有 localSync 欄位", async () => {
  await configure({ sync: false, localPath: [] });
  seed("m10/a.md", "a");
  seed("m10/dst/keep.md", "k");
  const r = await moveRemoteFilesAndSync({ connectionId: CONN, paths: ["m10/a.md"], targetDir: "m10/dst", message: "不同步" });
  assert.equal(r.localSync, undefined);
  assert.deepEqual(list("m10/dst"), ["a.md", "keep.md"]);
});

test("開關開啟：移動後本地端原位置的檔案消失、新位置出現；沒動到的檔案不受影響", async () => {
  seed("m11/from/a.md", "a");
  seed("m11/to/keep.md", "k");
  const local = checkoutLocal("local-move");
  await configure({ sync: true, localPath: local });
  try {
    const r = await moveRemoteFilesAndSync({ connectionId: CONN, paths: ["m11/from/a.md"], targetDir: "m11/to", message: "同步" });
    assert.equal(r.localSync?.status, "updated", r.localSync?.message);
    assert.equal(fs.existsSync(path.join(local, "m11", "from", "a.md")), false, "舊位置消失");
    assert.equal(fs.readFileSync(path.join(local, "m11", "to", "a.md"), "utf-8"), "a");
    assert.equal(fs.readFileSync(path.join(local, "m11", "to", "keep.md"), "utf-8"), "k");
  } finally {
    await configure({ sync: false, localPath: [] });
  }
});
