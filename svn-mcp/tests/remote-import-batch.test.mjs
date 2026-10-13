// 批次上傳（多檔案／整個資料夾，可覆蓋同名檔案）：用本機臨時 SVN 儲存庫（svnadmin + file://），不連任何真實 SVN。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EditError } from "../dist/remote-edit-client.js";
import { cancelImport, commitImport, planImport, stageImportFile, startImportBatch } from "../dist/remote-import-batch.js";
import { createEditServer } from "../dist/edit-server.js";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "svn-batch-test-")));
const repoDir = path.join(root, "repo");
const connFile = path.join(root, "connections.json");
const svn = (...args) => execFileSync("svn", [...args, "--non-interactive"], { encoding: "utf-8" });

execFileSync("svnadmin", ["create", repoDir]);
const repoUrl = pathToFileURL(repoDir).href;
fs.writeFileSync(connFile, JSON.stringify([{ id: "t1", name: "test", url: repoUrl, username: "u", password: "p" }]));
process.env.SVN_CONNECTIONS_FILE = connFile;
process.env.SVN_EDIT_TEMP_DIR = path.join(root, "edit-tmp");
process.env.SVN_EDIT_NO_LAUNCH = "1";

const remoteCat = (rel) => svn("cat", `${repoUrl}/${rel}`).replaceAll("\r\n", "\n");
const youngest = () => Number(svn("info", "--show-item", "revision", repoUrl).trim());
const propget = (name, rel) => {
  try {
    return execFileSync("svn", ["propget", name, `${repoUrl}/${rel}`, "--non-interactive"], { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
};
const batchDirs = () => (fs.existsSync(process.env.SVN_EDIT_TEMP_DIR) ? fs.readdirSync(process.env.SVN_EDIT_TEMP_DIR).filter((n) => n.startsWith("batch-")) : []);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

async function assertEditError(promise, code, pattern) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof EditError, `應該是 EditError，實際：${err?.constructor?.name}：${err?.message}`);
    assert.equal(err.code, code, err.message);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

async function stageAll(files) {
  const { batch } = await startImportBatch();
  for (const [rel, text] of Object.entries(files)) await stageImportFile(batch, rel, Buffer.from(text));
  return batch;
}

test("整個資料夾：多層子資料夾一次進庫，只產生一個 revision，中間資料夾自動建立", async () => {
  const before = youngest();
  const batch = await stageAll({ "專案/readme.md": "# 專案\n", "專案/src/a.txt": "aaa\n", "專案/src/deep/b.txt": "bbb\n", "專案/規格.docx": "PK-fake" });
  const plan = await planImport({ batch, connectionId: "t1", targetDir: "上傳測試/第一批" });
  assert.equal(plan.add.length, 4);
  assert.equal(plan.overwrite.length, 0);
  const result = await commitImport({ batch, connectionId: "t1", targetDir: "上傳測試/第一批", message: "[GV-9] 上傳整個資料夾" });
  assert.equal(result.added, 4);
  assert.equal(result.modified, 0);
  assert.equal(youngest(), before + 1, "多個檔案只該有一個 commit");
  assert.equal(remoteCat("上傳測試/第一批/專案/src/deep/b.txt"), "bbb\n");
  assert.equal(remoteCat("上傳測試/第一批/專案/readme.md"), "# 專案\n");
  assert.equal(propget("svn:needs-lock", "上傳測試/第一批/專案/規格.docx"), "*");
  assert.match(svn("log", "--xml", "-l", "1", repoUrl), /\[GV-9\] 上傳整個資料夾/);
  assert.deepEqual(batchDirs(), [], "成功後暫存資料夾要清乾淨");
});

test("放進已存在的目錄：新檔案新增、同名檔案更新成新版本、內容相同的不產生變更", async () => {
  const batch = await stageAll({ "專案/readme.md": "# 專案（改過）\n", "專案/src/a.txt": "aaa\n", "專案/src/new.txt": "new\n", "專案/新資料夾/c.txt": "ccc\n" });
  const plan = await planImport({ batch, connectionId: "t1", targetDir: "上傳測試/第一批" });
  assert.deepEqual(plan.overwrite.sort(), ["專案/readme.md", "專案/src/a.txt"]);
  assert.deepEqual(plan.add.sort(), ["專案/src/new.txt", "專案/新資料夾/c.txt"]);

  const before = youngest();
  const result = await commitImport({ batch, connectionId: "t1", targetDir: "上傳測試/第一批", message: "更新與新增" });
  assert.equal(result.added, 2);
  assert.equal(result.modified, 1, "只有 readme.md 內容有變");
  assert.equal(result.unchanged, 1, "a.txt 內容相同");
  assert.equal(youngest(), before + 1);
  assert.equal(remoteCat("上傳測試/第一批/專案/readme.md"), "# 專案（改過）\n");
  assert.equal(remoteCat("上傳測試/第一批/專案/src/a.txt"), "aaa\n");
  assert.equal(remoteCat("上傳測試/第一批/專案/新資料夾/c.txt"), "ccc\n");
  assert.equal(remoteCat("上傳測試/第一批/專案/src/deep/b.txt"), "bbb\n", "沒有包含在這次上傳的遠端檔案不受影響");
});

test("needs-lock 的檔案（docx）可以被覆蓋成新版本", async () => {
  const batch = await stageAll({ "專案/規格.docx": "PK-fake-v2" });
  const result = await commitImport({ batch, connectionId: "t1", targetDir: "上傳測試/第一批", message: "更新規格" });
  assert.equal(result.modified, 1);
  assert.equal(remoteCat("上傳測試/第一批/專案/規格.docx"), "PK-fake-v2");
  assert.equal(propget("svn:needs-lock", "上傳測試/第一批/專案/規格.docx"), "*");
});

test("全部內容都跟 SVN 一樣：拒絕（NO_CHANGES），不產生空 commit，暫存檔保留可重試", async () => {
  const before = youngest();
  const batch = await stageAll({ "專案/src/a.txt": "aaa\n" });
  await assertEditError(commitImport({ batch, connectionId: "t1", targetDir: "上傳測試/第一批", message: "沒改" }), "NO_CHANGES");
  assert.equal(youngest(), before);
  assert.ok(batchDirs().length >= 1);
  await cancelImport(batch);
});

test("直接放進連線根目錄（目標資料夾留空）", async () => {
  const batch = await stageAll({ "根目錄檔案.txt": "root\n" });
  const result = await commitImport({ batch, connectionId: "t1", targetDir: "", message: "放根目錄" });
  assert.equal(result.added, 1);
  assert.equal(remoteCat("根目錄檔案.txt"), "root\n");
});

test("暫存檔、系統檔、版本控制資料夾一律拒絕", async () => {
  const { batch } = await startImportBatch();
  for (const bad of ["~$文件.docx", "資料夾/Thumbs.db", ".git/config", "a/.svn/entries", ".DS_Store", "資料夾/.~lock.x.docx#"]) {
    await assertEditError(stageImportFile(batch, bad, Buffer.from("x")), "INVALID_INPUT");
  }
  await cancelImport(batch);
});

test("路徑安全：.. 、完整 URL、不允許的字元、空檔案、過大檔案都拒絕", async () => {
  const { batch } = await startImportBatch();
  await assertEditError(stageImportFile(batch, "../evil.txt", Buffer.from("x")), "INVALID_INPUT", /\.\./);
  await assertEditError(stageImportFile(batch, "file:///etc/x.txt", Buffer.from("x")), "INVALID_INPUT");
  await assertEditError(stageImportFile(batch, "a?b.txt", Buffer.from("x")), "INVALID_INPUT");
  await assertEditError(stageImportFile(batch, "空.txt", Buffer.alloc(0)), "INVALID_INPUT");
  await assertEditError(stageImportFile(batch, "大.bin", Buffer.alloc(50 * 1024 * 1024 + 1)), "FILE_TOO_LARGE");
  await stageImportFile(batch, "ok.txt", Buffer.from("x"));
  await assertEditError(planImport({ batch, connectionId: "t1", targetDir: "../外面" }), "INVALID_INPUT", /\.\./);
  await assertEditError(commitImport({ batch, connectionId: "t1", targetDir: "x", message: "   " }), "INVALID_INPUT", /commit message/);
  await assertEditError(stageImportFile("not-a-uuid", "a.txt", Buffer.from("x")), "INVALID_INPUT");
  await cancelImport(batch);
});

test("遠端同名的是資料夾：拒絕並說明", async () => {
  const batch = await stageAll({ "專案": "我是檔案" });
  await assertEditError(commitImport({ batch, connectionId: "t1", targetDir: "上傳測試/第一批", message: "衝突" }), "INVALID_INPUT", /資料夾/);
  await cancelImport(batch);
});

test("取消：清掉暫存；找不到批次回 NOT_FOUND", async () => {
  const { batch } = await startImportBatch();
  await stageImportFile(batch, "a.txt", Buffer.from("x"));
  await cancelImport(batch);
  await assertEditError(planImport({ batch, connectionId: "t1", targetDir: "" }), "NOT_FOUND");
  assert.ok(!batchDirs().some((n) => n.includes(batch)));
});

// ---- 透過 HTTP API ----
const edit = createEditServer();
await new Promise((resolve) => edit.server.listen(0, "127.0.0.1", resolve));
const port = edit.server.address().port;
test.after(() => edit.server.close());

function call(method, pathAndQuery, body, { token = edit.token } = {}) {
  return new Promise((resolve, reject) => {
    const isRaw = Buffer.isBuffer(body);
    const payload = isRaw ? body : body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1", port, method, path: pathAndQuery,
        headers: { ...(token ? { "X-Edit-Token": token } : {}), "Content-Type": isRaw ? "application/octet-stream" : "application/json", "Content-Length": payload.length },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}") }));
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

test("HTTP：start → stage（保留相對路徑）→ plan → commit 整條流程；沒有 token 回 401", async () => {
  assert.equal((await call("POST", "/api/import/start", {}, { token: null })).status, 401);
  const { json: started } = await call("POST", "/api/import/start", {});
  const batch = started.batch;
  assert.match(batch, /^[0-9a-f-]{36}$/);
  const q = (rel) => `/api/import/stage?${new URLSearchParams({ batch, path: rel })}`;
  assert.equal((await call("POST", q("網頁/資料夾/一.txt"), Buffer.from("一"))).status, 200);
  assert.equal((await call("POST", q("網頁/二.md"), Buffer.from("# 二\n"))).status, 200);
  assert.equal((await call("POST", q("../逃逸.txt"), Buffer.from("x"))).status, 400);

  const plan = await call("POST", "/api/import/plan", { batch, connection: "test", targetDir: "網頁上傳" });
  assert.equal(plan.status, 200);
  assert.equal(plan.json.add.length, 2);

  assert.equal((await call("POST", "/api/import/commit", { batch, connection: "test", targetDir: "網頁上傳", message: "" })).status, 400);
  const done = await call("POST", "/api/import/commit", { batch, connection: "test", targetDir: "網頁上傳", message: "[GV-3] 網頁批次上傳", ticket: "GV-3" });
  assert.equal(done.status, 200);
  assert.equal(done.json.added, 2);
  assert.equal(remoteCat("網頁上傳/網頁/資料夾/一.txt"), "一");
});

// ---- 缺口：覆蓋時比對「遠端是否比使用者的本機檔案新」----
test("覆蓋明細：列出遠端最後修改的版本與作者；本機檔案比遠端舊時標示 remoteNewer", async () => {
  const first = await startImportBatch();
  await stageImportFile(first.batch, "a.txt", Buffer.from("v1\n"));
  const committed = await commitImport({ batch: first.batch, connectionId: "t1", targetDir: "缺口測試", message: "建立 a.txt" });

  const HOUR = 3600 * 1000;
  // 本機檔案是 1 小時前改的（比遠端剛提交的版本舊）→ 遠端較新
  const stale = await startImportBatch();
  await stageImportFile(stale.batch, "a.txt", Buffer.from("v2 本機舊檔\n"), Date.now() - HOUR);
  const stalePlan = await planImport({ batch: stale.batch, connectionId: "t1", targetDir: "缺口測試" });
  assert.deepEqual(stalePlan.overwrite, ["a.txt"]);
  const d = stalePlan.overwriteDetails[0];
  assert.equal(d.path, "a.txt");
  assert.equal(d.remoteRevision, committed.committedRevision, "遠端最後修改的版本號");
  assert.ok(typeof d.remoteAuthor === "string" && d.remoteAuthor.length > 0, "遠端作者");
  assert.ok(Date.parse(d.remoteDate) > 0, "遠端修改時間");
  assert.ok(Date.parse(d.localModified) > 0, "本機修改時間有帶進來");
  assert.equal(d.remoteNewer, true, "本機檔案比遠端舊，要警告");
  await cancelImport(stale.batch);

  // 本機檔案是剛剛才改的（比遠端新）→ 不警告
  const fresh = await startImportBatch();
  await stageImportFile(fresh.batch, "a.txt", Buffer.from("v2 新改的\n"), Date.now() + 2 * 60 * 1000);
  const freshPlan = await planImport({ batch: fresh.batch, connectionId: "t1", targetDir: "缺口測試" });
  assert.equal(freshPlan.overwriteDetails[0].remoteNewer, false);
  await cancelImport(fresh.batch);

  // 沒提供本機修改時間（例如拖曳來源不給）→ 不知道就不誤報
  const unknown = await startImportBatch();
  await stageImportFile(unknown.batch, "a.txt", Buffer.from("v2 不知道\n"));
  const unknownPlan = await planImport({ batch: unknown.batch, connectionId: "t1", targetDir: "缺口測試" });
  assert.equal(unknownPlan.overwriteDetails[0].localModified, null);
  assert.equal(unknownPlan.overwriteDetails[0].remoteNewer, false);
  await cancelImport(unknown.batch);
});

test("新增的檔案沒有覆蓋明細；覆蓋明細數量與 overwrite 一致", async () => {
  const { batch } = await startImportBatch();
  await stageImportFile(batch, "a.txt", Buffer.from("again\n"), Date.now());
  await stageImportFile(batch, "全新檔案.txt", Buffer.from("new\n"), Date.now());
  const plan = await planImport({ batch, connectionId: "t1", targetDir: "缺口測試" });
  assert.deepEqual(plan.add, ["全新檔案.txt"]);
  assert.deepEqual(plan.overwriteDetails.map((x) => x.path), plan.overwrite);
  await cancelImport(batch);
});

test("HTTP：stage 的 mtime 參數會進到 plan 的 remoteNewer 判斷", async () => {
  const { json: started } = await call("POST", "/api/import/start", {});
  const batch = started.batch;
  const q = (rel, mtime) => `/api/import/stage?${new URLSearchParams({ batch, path: rel, mtime: String(mtime) })}`;
  assert.equal((await call("POST", q("a.txt", 1000), Buffer.from("太舊的檔案\n"))).status, 200); // 1970 年
  const plan = await call("POST", "/api/import/plan", { batch, connection: "test", targetDir: "缺口測試" });
  assert.equal(plan.status, 200);
  assert.equal(plan.json.overwriteDetails[0].remoteNewer, true);
  assert.match(plan.json.overwriteDetails[0].localModified, /^1970-/);
  await call("POST", "/api/import/cancel", { batch });
});
