// 「直接改遠端檔案／資料夾名稱」：原地 svn move，不用填說明（自動產生），同名不覆蓋，編輯中或被鎖定不能改。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createSvnFixture } from "./helpers/svn-fixture.mjs";
import { EditError, openEdit, discardEdit } from "../dist/remote-edit-client.js";
import { renameRemoteEntryAndSync } from "../dist/remote-rename.js";
import { addLocalPath, readRepoPrefs, removeLocalPath, setSyncLocal } from "../dist/repo-prefs.js";

const { repoUrl, root, svn, seed, checkoutLocal } = createSvnFixture({ prefix: "svn-rename-remote-test-", v2: true });
const CONN = "s1:myrepo";
// 這台電腦的 svn 文字輸出是 Big5，中文檔名會變亂碼；--xml 一律是 UTF-8
const list = (rel) => [...svn("list", "--xml", `${repoUrl}/${encodeURI(rel)}`.replace(/\/$/, "")).matchAll(/<name>([^<]*)<\/name>/g)].map((m) => m[1]).sort();
const head = () => Number(/(\d+)/.exec(svn("info", "--show-item", "revision", repoUrl))[1]);
async function configure({ sync, localPath }) {
  await setSyncLocal(sync);
  for (const existing of (await readRepoPrefs()).localPaths.myrepo ?? []) await removeLocalPath("myrepo", existing);
  for (const dir of [].concat(localPath || [])) await addLocalPath("myrepo", dir);
}
async function assertEditError(promise, code, pattern) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof EditError, `應該是 EditError，實際：${e?.constructor?.name}：${e?.message}`);
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

test("改檔案名稱：一個 revision、內容不變、歷史保留，commit 訊息自動產生「重新命名：舊 → 新」", async () => {
  await configure({ sync: false, localPath: [] });
  seed("r1/舊規格.md", "內容");
  const before = head();
  const r = await renameRemoteEntryAndSync({ connectionId: CONN, path: "r1/舊規格.md", newName: "新規格.md" });
  assert.equal(r.renamedRevision, before + 1);
  assert.equal(head(), before + 1);
  assert.deepEqual([r.from, r.to, r.newName], ["r1/舊規格.md", "r1/新規格.md", "新規格.md"]);
  assert.equal(r.localSync, undefined);
  assert.deepEqual(list("r1"), ["新規格.md"]);
  assert.equal(svn("cat", `${repoUrl}/r1/${encodeURI("新規格.md")}`), "內容");
  const log = svn("log", "-v", "--xml", "-r", "HEAD", repoUrl);
  assert.match(log, /copyfrom-path/, "svn move 保留歷史");
  assert.match(log, /重新命名：舊規格\.md → 新規格\.md/);
});

test("改資料夾名稱：底下所有內容跟著走；資料夾名稱含「.」不會被當成副檔名", async () => {
  seed("r2/OC.銷項發票折讓/a.md", "a");
  seed("r2/OC.銷項發票折讓/sub/b.md", "b");
  const r = await renameRemoteEntryAndSync({ connectionId: CONN, path: "r2/OC.銷項發票折讓", newName: "OC.銷項發票折讓v2" });
  assert.equal(r.to, "r2/OC.銷項發票折讓v2");
  assert.deepEqual(list("r2"), ["OC.銷項發票折讓v2"]);
  assert.deepEqual(list("r2/OC.銷項發票折讓v2"), ["a.md", "sub"]);
  assert.deepEqual(list("r2/OC.銷項發票折讓v2/sub"), ["b.md"]);
});

test("只改大小寫也可以（不會把自己算成同名衝突）", async () => {
  seed("r3/readme.md", "x");
  const r = await renameRemoteEntryAndSync({ connectionId: CONN, path: "r3/readme.md", newName: "README.md" });
  assert.equal(r.to, "r3/README.md");
  assert.deepEqual(list("r3"), ["README.md"]);
});

