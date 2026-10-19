// csv 可編輯（跟 md／txt 一樣不上鎖）、pdf 只能唯讀檢視：用本機臨時 SVN 儲存庫驗證。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createSvnFixture } from "./helpers/svn-fixture.mjs";
import { openEdit, commitEdit, viewRemoteFile, browseRemote, listEdits, EditError, IMPORT_AUTO_PROPS } from "../dist/remote-edit-client.js";

const { repoUrl, svn, seed } = createSvnFixture({ prefix: "svn-csvpdf-test-" });

test("csv：可以開啟、修改、上傳，而且不上鎖", async () => {
  seed("data/list.csv", "a,b\n1,2\n");
  const session = await openEdit({ connectionId: "t1", path: "data/list.csv" });
  assert.equal(session.locked, false);
  fs.writeFileSync(session.filePath, "a,b\n1,2\n3,4\n");
  await commitEdit(session.id, "更新 csv");
  assert.equal(svn("cat", `${repoUrl}/data/list.csv`), "a,b\n1,2\n3,4\n");
  assert.equal((await listEdits()).length, 0);
});

test("pdf：不能走編輯流程（openEdit 拒絕），也不會留下編輯項目", async () => {
  seed("docs/manual.pdf", "%PDF-1.4 fake");
  await assert.rejects(openEdit({ connectionId: "t1", path: "docs/manual.pdf" }), (e) => e instanceof EditError && e.code === "INVALID_INPUT");
  assert.equal((await listEdits()).length, 0);
});

test("pdf：唯讀檢視會匯出最新版到暫存資料夾，遠端完全不變", async () => {
  const before = svn("log", "-q", repoUrl);
  const result = await viewRemoteFile({ connectionId: "t1", path: "docs/manual.pdf" });
  assert.equal(fs.readFileSync(result.path, "utf-8"), "%PDF-1.4 fake");
  assert.ok(result.path.includes(`${path.sep}view-`), "應該放在 view- 開頭的暫存資料夾");
  assert.equal(svn("log", "-q", repoUrl), before);
  assert.equal((await listEdits()).length, 0);
});

test("唯讀檢視：只接受 pdf，其他類型（docx、exe）與不存在的檔案都拒絕", async () => {
  seed("docs/a.docx", "x");
  await assert.rejects(viewRemoteFile({ connectionId: "t1", path: "docs/a.docx" }), (e) => e instanceof EditError && e.code === "INVALID_INPUT");
  await assert.rejects(viewRemoteFile({ connectionId: "t1", path: "docs/run.exe" }), (e) => e instanceof EditError && e.code === "INVALID_INPUT");
  await assert.rejects(viewRemoteFile({ connectionId: "t1", path: "docs/none.pdf" }));
  await assert.rejects(viewRemoteFile({ connectionId: "t1", path: "../etc/x.pdf" }), (e) => e instanceof EditError && e.code === "INVALID_INPUT");
});

test("瀏覽清單：csv 是 editable、pdf 是 viewable 而不是 editable、docx 兩者其一", async () => {
  const r = await browseRemote("t1", "docs");
  const get = (name) => r.entries.find((e) => e.name === name);
  assert.deepEqual([get("manual.pdf").editable, get("manual.pdf").viewable], [false, true]);
  assert.deepEqual([get("a.docx").editable, get("a.docx").viewable], [true, false]);
  const d = await browseRemote("t1", "data");
  assert.deepEqual([d.entries[0].editable, d.entries[0].viewable], [true, false]);
});

test("xls（舊版 Excel）：可以編輯、預設上鎖；新增進庫時自動設成需要先鎖定", async () => {
  seed("sheets/old.xls", "xls-v1");
  const listed = await browseRemote("t1", "sheets");
  const entry = listed.entries.find((e) => e.name === "old.xls");
  assert.deepEqual([entry.editable, entry.viewable], [true, false]);

  const session = await openEdit({ connectionId: "t1", path: "sheets/old.xls" });
  assert.equal(session.locked, true, "跟 xlsx 一樣預設上鎖");
  fs.writeFileSync(session.filePath, "xls-v2");
  await commitEdit(session.id, "更新 xls");
  assert.equal(svn("cat", `${repoUrl}/sheets/old.xls`), "xls-v2");
  assert.equal(IMPORT_AUTO_PROPS.xls, "svn:needs-lock=*", "新增進庫時跟 xlsx 一樣設 needs-lock");
});
