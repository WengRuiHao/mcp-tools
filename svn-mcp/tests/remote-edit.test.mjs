// 遠端單一檔案編輯：用本機臨時 SVN 儲存庫（svnadmin + file://），不連任何真實 SVN。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openEdit, commitEdit, discardEdit, exportLatest, getEditStatus, listEdits, EditError } from "../dist/remote-edit-client.js";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "svn-edit-test-")));
const repoDir = path.join(root, "repo");
const connFile = path.join(root, "connections.json");
const svn = (...args) => execFileSync("svn", [...args, "--non-interactive"], { encoding: "utf-8" });

execFileSync("svnadmin", ["create", repoDir]);
const repoUrl = pathToFileURL(repoDir).href;
fs.writeFileSync(
  connFile,
  JSON.stringify([
    { id: "t1", name: "test", url: repoUrl, username: "u", password: "p" },
    { id: "t2", name: "other", url: repoUrl, username: "other", password: "p" },
  ])
);
process.env.SVN_CONNECTIONS_FILE = connFile;
process.env.SVN_EDIT_TEMP_DIR = path.join(root, "edit-tmp");

let counter = 0;
/** 在儲存庫裡新增（或覆蓋）一個檔案，回傳該檔案在遠端的路徑。 */
function seed(relPath, content) {
  const wc = path.join(root, `seed${counter++}`);
  svn("checkout", repoUrl, wc);
  const abs = path.join(wc, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const existed = fs.existsSync(abs);
  fs.writeFileSync(abs, content);
  if (!existed) {
    // 逐層 add 目錄（--parents 讓新目錄一起加入）
    svn("add", "--parents", abs);
  }
  svn("commit", "-m", "seed", "--encoding", "UTF-8", wc);
  return relPath;
}
const remoteCat = (relPath) => svn("cat", `${repoUrl}/${relPath}`);
const remoteInfoXml = (relPath) => svn("info", "--xml", `${repoUrl}/${relPath}`);
const sessionDirs = () => (fs.existsSync(process.env.SVN_EDIT_TEMP_DIR) ? fs.readdirSync(process.env.SVN_EDIT_TEMP_DIR).filter((n) => /^[0-9a-f-]{36}$/.test(n)) : []);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

async function assertEditError(promise, code, messagePattern) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof EditError, `應該是 EditError，實際：${err?.constructor?.name}：${err?.message}`);
    assert.equal(err.code, code, err.message);
    if (messagePattern) assert.match(err.message, messagePattern);
    return true;
  });
}

test("md 檔：開啟、修改、上傳，遠端內容更新且暫存資料夾被清掉（不上鎖）", async () => {
  seed("notes/readme.md", "# v1\n");
  const session = await openEdit({ connectionId: "t1", path: "notes/readme.md", ticket: "GV-1" });
  assert.equal(session.locked, false);
  assert.equal(session.ticket, "GV-1");
  assert.equal(fs.readFileSync(session.filePath, "utf-8"), "# v1\n");

  fs.writeFileSync(session.filePath, "# v2\n");
  const status = await getEditStatus(session.id);
  assert.equal(status.modified, true);
  assert.equal(status.editorStillOpen, false);

  const result = await commitEdit(session.id, "[GV-1] 更新說明");
  assert.ok(result.committedRevision > 1);
  assert.equal(result.cleanedUp, true);
  assert.equal(remoteCat("notes/readme.md"), "# v2\n");
  assert.match(svn("log", "--xml", "-l", "1", repoUrl), /\[GV-1\] 更新說明/);
  assert.equal(fs.existsSync(session.sessionDir), false);
});

test("docx 檔（中文路徑與檔名）：開啟時上鎖、上傳後鎖自動釋放", async () => {
  seed("規格書/需求_v1.docx", "PK-fake-docx-v1");
  const session = await openEdit({ connectionId: "t1", path: "規格書/需求_v1.docx" });
  assert.equal(session.locked, true);
  assert.match(remoteInfoXml("規格書/需求_v1.docx"), /<lock>[\s\S]*<owner>u<\/owner>/);

  fs.writeFileSync(session.filePath, "PK-fake-docx-v2");
  await commitEdit(session.id, "更新需求書");
  assert.equal(remoteCat("規格書/需求_v1.docx"), "PK-fake-docx-v2");
  assert.doesNotMatch(remoteInfoXml("規格書/需求_v1.docx"), /<lock>/);
  assert.equal(fs.existsSync(session.sessionDir), false);
});

