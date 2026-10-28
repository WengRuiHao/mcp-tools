// 「上傳時改檔名」：編輯好的檔案以新檔名上傳（svn move，保留歷史），也可以只改名、不改內容。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createSvnFixture } from "./helpers/svn-fixture.mjs";
import { commitEdit, discardEdit, EditError, getEditStatus, getRenamePlan, listEdits, openEdit } from "../dist/remote-edit-client.js";

const { repoUrl, svn, seed } = createSvnFixture({ prefix: "svn-rename-test-" });
const cat = (rel) => svn("cat", `${repoUrl}/${encodeURI(rel)}`);
// 這台電腦的 svn 文字輸出是 Big5，中文檔名會變亂碼；--xml 一律是 UTF-8
const list = (rel) => [...svn("list", "--xml", `${repoUrl}/${encodeURI(rel)}`).matchAll(/<name>([^<]*)<\/name>/g)].map((m) => m[1]).sort();
const head = () => Number(/(\d+)/.exec(svn("info", "--show-item", "revision", repoUrl))[1]);
const logHead = () => svn("log", "-v", "--xml", "-r", "HEAD", repoUrl);

async function assertEditError(promise, code, pattern) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof EditError, `應該是 EditError，實際：${e?.constructor?.name}：${e?.message}`);
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

test("改檔名計畫：新檔名可用就 applicable；空白、含不允許字元、副檔名不同、跟原檔一樣、目錄已有同名（不分大小寫）都講清楚原因", async () => {
  seed("r1/規格.md", "內容");
  seed("r1/已存在.md", "別的檔案");
  const session = await openEdit({ connectionId: "t1", path: "r1/規格.md" });
  try {
    const ok = await getRenamePlan(session.id, "規格_新.md");
    assert.deepEqual([ok.applicable, ok.reason, ok.currentName, ok.newName, ok.newPath], [true, null, "規格.md", "規格_新.md", "r1/規格_新.md"]);
    assert.equal((await getRenamePlan(session.id, "  規格_新.md  ")).newName, "規格_新.md", "前後空白會去掉");
    for (const [bad, pattern] of [
      ["", /不能是空的/],
      ["a/b.md", /不能包含/],
      ["a:b.md", /不能包含/],
      ["改.txt", /副檔名/],
      ["規格.md", /一樣/],
      ["規格.MD", /一樣/],
      ["已存在.md", /已經有「已存在\.md」/],
      ["已存在.MD", /已經有/],
    ]) {
      const plan = await getRenamePlan(session.id, bad);
      assert.equal(plan.applicable, false, bad);
      assert.match(plan.reason, pattern, bad);
    }
  } finally {
    await discardEdit(session.id);
  }
});

test("改名並修改內容：遠端變成新檔名、舊檔名消失、內容是新的；同一個 commit，歷史紀錄保留（svn move）", async () => {
  seed("r2/報告.md", "舊內容\n");
  const session = await openEdit({ connectionId: "t1", path: "r2/報告.md" });
  fs.writeFileSync(session.filePath, "新內容\n");
  const before = head();
  const result = await commitEdit(session.id, "改名並修改", undefined, { newName: "報告_定稿.md" });
  assert.equal(head(), before + 1, "只多一個 commit");
  assert.deepEqual(list("r2"), ["報告_定稿.md"]);
  assert.equal(cat("r2/報告_定稿.md"), "新內容\n");
  assert.equal(result.path, "r2/報告_定稿.md");
  assert.deepEqual(result.rename, { from: "r2/報告.md", to: "r2/報告_定稿.md", newName: "報告_定稿.md" });
  assert.equal(result.upgrade, undefined);
  const log = logHead();
  const paths = [...log.matchAll(/<path\b([^>]*)>([^<]*)<\/path>/g)].map((m) => ({ attrs: m[1], path: m[2] }));
  const added = paths.find((p) => p.path === "/r2/報告_定稿.md");
  assert.ok(added && /action="A"/.test(added.attrs) && /copyfrom-path="\/r2\/報告\.md"/.test(added.attrs), "用 svn move 保留歷史：新檔是從舊檔複製來的");
  const deleted = paths.find((p) => p.path === "/r2/報告.md");
  assert.ok(deleted && /action="D"/.test(deleted.attrs), "舊檔名在同一個 commit 被刪除");
  assert.equal((await listEdits()).length, 0, "編輯項目已清掉");
});

