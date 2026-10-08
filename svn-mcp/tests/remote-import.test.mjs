// 新增檔案到 SVN（svn import）：用本機臨時 SVN 儲存庫（svnadmin + file://），不連任何真實 SVN。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { importNewFile, openEdit, discardEdit, EditError } from "../dist/remote-edit-client.js";
import { createEditServer } from "../dist/edit-server.js";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "svn-import-test-")));
const repoDir = path.join(root, "repo");
const connFile = path.join(root, "connections.json");
const svn = (...args) => execFileSync("svn", [...args, "--non-interactive"], { encoding: "utf-8" });

execFileSync("svnadmin", ["create", repoDir]);
const repoUrl = pathToFileURL(repoDir).href;
fs.writeFileSync(connFile, JSON.stringify([{ id: "t1", name: "test", url: repoUrl, username: "u", password: "p" }]));
process.env.SVN_CONNECTIONS_FILE = connFile;
process.env.SVN_EDIT_TEMP_DIR = path.join(root, "edit-tmp");
process.env.SVN_EDIT_NO_LAUNCH = "1";

// eol-style=native 的檔案在 Windows 上 svn cat 會轉成 CRLF（倉庫裡存的是 LF），所以比對前先正規化換行
const remoteCat = (rel) => svn("cat", `${repoUrl}/${rel}`).replaceAll("\r\n", "\n");
const propget = (name, rel) => {
  try {
    return execFileSync("svn", ["propget", name, `${repoUrl}/${rel}`, "--non-interactive"], { encoding: "utf-8" }).trim();
  } catch {
    return null; // 沒有這個屬性
  }
};
const baseDirEntries = () => (fs.existsSync(process.env.SVN_EDIT_TEMP_DIR) ? fs.readdirSync(process.env.SVN_EDIT_TEMP_DIR).filter((n) => n.startsWith("import-")) : []);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

async function assertEditError(promise, code, pattern) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof EditError, `應該是 EditError，實際：${err?.constructor?.name}：${err?.message}`);
    assert.equal(err.code, code, err.message);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

test("新增 md：自動建立不存在的資料夾，內容正確，並設定 eol-style=native", async () => {
  const result = await importNewFile({ connectionId: "t1", path: "new/dir/說明.md", content: Buffer.from("# 新檔案\n"), message: "[GV-1] 新增說明", ticket: "GV-1" });
  assert.ok(result.committedRevision >= 1);
  assert.equal(remoteCat("new/dir/" + "說明.md"), "# 新檔案\n");
  assert.equal(propget("svn:eol-style", "new/dir/說明.md"), "native");
  assert.equal(propget("svn:needs-lock", "new/dir/說明.md"), null);
  assert.match(svn("log", "--xml", "-l", "1", repoUrl), /\[GV-1\] 新增說明/);
  assert.deepEqual(baseDirEntries(), []); // 暫存資料夾清乾淨
});

test("新增 docx、xlsx：設定 needs-lock（檔案無法合併，編輯前要先鎖定）", async () => {
  await importNewFile({ connectionId: "t1", path: "規格書/需求.docx", content: Buffer.from("PK-fake-docx"), message: "新增需求書" });
  await importNewFile({ connectionId: "t1", path: "規格書/對照表.xlsx", content: Buffer.from("PK-fake-xlsx"), message: "新增對照表" });
  assert.equal(propget("svn:needs-lock", "規格書/需求.docx"), "*");
  assert.equal(propget("svn:needs-lock", "規格書/對照表.xlsx"), "*");
  assert.equal(propget("svn:eol-style", "規格書/需求.docx"), null);
});

test("新增的檔案馬上就能走編輯流程（取出、上鎖）", async () => {
  const session = await openEdit({ connectionId: "t1", path: "規格書/需求.docx" });
  assert.equal(session.locked, true);
  await discardEdit(session.id);
});

test("二進位內容原封不動（不被當成文字轉換）", async () => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x80, 0x00]);
  await importNewFile({ connectionId: "t1", path: "bin.docx", content: bytes, message: "binary" });
  const out = execFileSync("svn", ["cat", `${repoUrl}/bin.docx`, "--non-interactive"]);
  assert.deepEqual(Buffer.from(out), bytes);
});