test("被別人鎖住的檔案：拒絕開啟，且不留下暫存資料夾", async () => {
  seed("locked.xlsx", "xlsx-v1");
  const mine = await openEdit({ connectionId: "t1", path: "locked.xlsx" });
  const before = sessionDirs().length;
  await assertEditError(openEdit({ connectionId: "t2", path: "locked.xlsx" }), "FILE_LOCKED", /「u」/);
  assert.equal(sessionDirs().length, before);
  await discardEdit(mine.id);
});

test("同一個檔案不能同時開兩個編輯項目", async () => {
  seed("dup.md", "dup\n");
  const first = await openEdit({ connectionId: "t1", path: "dup.md" });
  await assertEditError(openEdit({ connectionId: "t1", path: "dup.md" }), "ALREADY_EDITING");
  await discardEdit(first.id);
});

test("沒有修改就上傳：拒絕（不產生空 commit），編輯項目保留", async () => {
  seed("same.md", "same\n");
  const session = await openEdit({ connectionId: "t1", path: "same.md" });
  const headBefore = svn("info", "--show-item", "revision", repoUrl).trim();
  await assertEditError(commitEdit(session.id, "沒改"), "NO_CHANGES");
  assert.equal(svn("info", "--show-item", "revision", repoUrl).trim(), headBefore);
  assert.ok(fs.existsSync(session.sessionDir));
  await discardEdit(session.id);
});

test("Word/Excel 暫存鎖定檔還在：拒絕上傳；移除後可以上傳", async () => {
  seed("open.docx", "open-v1");
  const session = await openEdit({ connectionId: "t1", path: "open.docx" });
  fs.writeFileSync(session.filePath, "open-v2");
  const lockFile = path.join(path.dirname(session.filePath), "~$pen.docx");
  fs.writeFileSync(lockFile, "x");
  assert.equal((await getEditStatus(session.id)).editorStillOpen, true);
  await assertEditError(commitEdit(session.id, "msg"), "EDITOR_STILL_OPEN");
  fs.rmSync(lockFile);
  await commitEdit(session.id, "msg");
  assert.equal(remoteCat("open.docx"), "open-v2");
});

test("遠端在開啟後被別人更新：拒絕上傳、保留本機修改，可下載最新版另存", async () => {
  seed("race.md", "base\n");
  const session = await openEdit({ connectionId: "t1", path: "race.md" });
  fs.writeFileSync(session.filePath, "my edit\n");

  seed("race.md", "someone else\n"); // 另一個人在這段時間提交了
  assert.equal((await getEditStatus(session.id, { checkRemote: true })).remoteChanged, true);
  await assertEditError(commitEdit(session.id, "我的修改"), "REMOTE_CHANGED", /r\d+/);
  assert.equal(remoteCat("race.md"), "someone else\n"); // 沒有蓋掉對方
  assert.equal(fs.readFileSync(session.filePath, "utf-8"), "my edit\n"); // 本機修改還在

  const latest = await exportLatest(session.id);
  assert.equal(fs.readFileSync(latest.path, "utf-8"), "someone else\n");
  assert.equal(fs.readFileSync(session.filePath, "utf-8"), "my edit\n");
  await discardEdit(session.id);
  assert.equal(fs.existsSync(session.sessionDir), false);
});

test("放棄：解除鎖定並刪除暫存資料夾；鎖已被別人解開時也能放棄", async () => {
  seed("discard.docx", "d1");
  const a = await openEdit({ connectionId: "t1", path: "discard.docx" });
  await discardEdit(a.id);
  assert.doesNotMatch(remoteInfoXml("discard.docx"), /<lock>/);
  assert.equal(fs.existsSync(a.sessionDir), false);

  const b = await openEdit({ connectionId: "t1", path: "discard.docx" });
  svn("unlock", "--force", `${repoUrl}/discard.docx`); // 管理者用強制方式解開了這把鎖
  await discardEdit(b.id);
  assert.equal(fs.existsSync(b.sessionDir), false);
});

