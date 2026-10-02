// 工作副本操作：用本機臨時 SVN 儲存庫（svnadmin + file://），不連任何真實 SVN。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { wcStatus, wcDiff, wcAddAndCommit, wcUpdate, wcDelete, wcRevert, resolveInsideWorkCopy } from "../dist/workcopy-client.js";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "svn-wc-test-")));
const repoDir = path.join(root, "repo");
const connFile = path.join(root, "connections.json");
const svn = (...args) => execFileSync("svn", [...args, "--non-interactive"], { encoding: "utf-8" });

execFileSync("svnadmin", ["create", repoDir]);
const repoUrl = pathToFileURL(repoDir).href;
fs.writeFileSync(connFile, JSON.stringify([{ id: "t1", name: "test", url: repoUrl, username: "u", password: "p" }]));
process.env.SVN_CONNECTIONS_FILE = connFile;

let counter = 0;
function newWorkCopy() {
  const dir = path.join(root, `wc${counter++}`);
  svn("checkout", repoUrl, dir);
  return dir;
}
const opts = (wc) => ({ workCopyPath: wc, connectionId: "t1" });
const write = (wc, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(wc, rel)), { recursive: true });
  fs.writeFileSync(path.join(wc, rel), content);
};

// 種子內容：兩個檔案先 commit 進儲存庫
const seed = newWorkCopy();
write(seed, "a.txt", "line1\nline2\nline3\n");
write(seed, "b.txt", "bbb\n");
svn("add", path.join(seed, "a.txt"), path.join(seed, "b.txt"));
svn("commit", "-m", "seed", seed);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("resolveInsideWorkCopy rejects escapes and absolute paths", () => {
  const wc = path.join(root, "x");
  assert.throws(() => resolveInsideWorkCopy(wc, "../evil.txt"), /\.\./);
  assert.throws(() => resolveInsideWorkCopy(wc, "a/../../evil"), /\.\./);
  assert.throws(() => resolveInsideWorkCopy(wc, "C:\\Windows\\x"), /相對/);
  assert.throws(() => resolveInsideWorkCopy(wc, "/etc/passwd"), /相對/);
  assert.throws(() => resolveInsideWorkCopy(wc, ".svn/entries"), /\.svn/);
  assert.throws(() => resolveInsideWorkCopy(wc, ""), /空/);
  assert.equal(resolveInsideWorkCopy(wc, "dir/sub/f.txt"), path.join(wc, "dir", "sub", "f.txt"));
});

test("status lists changes and hides Office lock files", async () => {
  const wc = newWorkCopy();
  write(wc, "a.txt", "line1\nCHANGED\nline3\n");
  write(wc, "new.txt", "new\n");
  write(wc, "~$lock.docx", "lock");
  fs.rmSync(path.join(wc, "b.txt"));
  const { entries } = await wcStatus(opts(wc));
  const byPath = Object.fromEntries(entries.map((e) => [e.path, e.status]));
  assert.equal(byPath["a.txt"], "modified");
  assert.equal(byPath["new.txt"], "unversioned");
  assert.equal(byPath["b.txt"], "missing");
  assert.equal("~$lock.docx" in byPath, false);
});

test("add+commit uploads new (incl. non-ASCII name) and modified files, then status is clean", async () => {
  const wc = newWorkCopy();
  write(wc, "a.txt", "line1\nline2\nline3\nline4\n");
  write(wc, "規格書_v1.txt", "spec\n");
  const result = await wcAddAndCommit(opts(wc), ["a.txt", "規格書_v1.txt"], "[T-1] 上傳規格");
  assert.ok(result.committedRevision && result.committedRevision > 1);
  assert.deepEqual(result.added, ["規格書_v1.txt"]);
  assert.equal((await wcStatus(opts(wc))).entries.length, 0);
  assert.match(svn("cat", `${repoUrl}/${encodeURIComponent("規格書_v1.txt")}`), /spec/);
  assert.match(svn("log", "--xml", "-l", "1", repoUrl), /\[T-1\] 上傳規格/); // --xml 輸出固定是 UTF-8，純文字會被轉成系統字碼頁
});

test("commit requires a message and an explicit, valid file list", async () => {
  const wc = newWorkCopy();
  write(wc, "a.txt", "changed\n");
  await assert.rejects(wcAddAndCommit(opts(wc), ["a.txt"], "   "), /message/);
  await assert.rejects(wcAddAndCommit(opts(wc), [], "msg"), /沒有指定/);
  await assert.rejects(wcAddAndCommit(opts(wc), ["../outside.txt"], "msg"), /\.\./);
  await assert.rejects(wcAddAndCommit(opts(wc), ["b.txt"], "msg"), /沒有任何可上傳/);
});

test("unversioned directory is added without Office lock files", async () => {
  const wc = newWorkCopy();
  write(wc, "newdir/doc.txt", "doc\n");
  write(wc, "newdir/~$doc.docx", "lock");
  await wcAddAndCommit(opts(wc), ["newdir"], "add dir");
  const listing = svn("ls", "-R", repoUrl);
  assert.match(listing, /newdir\/doc\.txt/);
  assert.doesNotMatch(listing, /~\$doc/);
});

test("delete: missing file is scheduled then removed from remote by commit; modified file is refused", async () => {
  const wc = newWorkCopy();
  fs.rmSync(path.join(wc, "b.txt"));
  const { scheduled } = await wcDelete(opts(wc), ["b.txt"]);
  assert.deepEqual(scheduled, ["b.txt"]);
  await wcAddAndCommit(opts(wc), ["b.txt"], "remove b");
  assert.doesNotMatch(svn("ls", repoUrl), /b\.txt/);

  write(wc, "a.txt", "dirty\n");
  await assert.rejects(wcDelete(opts(wc), ["a.txt"]), /未上傳/);
});