test("遠端已有同名檔案：拒絕，不覆蓋", async () => {
  await importNewFile({ connectionId: "t1", path: "exists.md", content: Buffer.from("original\n"), message: "first" });
  await assertEditError(importNewFile({ connectionId: "t1", path: "exists.md", content: Buffer.from("overwrite\n"), message: "second" }), "ALREADY_EXISTS", /不會覆蓋/);
  assert.equal(remoteCat("exists.md"), "original\n");
});

test("不合法的輸入一律拒絕，且不留暫存", async () => {
  const ok = { connectionId: "t1", path: "fine.md", content: Buffer.from("x\n"), message: "m" };
  await assertEditError(importNewFile({ ...ok, message: "  " }), "INVALID_INPUT", /message/);
  await assertEditError(importNewFile({ ...ok, message: "x".repeat(4001) }), "INVALID_INPUT", /太長/);
  await assertEditError(importNewFile({ ...ok, path: "../out.md" }), "INVALID_INPUT", /\.\./);
  await assertEditError(importNewFile({ ...ok, path: "tool.exe" }), "INVALID_INPUT", /不支援/);
  await assertEditError(importNewFile({ ...ok, content: Buffer.alloc(0) }), "INVALID_INPUT", /空的/);
  await assertEditError(importNewFile({ ...ok, content: "not a buffer" }), "INVALID_INPUT");
  await assertEditError(importNewFile({ ...ok, path: "file:///c:/x.md" }), "INVALID_INPUT", /不允許的字元/); // 完整 URL 不允許
  await assertEditError(importNewFile({ ...ok, path: "a/b:c/x.md" }), "INVALID_INPUT", /不允許的字元/);
  await assertEditError(importNewFile({ ...ok, path: "a/what?.md" }), "INVALID_INPUT", /不允許的字元/);
  assert.deepEqual(baseDirEntries(), []);
  assert.throws(() => svn("info", `${repoUrl}/fine.md`)); // 都沒有真的進庫
});

test("稽核紀錄：新增動作留一行，訊息只記長度與前 80 字", async () => {
  const message = `${"稽核".repeat(60)}結尾`;
  await importNewFile({ connectionId: "t1", path: "audit-import.md", content: Buffer.from("a\n"), message, ticket: "GV-7" });
  const records = fs.readFileSync(path.join(process.env.SVN_EDIT_TEMP_DIR, "audit.log"), "utf-8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.op === "import" && r.path === "audit-import.md");
  assert.equal(records.length, 1);
  assert.equal(records[0].ticket, "GV-7");
  assert.equal(records[0].messageLength, message.length);
  assert.equal(JSON.stringify(records[0]).includes("結尾"), false);
});

// ---- 透過 HTTP API 上傳 ----
const edit = createEditServer();
await new Promise((resolve) => edit.server.listen(0, "127.0.0.1", resolve));
const port = edit.server.address().port;
test.after(() => edit.server.close());

function upload(query, body, { token = edit.token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(query).toString();
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: `/api/import?${qs}`, headers: { ...(token ? { "X-Edit-Token": token } : {}), "Content-Type": "application/octet-stream", "Content-Length": body.length, ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}") }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("HTTP：上傳新檔案成功；重複、缺少 token、缺少訊息各回對應狀態", async () => {
  const body = Buffer.from("# 從網頁上傳\n");
  const ok = await upload({ connection: "test", path: "web/upload.md", message: "[GV-2] 網頁上傳", ticket: "GV-2" }, body);
  assert.equal(ok.status, 200);
  assert.equal(remoteCat("web/upload.md"), "# 從網頁上傳\n");

  const dup = await upload({ connection: "test", path: "web/upload.md", message: "again" }, body);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, "ALREADY_EXISTS");

  assert.equal((await upload({ connection: "test", path: "web/x.md", message: "m" }, body, { token: null })).status, 401);
  assert.equal((await upload({ connection: "test", path: "web/x.md", message: "m" }, body, { headers: { Origin: "http://evil.example" } })).status, 403);
  const noMsg = await upload({ connection: "test", path: "web/y.md" }, body);
  assert.equal(noMsg.status, 400);
  assert.equal(noMsg.json.code, "INVALID_INPUT");
  assert.throws(() => svn("info", `${repoUrl}/web/y.md`));
});