test("只改名、內容沒有修改：可以上傳（不會被『沒有修改』擋住）；沒改名也沒修改照樣擋", async () => {
  seed("r3/只改名.md", "同樣的內容\n");
  let session = await openEdit({ connectionId: "t1", path: "r3/只改名.md" });
  await assertEditError(commitEdit(session.id, "什麼都沒改"), "NO_CHANGES");
  const result = await commitEdit(session.id, "只改名", undefined, { newName: "只改名_v2.md" });
  assert.deepEqual(list("r3"), ["只改名_v2.md"]);
  assert.equal(cat("r3/只改名_v2.md"), "同樣的內容\n");
  assert.equal(result.rename?.newName, "只改名_v2.md");
});

test("被鎖定的檔案也能改名上傳（鎖會一起釋放，遠端不會留下鎖）", async () => {
  seed("r4/鎖定.md", "原本\n");
  const session = await openEdit({ connectionId: "t1", path: "r4/鎖定.md", lock: true });
  assert.equal(session.locked, true);
  fs.writeFileSync(session.filePath, "改過\n");
  await commitEdit(session.id, "鎖定中改名", undefined, { newName: "鎖定_新.md" });
  assert.deepEqual(list("r4"), ["鎖定_新.md"]);
  assert.equal(cat("r4/鎖定_新.md"), "改過\n");
  assert.doesNotMatch(svn("info", "--xml", `${repoUrl}/${encodeURI("r4/鎖定_新.md")}`), /<lock>/, "新檔沒有被鎖住");
});

test("新檔名已存在：ALREADY_EXISTS，遠端沒有任何變動，編輯項目與修改內容都還在", async () => {
  seed("r5/來源.md", "來源\n");
  seed("r5/擋路.md", "別人的檔案\n");
  const session = await openEdit({ connectionId: "t1", path: "r5/來源.md" });
  fs.writeFileSync(session.filePath, "我的修改\n");
  const before = head();
  await assertEditError(commitEdit(session.id, "改成已存在的名字", undefined, { newName: "擋路.md" }), "ALREADY_EXISTS", /已經有「擋路\.md」/);
  assert.equal(head(), before, "遠端沒有新增 commit");
  assert.equal(cat("r5/擋路.md"), "別人的檔案\n");
  assert.equal(cat("r5/來源.md"), "來源\n");
  const status = await getEditStatus(session.id);
  assert.equal(status.modified, true, "你的修改還在");
  assert.equal(fs.readFileSync(session.filePath, "utf-8"), "我的修改\n");
  await discardEdit(session.id);
});

test("新檔名不合法：INVALID_INPUT；改名跟升級版本不能同時選", async () => {
  seed("r6/a_v0.1.md", "a\n");
  const session = await openEdit({ connectionId: "t1", path: "r6/a_v0.1.md" });
  fs.writeFileSync(session.filePath, "b\n");
  await assertEditError(commitEdit(session.id, "x", undefined, { newName: "../escape.md" }), "INVALID_INPUT", /不能包含/);
  await assertEditError(commitEdit(session.id, "x", undefined, { newName: "a_v0.1.docx" }), "INVALID_INPUT", /副檔名/);
  await assertEditError(commitEdit(session.id, "x", undefined, { newName: "" }), "INVALID_INPUT", /不能是空的/);
  await assertEditError(commitEdit(session.id, "x", true, { newName: "a_v0.9.md" }), "INVALID_INPUT", /只能選一個/);
  assert.deepEqual(list("r6"), ["a_v0.1.md"], "遠端完全沒動");
  await discardEdit(session.id);
});

test("遠端在你編輯期間被別人更新：照樣擋下（改名不會繞過衝突檢查）", async () => {
  seed("r7/衝突.md", "v1\n");
  const session = await openEdit({ connectionId: "t1", path: "r7/衝突.md" });
  fs.writeFileSync(session.filePath, "我的版本\n");
  seed("r7/衝突.md", "別人改了\n");
  await assertEditError(commitEdit(session.id, "改名", undefined, { newName: "衝突_新.md" }), "REMOTE_CHANGED");
  assert.deepEqual(list("r7"), ["衝突.md"]);
  await discardEdit(session.id);
});
