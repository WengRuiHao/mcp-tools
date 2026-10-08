// svn-edit 本機服務：用本機臨時 SVN 儲存庫（svnadmin + file://）驗證 /api/* 流程與安全防護。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createEditServer } from "../dist/edit-server.js";
import { listEdits } from "../dist/remote-edit-client.js";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "svn-edit-srv-test-")));
const repoDir = path.join(root, "repo");
const connFile = path.join(root, "info", "svn-connections.json");
const svn = (...args) => execFileSync("svn", [...args, "--non-interactive"], { encoding: "utf-8" });

execFileSync("svnadmin", ["create", repoDir]);
const repoUrl = pathToFileURL(repoDir).href;
fs.mkdirSync(path.dirname(connFile), { recursive: true });
fs.writeFileSync(connFile, JSON.stringify([{ id: "t1", name: "test", url: repoUrl, username: "u", password: "p" }]));
process.env.SVN_CONNECTIONS_FILE = connFile;
process.env.SVN_EDIT_TEMP_DIR = path.join(root, "edit-tmp");
process.env.SVN_EDIT_NO_LAUNCH = "1"; // 測試時不要真的打開 Word 或檔案總管

let counter = 0;
function seed(relPath, content) {
  const wc = path.join(root, `seed${counter++}`);
  svn("checkout", repoUrl, wc);
  const abs = path.join(wc, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const existed = fs.existsSync(abs);
  fs.writeFileSync(abs, content);
  if (!existed) svn("add", "--parents", abs);
  svn("commit", "-m", "seed", wc);
}

const edit = createEditServer();
await new Promise((resolve) => edit.server.listen(0, "127.0.0.1", resolve));
const port = edit.server.address().port;
const TOKEN = edit.token;
test.after(() => {
  edit.server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** 底層 http 請求，才能自由指定 Host／Origin 這類 fetch 會限制的標頭。 */
function call(method, urlPath, { token = TOKEN, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { agent: false, host: "127.0.0.1", port, method, path: urlPath, headers: { ...(token ? { "X-Edit-Token": token } : {}), ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // 不是 JSON（例如 HTML 頁面）
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const post = (urlPath, body, opts) => call("POST", urlPath, { ...opts, body });

test("/health 不需要 token", async () => {
  const r = await call("GET", "/health", { token: null });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, service: "svn-edit" });
});

test("GET / 與 GET /edit 回傳嵌了 token 的頁面，且有安全標頭；GET /edit 不會開始編輯", async () => {
  seed("page.md", "page\n");
  for (const url of ["/", "/edit?connection=test&path=page.md&ticket=GV-1"]) {
    const r = await call("GET", url, { token: null });
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /text\/html/);
    assert.ok(r.text.includes(`var TOKEN = "${TOKEN}"`));
    assert.equal(r.text.includes("__EDIT_TOKEN__"), false);
    assert.equal(r.headers["x-frame-options"], "DENY");
    assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/);
  }
  assert.equal((await listEdits()).length, 0); // GET 沒有取出任何檔案
});

test("防護：Host 不對、沒有 token、token 錯誤、Origin 不是自己，一律拒絕", async () => {
  assert.equal((await call("GET", "/api/state", { token: null })).status, 401);
  assert.equal((await call("GET", "/api/state", { token: "wrong" })).status, 401);
  assert.equal((await call("GET", "/api/state", { headers: { Origin: "http://evil.example" } })).status, 403);
  assert.equal((await call("GET", "/api/state", { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await call("GET", "/api/state", { headers: { Host: "evil.example" } })).status, 403);
  assert.equal((await call("GET", "/", { token: null, headers: { Host: `evil.example:${port}` } })).status, 403);
  assert.equal((await call("GET", "/api/open")).status, 404); // 改動狀態的路徑不接受 GET
  assert.equal((await call("GET", "/nope", { token: null })).status, 404);
  assert.equal((await post("/api/nope", {})).status, 404);
  assert.equal((await call("POST", "/api/open", { headers: { "Content-Type": "application/json" }, body: undefined })).status, 400); // 缺少 path
});

test("完整流程：開始編輯 → 狀態 → 上傳，遠端內容更新", async () => {
  seed("flow/spec.md", "v1\n");
  const opened = await post("/api/open", { connection: "test", path: "flow/spec.md", ticket: "GV-9" });
  assert.equal(opened.status, 200);
  const { session } = opened.json;
  assert.equal(session.ticket, "GV-9");
  assert.equal("password" in session, false);

  let state = (await call("GET", "/api/state")).json;
  assert.equal(state.configured, true);
  assert.equal(state.svnAvailable, true);
  assert.equal(state.connections[0].name, "test");
  assert.equal("password" in state.connections[0], false);
  let item = state.sessions.find((s) => s.session.id === session.id);
  assert.equal(item.modified, false);

  fs.writeFileSync(session.filePath, "v2\n");
  state = (await call("GET", "/api/state")).json;
  assert.equal(state.sessions.find((s) => s.session.id === session.id).modified, true);

  const empty = await post("/api/commit", { id: session.id, message: "  " });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.code, "INVALID_INPUT");

  const done = await post("/api/commit", { id: session.id, message: "[GV-9] 更新" });
  assert.equal(done.status, 200);
  assert.ok(done.json.committedRevision > 1);
  assert.equal(svn("cat", `${repoUrl}/flow/spec.md`), "v2\n");
  assert.equal((await call("GET", "/api/state")).json.sessions.some((s) => s.session.id === session.id), false);
});

test("錯誤代碼對應 HTTP 狀態：沒修改 409、遠端被改 409（可下載最新版）、找不到 404、不支援的檔案 400", async () => {
  seed("errs.md", "base\n");
  const { session } = (await post("/api/open", { connection: "test", path: "errs.md" })).json;

  const noChange = await post("/api/commit", { id: session.id, message: "m" });
  assert.equal(noChange.status, 409);
  assert.equal(noChange.json.code, "NO_CHANGES");

  fs.writeFileSync(session.filePath, "mine\n");
  seed("errs.md", "theirs\n");
  const conflict = await post("/api/commit", { id: session.id, message: "m" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, "REMOTE_CHANGED");

  const latest = await post("/api/export-latest", { id: session.id });
  assert.equal(latest.status, 200);
  assert.equal(fs.readFileSync(latest.json.path, "utf-8"), "theirs\n");

  const reopened = await post("/api/reopen", { id: session.id });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json.path, session.filePath);

  assert.equal((await post("/api/discard", { id: session.id })).status, 200);
  assert.equal((await post("/api/discard", { id: session.id })).status, 404);
  assert.equal((await post("/api/open", { connection: "test", path: "tool.exe" })).status, 400);
  assert.equal((await post("/api/open", { connection: "test", path: "missing.md" })).status, 404);
  assert.equal((await post("/api/commit", { id: "../../x", message: "m" })).status, 400);
});

test("錯誤回應不洩漏帳密", async () => {
  fs.writeFileSync(connFile, JSON.stringify([{ id: "bad", name: "bad", url: "https://127.0.0.1:1/none", username: "secret-user", password: "secret-pass" }]));
  const r = await post("/api/open", { connection: "bad", path: "x.md" });
  assert.ok(r.status >= 400);
  assert.equal(r.text.includes("secret-pass"), false);
  fs.writeFileSync(connFile, JSON.stringify([{ id: "t1", name: "test", url: repoUrl, username: "u", password: "p" }]));
});

test("設定頁 API：新增連線寫進共用的設定檔，回應與狀態都不含密碼；壞輸入回 400", async () => {
  const added = await post("/api/connections", { name: "新連線", url: "https://svn.example.com/r", username: "bob", password: "pw-123" });
  assert.equal(added.status, 200);
  assert.equal(added.text.includes("pw-123"), false);
  const state = (await call("GET", "/api/state")).json;
  assert.equal(state.connections.some((c) => c.name === "新連線"), true);
  assert.equal(JSON.stringify(state).includes("pw-123"), false);
  assert.equal(JSON.parse(fs.readFileSync(connFile, "utf-8")).find((c) => c.name === "新連線").password, "pw-123");

  const bad = await post("/api/connections", { name: "壞的", url: "file:///c:/x", username: "u", password: "p" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "INVALID_INPUT");
});

test("設定檔壞掉時 /api/state 仍可用，並回報 connectionsError", async () => {
  const good = fs.readFileSync(connFile, "utf-8");
  fs.writeFileSync(connFile, "{ 壞掉");
  const state = (await call("GET", "/api/state")).json;
  assert.match(state.connectionsError, /不是合法的 JSON/);
  assert.equal(state.configured, false);
  fs.writeFileSync(connFile, good);
});

test("瀏覽遠端目錄：資料夾在前、標示哪些檔案可編輯；拒絕 .. 與不存在的路徑；要 token", async () => {
  seed("browse/b-file.md", "b\n");
  seed("browse/a-file.docx", "a");
  seed("browse/tool.exe", "x");
  seed("browse/sub/c.xlsx", "c");

  const dir = await call("GET", "/api/browse?connection=test&path=browse");
  assert.equal(dir.status, 200);
  assert.equal(dir.json.path, "browse");
  assert.equal(dir.json.connectionName, "test");
  const names = dir.json.entries.map((e) => `${e.kind}:${e.name}`);
  assert.deepEqual(names, ["dir:sub", "file:a-file.docx", "file:b-file.md", "file:tool.exe"]); // 資料夾在前，再依名稱排序
  const byName = Object.fromEntries(dir.json.entries.map((e) => [e.name, e]));
  assert.equal(byName["a-file.docx"].editable, true);
  assert.equal(byName["b-file.md"].editable, true);
  assert.equal(byName["tool.exe"].editable, false); // 不支援的類型
  assert.equal(byName["sub"].editable, false); // 資料夾本身不能編輯

  const sub = await call("GET", "/api/browse?connection=test&path=browse/sub");
  assert.deepEqual(sub.json.entries.map((e) => e.name), ["c.xlsx"]);

  const root = await call("GET", "/api/browse?connection=test");
  assert.equal(root.status, 200);
  assert.equal(root.json.path, "");
  assert.ok(root.json.entries.some((e) => e.name === "browse" && e.kind === "dir"));

  assert.equal((await call("GET", "/api/browse?connection=test&path=../x")).status, 400);
  assert.equal((await call("GET", "/api/browse?connection=test&path=a:b")).status, 400);
  assert.equal((await call("GET", "/api/browse?connection=test&path=no/such/dir")).status, 404);
  assert.equal((await call("GET", "/api/browse?connection=test&path=browse", { token: null })).status, 401);
});

test("沒指定連線、或連線名稱不存在：回 400（輸入問題），不是 500", async () => {
  fs.writeFileSync(connFile, JSON.stringify([
    { id: "t1", name: "test", url: repoUrl, username: "u", password: "p" },
    { id: "t2", name: "second", url: repoUrl, username: "u", password: "p" },
  ]));
  try {
    const noConn = await call("GET", "/api/browse?path=browse");
    assert.equal(noConn.status, 400);
    assert.equal(noConn.json.code, "INVALID_INPUT");
    assert.equal((await call("GET", "/api/browse?connection=nope&path=browse")).status, 400);
    assert.equal((await post("/api/open", { connection: "nope", path: "page.md" })).status, 400);
  } finally {
    fs.writeFileSync(connFile, JSON.stringify([{ id: "t1", name: "test", url: repoUrl, username: "u", password: "p" }]));
  }
});
