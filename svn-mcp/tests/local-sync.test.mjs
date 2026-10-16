// 「同步本地端」與「刪除遠端檔案」：用本機臨時 SVN 儲存庫（svnadmin + file://），不連任何真實 SVN。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openEdit, getEditStatus, EditError } from "../dist/remote-edit-client.js";
import { commitEditAndSync } from "../dist/local-sync.js";
import { deleteRemoteFileAndSync } from "../dist/remote-delete.js";
import { readRepoPrefs, setLocalPath, setSyncLocal } from "../dist/repo-prefs.js";
import { ConnectionInputError } from "../dist/connections-store.js";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "svn-sync-test-")));
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

let counter = 0;
/** 在遠端新增（或覆蓋）一個檔案。 */
function seed(relPath, content) {
  const wc = path.join(root, `seed${counter++}`);
  svn("checkout", repoUrl, wc);
  const abs = path.join(wc, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const existed = fs.existsSync(abs);
  fs.writeFileSync(abs, content);
  if (!existed) svn("add", "--parents", abs);
  svn("commit", "-m", "seed", "--encoding", "UTF-8", wc);
}
/** 本機工作目錄：checkout 整個專案，或只 checkout 某個子目錄。 */
function checkoutLocal(name, sub = "") {
  const dir = path.join(root, name);
  svn("checkout", sub ? `${repoUrl}/${sub}` : repoUrl, dir);
  return dir;
}
const remoteExists = (relPath) => {
  try {
    svn("info", `${repoUrl}/${relPath}`);
    return true;
  } catch {
    return false;
  }
};
async function configure({ sync, localPath }) {
  await setSyncLocal(sync);
  await setLocalPath("myrepo", localPath ?? "");
}
async function edit(relPath, newContent) {
  const session = await openEdit({ connectionId: CONN, path: relPath });
  fs.writeFileSync(session.filePath, newContent);
  return session;
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// ---- 設定 ----

test("設定：預設關閉；本地目錄只收完整路徑，結尾斜線會去掉，空白代表清掉", async () => {
  assert.equal((await readRepoPrefs()).syncLocal, false);
  assert.deepEqual((await readRepoPrefs()).localPaths, {});
  assert.equal((await setSyncLocal(true)).syncLocal, true);
  assert.equal((await setLocalPath("myrepo", "  D:\\svn\\myrepo\\  ")).localPaths.myrepo, "D:\\svn\\myrepo");
  assert.equal((await setLocalPath("myrepo", "\\\\server\\share\\repo")).localPaths.myrepo, "\\\\server\\share\\repo");
  for (const bad of ["relative\\path", "D:svn", "/etc", "D:\\a|b", "D:\\a?b", "x".repeat(500)]) {
    await assert.rejects(setLocalPath("myrepo", bad), ConnectionInputError, `應該拒絕：${bad}`);
  }
  assert.equal((await readRepoPrefs()).localPaths.myrepo, "\\\\server\\share\\repo", "被拒絕的不會改掉原本的設定");
  assert.deepEqual((await setLocalPath("myrepo", "   ")).localPaths, {});
  await assert.rejects(setSyncLocal("yes"), ConnectionInputError);
  await setSyncLocal(false);
});

// ---- 編輯上傳後同步 ----

test("開關關閉：上傳照舊，不回傳 localSync，本地端完全不動", async () => {
  seed("off/a.md", "v1\n");
  const local = checkoutLocal("local-off");
  await configure({ sync: false, localPath: local });
  const session = await edit("off/a.md", "v2\n");
  const result = await commitEditAndSync(session.id, "改");
  assert.equal(result.localSync, undefined);
  assert.equal(fs.readFileSync(path.join(local, "off", "a.md"), "utf-8"), "v1\n", "本地端維持原狀");
});

test("開關開啟：上傳成功後自動 update，本地檔案變成最新內容", async () => {
  seed("on/a.md", "v1\n");
  const local = checkoutLocal("local-on");
  await configure({ sync: true, localPath: local });
  const session = await edit("on/a.md", "v2\n");
  const result = await commitEditAndSync(session.id, "改");
  assert.equal(result.localSync?.status, "updated", result.localSync?.message);
  assert.match(result.localSync.message, /r\d+/);
  assert.equal(fs.readFileSync(path.join(local, "on", "a.md"), "utf-8"), "v2\n");
});

test("本地目錄只 checkout 了專案的子目錄也對得上，且只更新這次動到的檔案", async () => {
  seed("sub/x.md", "x1\n");
  seed("sub/y.md", "y1\n");
  const local = checkoutLocal("local-sub", "sub");
  seed("sub/y.md", "y2\n"); // 別人改了另一個檔案
  await configure({ sync: true, localPath: local });
  const session = await edit("sub/x.md", "x2\n");
  const result = await commitEditAndSync(session.id, "改 x");
  assert.equal(result.localSync?.status, "updated", result.localSync?.message);
  assert.equal(fs.readFileSync(path.join(local, "x.md"), "utf-8"), "x2\n");
  assert.equal(fs.readFileSync(path.join(local, "y.md"), "utf-8"), "y1\n", "沒動到的檔案不會被順便更新");
});

test("本地目錄沒有 SVN 追蹤：跳警示、不更新，但遠端上傳已成功", async () => {
  seed("nowc/a.md", "v1\n");
  const plain = path.join(root, "plain-dir");
  fs.mkdirSync(plain, { recursive: true });
  await configure({ sync: true, localPath: plain });
  const session = await edit("nowc/a.md", "v2\n");
  const result = await commitEditAndSync(session.id, "改");
  assert.equal(result.localSync?.status, "warning");
  assert.match(result.localSync.message, /沒有 SVN 追蹤/);
  assert.equal(result.path, "nowc/a.md");
  assert.equal(svn("cat", `${repoUrl}/nowc/a.md`), "v2\n", "遠端確實已經更新");
  assert.deepEqual(fs.readdirSync(plain), [], "沒有在無關的資料夾裡留下任何東西");
});

test("開關開啟但沒設定這個專案的本地目錄：警示", async () => {
  seed("nopath/a.md", "v1\n");
  await configure({ sync: true, localPath: "" });
  const session = await edit("nopath/a.md", "v2\n");
  const result = await commitEditAndSync(session.id, "改");
  assert.equal(result.localSync?.status, "warning");
  assert.match(result.localSync.message, /還沒設定/);
});

test("本地目錄不存在：警示", async () => {
  seed("gone/a.md", "v1\n");
  await configure({ sync: true, localPath: path.join(root, "does-not-exist") });
  const session = await edit("gone/a.md", "v2\n");
  const result = await commitEditAndSync(session.id, "改");
  assert.equal(result.localSync?.status, "warning");
  assert.match(result.localSync.message, /不存在/);
});

test("本地工作目錄不包含這個檔案所在的位置：警示、不更新", async () => {
  seed("inside/a.md", "a\n");
  seed("outside/b.md", "b1\n");
  const local = checkoutLocal("local-mismatch", "inside");
  await configure({ sync: true, localPath: local });
  const session = await edit("outside/b.md", "b2\n");
  const result = await commitEditAndSync(session.id, "改");
  assert.equal(result.localSync?.status, "warning");
  assert.match(result.localSync.message, /不包含/);
});

test("本機同一個檔案也有修改而衝突：警示要求解決衝突，不當成成功", async () => {
  seed("conflict/a.md", "line\n");
  const local = checkoutLocal("local-conflict");
  fs.writeFileSync(path.join(local, "conflict", "a.md"), "my local edit\n");
  await configure({ sync: true, localPath: local });
  const session = await edit("conflict/a.md", "remote edit\n");
  const result = await commitEditAndSync(session.id, "改");
  assert.equal(result.localSync?.status, "warning", result.localSync?.message);
  assert.match(result.localSync.message, /衝突/);
});

test("上傳失敗（沒有任何修改）照常丟錯誤，不會進到同步", async () => {
  seed("nochange/a.md", "v1\n");
  const local = checkoutLocal("local-nochange");
  await configure({ sync: true, localPath: local });
  const session = await openEdit({ connectionId: CONN, path: "nochange/a.md" });
  await assert.rejects(commitEditAndSync(session.id, "沒改"), (e) => e instanceof EditError && e.code === "NO_CHANGES");
  assert.ok((await getEditStatus(session.id)).session, "編輯項目還在");
});

// ---- 刪除遠端檔案 ----

test("刪除（開關關閉）：遠端檔案被刪、本地端不動、不回傳 localSync", async () => {
  seed("del/off.md", "x\n");
  const local = checkoutLocal("local-del-off");
  await configure({ sync: false, localPath: local });
  const result = await deleteRemoteFileAndSync({ connectionId: CONN, path: "del/off.md", message: "清掉" });
  assert.equal(result.path, "del/off.md");
  assert.ok(result.deletedRevision > 0);
  assert.equal(result.localSync, undefined);
  assert.equal(remoteExists("del/off.md"), false);
  assert.ok(fs.existsSync(path.join(local, "del", "off.md")), "本地端沒有動");
});

test("刪除（開關開啟）：遠端被刪之後本地檔案也跟著消失", async () => {
  seed("del/on.md", "x\n");
  const local = checkoutLocal("local-del-on");
  await configure({ sync: true, localPath: local });
  const result = await deleteRemoteFileAndSync({ connectionId: CONN, path: "del/on.md", message: "清掉" });
  assert.equal(result.localSync?.status, "updated", result.localSync?.message);
  assert.equal(remoteExists("del/on.md"), false);
  assert.equal(fs.existsSync(path.join(local, "del", "on.md")), false, "本地檔案已被移除");
});

test("刪除（開關開啟、本地不是工作目錄）：遠端照刪，警示本地沒有 SVN 追蹤", async () => {
  seed("del/warn.md", "x\n");
  const plain = path.join(root, "plain-del");
  fs.mkdirSync(plain, { recursive: true });
  await configure({ sync: true, localPath: plain });
  const result = await deleteRemoteFileAndSync({ connectionId: CONN, path: "del/warn.md", message: "清掉" });
  assert.equal(remoteExists("del/warn.md"), false);
  assert.equal(result.localSync?.status, "warning");
  assert.match(result.localSync.message, /沒有 SVN 追蹤/);
});

test("刪除：說明必填；只能刪檔案（資料夾拒絕）；找不到、路徑跳出範圍都拒絕", async () => {
  seed("del/keep.md", "x\n");
  await configure({ sync: false, localPath: "" });
  const code = (c) => (e) => e instanceof EditError && e.code === c;
  await assert.rejects(deleteRemoteFileAndSync({ connectionId: CONN, path: "del/keep.md", message: "   " }), code("INVALID_INPUT"));
  await assert.rejects(deleteRemoteFileAndSync({ connectionId: CONN, path: "del", message: "刪資料夾" }), code("INVALID_INPUT"));
  await assert.rejects(deleteRemoteFileAndSync({ connectionId: CONN, path: "del/nope.md", message: "x" }), code("NOT_FOUND"));
  await assert.rejects(deleteRemoteFileAndSync({ connectionId: CONN, path: "../etc/passwd", message: "x" }), code("INVALID_INPUT"));
  assert.ok(remoteExists("del/keep.md"), "被拒絕的刪除不會動到遠端");
});

test("刪除：正在編輯中的檔案拒絕；被鎖定的檔案拒絕", async () => {
  seed("del/busy.md", "x\n");
  const session = await openEdit({ connectionId: CONN, path: "del/busy.md" });
  await assert.rejects(deleteRemoteFileAndSync({ connectionId: CONN, path: "del/busy.md", message: "x" }), (e) => e instanceof EditError && e.code === "ALREADY_EDITING");
  assert.ok(remoteExists("del/busy.md"));
  assert.ok(session.id);

  seed("del/locked.docx", "x");
  const lockWc = checkoutLocal("lock-wc", "del");
  svn("lock", "-m", "t", path.join(lockWc, "locked.docx"));
  await assert.rejects(deleteRemoteFileAndSync({ connectionId: CONN, path: "del/locked.docx", message: "x" }), (e) => e instanceof EditError && e.code === "FILE_LOCKED");
  assert.ok(remoteExists("del/locked.docx"));
});

test("刪除：可以刪被誤提交進 SVN 的 Office 暫存檔（~$ 開頭）", async () => {
  seed("del/~$report.docx", "tmp");
  await configure({ sync: false, localPath: "" });
  const result = await deleteRemoteFileAndSync({ connectionId: CONN, path: "del/~$report.docx", message: "清掉暫存檔" });
  assert.ok(result.deletedRevision > 0);
  assert.equal(remoteExists("del/~$report.docx"), false);
});

// ---- 批次刪除 ----

test("批次刪除：多個檔案（跨資料夾）一次刪完、只產生一個 revision，本地的檔案也都消失", async () => {
  seed("batch/a.md", "a\n");
  seed("batch/b.md", "b\n");
  seed("batch/deep/c.md", "c\n");
  const local = checkoutLocal("local-batch");
  await configure({ sync: true, localPath: local });
  const before = Number(svn("info", "--show-item", "revision", repoUrl).trim());
  const result = await deleteRemoteFileAndSync({ connectionId: CONN, paths: ["batch/a.md", "batch/b.md", "batch/deep/c.md", "BATCH/A.md"], message: "批次清掉" });
  assert.deepEqual(result.paths, ["batch/a.md", "batch/b.md", "batch/deep/c.md"], "重複的路徑只算一次");
  assert.equal(result.deletedRevision, before + 1, "只產生一個 revision");
  assert.equal(result.localSync?.status, "updated", result.localSync?.message);
  for (const f of ["a.md", "b.md", path.join("deep", "c.md")]) assert.equal(fs.existsSync(path.join(local, "batch", f)), false, `${f} 本地也應該消失`);
  for (const f of ["batch/a.md", "batch/b.md", "batch/deep/c.md"]) assert.equal(remoteExists(f), false);
});

test("批次刪除：只要有一個不符合（資料夾、不存在）就整批拒絕，一個都不刪", async () => {
  seed("allnone/x.md", "x\n");
  seed("allnone/y.md", "y\n");
  await configure({ sync: false, localPath: "" });
  const code = (c) => (e) => e instanceof EditError && e.code === c;
  await assert.rejects(deleteRemoteFileAndSync({ connectionId: CONN, paths: ["allnone/x.md", "allnone"], message: "x" }), code("INVALID_INPUT"));
  await assert.rejects(deleteRemoteFileAndSync({ connectionId: CONN, paths: ["allnone/x.md", "allnone/missing.md"], message: "x" }), code("NOT_FOUND"));
  assert.ok(remoteExists("allnone/x.md") && remoteExists("allnone/y.md"), "合法的那些也不會被刪");
});

test("批次刪除：空清單與超過上限都拒絕", async () => {
  const code = (e) => e instanceof EditError && e.code === "INVALID_INPUT";
  await assert.rejects(deleteRemoteFileAndSync({ connectionId: CONN, paths: [], message: "x" }), code);
  const tooMany = Array.from({ length: 101 }, (_, i) => `many/f${i}.md`);
  await assert.rejects(deleteRemoteFileAndSync({ connectionId: CONN, paths: tooMany, message: "x" }), code);
});