test("新名稱不合規：空白、不允許字元、副檔名不同、跟原名一樣、含 / —— 都拒絕且遠端不變", async () => {
  seed("r4/規格.md", "x");
  const before = head();
  const rename = (newName) => renameRemoteEntryAndSync({ connectionId: CONN, path: "r4/規格.md", newName });
  await assertEditError(rename("   "), "INVALID_INPUT", /不能是空的/);
  await assertEditError(rename("a:b.md"), "INVALID_INPUT", /不能包含/);
  await assertEditError(rename("a/b.md"), "INVALID_INPUT", /不能包含/);
  await assertEditError(rename("..") , "INVALID_INPUT", /不能包含/);
  await assertEditError(rename("規格.txt"), "INVALID_INPUT", /副檔名/);
  await assertEditError(rename("規格.md"), "INVALID_INPUT", /一樣/);
  assert.equal(head(), before);
  assert.deepEqual(list("r4"), ["規格.md"]);
});

test("同目錄已有同名（不分大小寫）：拒絕、不覆蓋", async () => {
  seed("r5/a.md", "from-a");
  seed("r5/B.md", "keep-me");
  const before = head();
  await assertEditError(renameRemoteEntryAndSync({ connectionId: CONN, path: "r5/a.md", newName: "b.md" }), "ALREADY_EXISTS", /已經有「B\.md」/);
  assert.equal(head(), before);
  assert.equal(svn("cat", `${repoUrl}/r5/B.md`), "keep-me");
});

test("來源不存在、路徑跳出範圍：拒絕", async () => {
  await assertEditError(renameRemoteEntryAndSync({ connectionId: CONN, path: "r6/ghost.md", newName: "x.md" }), "NOT_FOUND");
  await assertEditError(renameRemoteEntryAndSync({ connectionId: CONN, path: "../etc/passwd", newName: "x" }), "INVALID_INPUT", /\.\./);
});

test("被鎖定、正在編輯中的項目（含資料夾底下有編輯中的檔案）不能改名", async () => {
  seed("r7/lockme.md", "l");
  seed("r7/dir/editing.docx", "docx");
  svn("lock", `${repoUrl}/r7/lockme.md`);
  try {
    await assertEditError(renameRemoteEntryAndSync({ connectionId: CONN, path: "r7/lockme.md", newName: "other.md" }), "FILE_LOCKED", /鎖定/);
  } finally {
    svn("unlock", `${repoUrl}/r7/lockme.md`);
  }
  const session = await openEdit({ connectionId: CONN, path: "r7/dir/editing.docx" });
  try {
    await assertEditError(renameRemoteEntryAndSync({ connectionId: CONN, path: "r7/dir", newName: "dir2" }), "ALREADY_EDITING", /編輯中/);
    await assertEditError(renameRemoteEntryAndSync({ connectionId: CONN, path: "r7/dir/editing.docx", newName: "x.docx" }), "ALREADY_EDITING", /編輯中/);
  } finally {
    await discardEdit(session.id);
  }
  assert.deepEqual(list("r7"), ["dir", "lockme.md"]);
});

test("寫稽核紀錄：成功與失敗各一行", async () => {
  seed("r8/a.md", "a");
  await renameRemoteEntryAndSync({ connectionId: CONN, path: "r8/a.md", newName: "b.md" });
  await assertEditError(renameRemoteEntryAndSync({ connectionId: CONN, path: "r8/b.md", newName: "b.md" }), "INVALID_INPUT");
  const lines = fs.readFileSync(path.join(root, "audit.log"), "utf-8").trim().split(/\r?\n/).map((l) => JSON.parse(l)).filter((l) => l.op === "rename");
  assert.ok(lines.some((l) => l.ok === true && l.to === "r8/b.md"));
  assert.ok(lines.some((l) => l.ok === false && l.error));
});

test("開關開啟：改名後本地端舊名消失、新名出現", async () => {
  seed("r9/old.md", "o");
  seed("r9/keep.md", "k");
  const local = checkoutLocal("local-rename-remote");
  await configure({ sync: true, localPath: local });
  try {
    const r = await renameRemoteEntryAndSync({ connectionId: CONN, path: "r9/old.md", newName: "new.md" });
    assert.equal(r.localSync?.status, "updated", r.localSync?.message);
    assert.equal(fs.existsSync(path.join(local, "r9", "old.md")), false);
    assert.equal(fs.readFileSync(path.join(local, "r9", "new.md"), "utf-8"), "o");
    assert.equal(fs.readFileSync(path.join(local, "r9", "keep.md"), "utf-8"), "k");
  } finally {
    await configure({ sync: false, localPath: [] });
  }
});