test("當機復原：殘留的編輯項目可以被列出，並可繼續上傳或放棄", async () => {
  seed("crash.md", "c1\n");
  const session = await openEdit({ connectionId: "t1", path: "crash.md" });
  fs.writeFileSync(session.filePath, "c2\n");

  const found = (await listEdits()).find((s) => s.id === session.id);
  assert.ok(found);
  assert.equal(found.path, "crash.md");
  assert.equal(found.connectionName, "test");
  await commitEdit(found.id, "復原後上傳");
  assert.equal(remoteCat("crash.md"), "c2\n");
  assert.equal((await listEdits()).some((s) => s.id === session.id), false);
});

test("不合法的輸入一律拒絕", async () => {
  seed("ok.md", "ok\n");
  await assertEditError(openEdit({ connectionId: "t1", path: "" }), "INVALID_INPUT");
  await assertEditError(openEdit({ connectionId: "t1", path: "../outside.md" }), "INVALID_INPUT", /\.\./);
  await assertEditError(openEdit({ connectionId: "t1", path: "a/../../b.md" }), "INVALID_INPUT", /\.\./);
  await assertEditError(openEdit({ connectionId: "t1", path: "tool.exe" }), "INVALID_INPUT", /不支援/);
  await assertEditError(openEdit({ connectionId: "t1", path: "noext" }), "INVALID_INPUT", /不支援/);
  await assertEditError(openEdit({ connectionId: "t1", path: "missing.md" }), "NOT_FOUND");
  await assert.rejects(openEdit({ connectionId: "t1", path: "file:///c:/x.md" })); // 完整 URL 不允許
  await assertEditError(getEditStatus("../../etc"), "INVALID_INPUT");
  await assertEditError(commitEdit("not-a-session", "m"), "INVALID_INPUT");
  await assertEditError(commitEdit("00000000-0000-0000-0000-000000000000", "m"), "NOT_FOUND");
});

test("目錄不是檔案：拒絕", async () => {
  seed("somedir.d/x.md", "x\n");
  svn("mkdir", `${repoUrl}/folder.md`, "-m", "dir named like a file");
  await assertEditError(openEdit({ connectionId: "t1", path: "folder.md" }), "INVALID_INPUT", /不是檔案/);
});

test("commit 訊息不能是空的；過長也拒絕", async () => {
  seed("msg.md", "m1\n");
  const session = await openEdit({ connectionId: "t1", path: "msg.md" });
  fs.writeFileSync(session.filePath, "m2\n");
  await assertEditError(commitEdit(session.id, "   "), "INVALID_INPUT", /message/);
  await assertEditError(commitEdit(session.id, "x".repeat(4001)), "INVALID_INPUT", /太長/);
  await discardEdit(session.id);
});

test("稽核紀錄：每個動作留一行，commit 訊息只記長度與前 80 字", async () => {
  seed("audit.md", "a1\n");
  const session = await openEdit({ connectionId: "t1", path: "audit.md" });
  fs.writeFileSync(session.filePath, "a2\n");
  const longMessage = `${"稽核".repeat(60)}結尾`; // 122 字
  await commitEdit(session.id, longMessage);

  const lines = fs
    .readFileSync(path.join(process.env.SVN_EDIT_TEMP_DIR, "audit.log"), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((r) => r.id === session.id);
  assert.deepEqual(lines.map((r) => r.op), ["open", "commit"]);
  const commitRecord = lines[1];
  assert.equal(commitRecord.ok, true);
  assert.equal(commitRecord.messageLength, longMessage.length);
  assert.equal(commitRecord.messagePreview, longMessage.slice(0, 80));
  assert.equal(JSON.stringify(commitRecord).includes("結尾"), false);
});