test("revert: restores missing, undoes add, refuses modified", async () => {
  const wc = newWorkCopy();
  fs.rmSync(path.join(wc, "a.txt"));
  await wcRevert(opts(wc), "a.txt");
  assert.ok(fs.existsSync(path.join(wc, "a.txt")));

  write(wc, "tmp.txt", "t\n");
  svn("add", path.join(wc, "tmp.txt"));
  await wcRevert(opts(wc), "tmp.txt");
  assert.equal((await wcStatus(opts(wc))).entries.find((e) => e.path === "tmp.txt")?.status, "unversioned");

  write(wc, "a.txt", "precious edits\n");
  await assert.rejects(wcRevert(opts(wc), "a.txt"), /丟掉/);
  assert.equal(fs.readFileSync(path.join(wc, "a.txt"), "utf-8"), "precious edits\n");
});

test("update pulls remote changes and reports conflicts without auto-resolving", async () => {
  const a = newWorkCopy();
  const b = newWorkCopy();
  write(a, "a.txt", "line1\nFROM A\nline3\n");
  await wcAddAndCommit(opts(a), ["a.txt"], "A edits");

  write(b, "a.txt", "line1\nFROM B\nline3\n");
  const result = await wcUpdate(opts(b));
  assert.deepEqual(result.conflicts, ["a.txt"]);
  assert.ok(result.revision && result.revision > 1);
  const status = await wcStatus(opts(b));
  assert.equal(status.entries.find((e) => e.path === "a.txt")?.status, "conflicted");
  await assert.rejects(wcAddAndCommit(opts(b), ["a.txt"], "try"), /衝突/);
});

test("failed commit (out of date) rolls back the adds it made", async () => {
  const a = newWorkCopy();
  const b = newWorkCopy();
  write(a, "a.txt", "line1\nline2\nA-side\n");
  await wcAddAndCommit(opts(a), ["a.txt"], "A first");

  write(b, "a.txt", "line1\nline2\nB-side\n");
  write(b, "extra.txt", "extra\n");
  await assert.rejects(wcAddAndCommit(opts(b), ["a.txt", "extra.txt"], "B second"));
  const status = await wcStatus(opts(b));
  assert.equal(status.entries.find((e) => e.path === "extra.txt")?.status, "unversioned");
  assert.equal(fs.readFileSync(path.join(b, "extra.txt"), "utf-8"), "extra\n");
});

test("diff shows text diff, new-file content and binary notice", async () => {
  const wc = newWorkCopy();
  write(wc, "a.txt", "line1\nDIFFED\nline3\n");
  write(wc, "n.txt", "brand new\n");
  fs.writeFileSync(path.join(wc, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  assert.match((await wcDiff(opts(wc), "a.txt")).text, /\+DIFFED/);
  const fresh = await wcDiff(opts(wc), "n.txt");
  assert.equal(fresh.kind, "new-file");
  assert.match(fresh.text, /brand new/);
  assert.equal((await wcDiff(opts(wc), "bin.dat")).kind, "binary");
});

test("a working copy outside the connection's URL is refused", async () => {
  const otherRepo = path.join(root, "repo2");
  execFileSync("svnadmin", ["create", otherRepo]);
  const otherWc = path.join(root, "wc-other");
  svn("checkout", pathToFileURL(otherRepo).href, otherWc);
  await assert.rejects(wcStatus({ workCopyPath: otherWc, connectionId: "t1" }), /不在連線/);
  await assert.rejects(wcStatus({ workCopyPath: path.join(root, "not-a-wc"), connectionId: "t1" }), /不是有效的 SVN 工作副本/);
});

test("revert of a copied (added) directory is refused when it contains modified files", async () => {
  const wc = newWorkCopy();
  write(wc, "src/keep.txt", "v1\n");
  await wcAddAndCommit(opts(wc), ["src"], "add src");
  // 跟真實情境（PDF Sample）一樣：svn copy 出來的資料夾是 added+copied，裡面的檔案再被修改
  svn("copy", path.join(wc, "src"), path.join(wc, "src-copy"));
  write(wc, "src-copy/keep.txt", "edited inside the copy\n");
  const status = await wcStatus(opts(wc));
  assert.equal(status.entries.find((e) => e.path === "src-copy")?.status, "added");
  assert.equal(status.entries.find((e) => e.path === "src-copy/keep.txt")?.status, "modified");

  await assert.rejects(wcRevert(opts(wc), "src-copy"), /已修改的項目/);
  assert.equal(fs.readFileSync(path.join(wc, "src-copy", "keep.txt"), "utf-8"), "edited inside the copy\n");
  assert.equal((await wcStatus(opts(wc))).entries.find((e) => e.path === "src-copy")?.status, "added");
});

test("revert of an unmodified copied directory removes only the pristine copy, never the source", async () => {
  const wc = newWorkCopy();
  write(wc, "src2/keep.txt", "v1\n");
  await wcAddAndCommit(opts(wc), ["src2"], "add src2");
  svn("copy", path.join(wc, "src2"), path.join(wc, "src2-copy"));
  await wcRevert(opts(wc), "src2-copy");
  assert.equal(fs.existsSync(path.join(wc, "src2-copy", "keep.txt")), false); // svn 會移除沒修改過的複本
  assert.equal(fs.readFileSync(path.join(wc, "src2", "keep.txt"), "utf-8"), "v1\n"); // 原件完全不受影響
  assert.equal((await wcStatus(opts(wc))).entries.length, 0);
});
