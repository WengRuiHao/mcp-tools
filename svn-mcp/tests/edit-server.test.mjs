// svn-edit 本機服務：用本機臨時 SVN 儲存庫（svnadmin + file://）驗證 /api/* 流程與安全防護。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createSvnFixture } from "./helpers/svn-fixture.mjs";
import { createEditServer } from "../dist/edit-server.js";
import { startFakeSvnServer } from "./fake-svn-server.mjs";
import { listEdits } from "../dist/remote-edit-client.js";

const { connFile, repoUrl, svn, seed, cleanup } = createSvnFixture({ prefix: "svn-edit-srv-test-", connFile: "info/svn-connections.json", noLaunch: true, autoCleanup: false });

const edit = createEditServer();
await new Promise((resolve) => edit.server.listen(0, "127.0.0.1", resolve));
const port = edit.server.address().port;
const TOKEN = edit.token;
test.after(() => {
  edit.server.close();
  cleanup();
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

test("設定頁 API：新增帳號先測試連線再存進共用的設定檔；回應與狀態都不含密碼；測試、刪除、壞輸入都正確", async () => {
  const original = fs.readFileSync(connFile, "utf-8");
  const fakeServer = await startFakeSvnServer({ repos: ["alpha", "beta"], users: { bob: "pw-123" } });
  try {
    // 密碼錯：回 400、不存檔
    const wrong = await post("/api/servers", { name: "新帳號", url: fakeServer.url, username: "bob", password: "bad" });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error, /帳號或密碼不正確/);
    assert.equal(fs.readFileSync(connFile, "utf-8"), original);

    // 測試連線：只測不存
    const tested = await post("/api/servers/test", { url: fakeServer.url, username: "bob", password: "pw-123" });
    assert.equal(tested.status, 200);
    assert.deepEqual(tested.json.test, { repoCount: 2, auth: "credentials" });
    assert.equal(fs.readFileSync(connFile, "utf-8"), original);

    // 新增
    const added = await post("/api/servers", { name: "新帳號", url: fakeServer.url, username: "bob", password: "pw-123" });
    assert.equal(added.status, 200);
    assert.equal(added.text.includes("pw-123"), false);
    assert.equal(added.json.server.repoCount, 2);
    const state = (await call("GET", "/api/state")).json;
    assert.equal(state.servers.some((sv) => sv.name === "新帳號"), true);
    assert.equal(state.connections.some((c) => c.name === "alpha"), true);
    assert.equal(JSON.stringify(state).includes("pw-123"), false);
    const saved = JSON.parse(fs.readFileSync(connFile, "utf-8")).accounts.find((c) => c.name === "新帳號");
    assert.equal(saved.password, "pw-123");
    assert.equal("repos" in saved, false, "連線檔只存帳號，不存 repo 清單");

    // 刪除
    const deleted = await post("/api/servers/delete", { id: saved.id });
    assert.equal(deleted.status, 200);
    assert.equal((await call("GET", "/api/state")).json.servers.some((sv) => sv.name === "新帳號"), false);
    assert.equal((await post("/api/servers/delete", { id: saved.id })).status, 400);

    // 舊的單一 repo 連線 API 已移除
    assert.equal((await post("/api/connections", { name: "x", url: "https://svn.example.com/r", username: "u", password: "p" })).status, 404);
  } finally {
    await fakeServer.close();
    fs.writeFileSync(connFile, original);
  }
});

test("伺服器 API：壞網址回 400、不存檔；狀態有 servers 欄位；找不到的伺服器回 400", async () => {
  const before = fs.readFileSync(connFile, "utf-8");
  const bad = await post("/api/servers", { url: "file:///c:/x", username: "u", password: "p" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "INVALID_INPUT");
  assert.equal(fs.readFileSync(connFile, "utf-8"), before);
  const missing = await post("/api/servers/refresh", { id: "nope" });
  assert.equal(missing.status, 400);
  assert.deepEqual((await call("GET", "/api/state")).json.servers, []);
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

function postRaw(route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method: "POST", headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end("{}");
  });
}

test("視窗關閉通知：沒帶 token 會被拒絕、不會觸發監聽者", async () => {
  let called = 0;
  edit.onWindowClosing(() => called++);
  assert.equal(await postRaw("/api/window-closing"), 401);
  assert.equal(called, 0);
});

test("視窗關閉通知：帶 token 會通知監聽者，處理完 inflight 歸零", async () => {
  let called = 0;
  edit.onWindowClosing(() => called++);
  assert.equal(await postRaw("/api/window-closing", { "X-Edit-Token": TOKEN }), 200);
  assert.equal(called, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(edit.inflight(), 0);
});

test("專案偏好 API：星星、排序、最近、簡稱都存得起來，狀態帶回整份偏好；壞輸入回 400；要 token", async () => {
  const star = async (name, starred) => (await post("/api/repo-prefs/star", { name, starred })).json.prefs;
  await star("alpha", true);
  await star("beta", true);
  await star("gamma", true);
  const reordered = await post("/api/repo-prefs/reorder", { order: ["gamma", "alpha", "beta"] });
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.json.prefs.starred, ["gamma", "alpha", "beta"]);
  assert.equal((await post("/api/repo-prefs/open", { name: "alpha" })).json.prefs.recent.alpha.length > 10, true);
  assert.equal((await post("/api/repo-prefs/nickname", { name: "beta", nickname: " 乙 " })).json.prefs.nicknames.beta, "乙");

  const state = (await call("GET", "/api/state")).json;
  assert.deepEqual(state.repoPrefs.starred, ["gamma", "alpha", "beta"]);
  assert.equal(state.repoPrefs.nicknames.beta, "乙");
  assert.deepEqual((await star("alpha", false)).starred, ["gamma", "beta"]);

  const bad = await post("/api/repo-prefs/star", { name: "", starred: true });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "INVALID_INPUT");
  assert.equal((await post("/api/repo-prefs/nickname", { name: "beta", nickname: "x".repeat(31) })).status, 400);
  assert.equal((await post("/api/repo-prefs/reorder", { order: "nope" })).status, 400);

  const noToken = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/repo-prefs/star", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end(JSON.stringify({ name: "x", starred: true }));
  });
  assert.equal(noToken, 401);
});

test("常用目錄 API：加、拿掉、狀態帶回；每個專案各自一份；壞輸入回 400", async () => {
  const add = (repo, p, starred = true) => post("/api/repo-prefs/folder", { repo, path: p, starred });
  assert.equal((await add("規格庫", "3-SD/9-SOURCE")).json.prefs.folders["規格庫"][0], "3-SD/9-SOURCE");
  await add("規格庫", "2-SA");
  await add("另一個", "docs");
  const state = (await call("GET", "/api/state")).json;
  assert.deepEqual(state.repoPrefs.folders, { 規格庫: ["3-SD/9-SOURCE", "2-SA"], 另一個: ["docs"] });
  assert.deepEqual((await add("規格庫", "2-SA", false)).json.prefs.folders["規格庫"], ["3-SD/9-SOURCE"]);
  for (const bad of [{ repo: "", path: "x" }, { repo: "p", path: "" }, { repo: "p", path: "../x" }, { repo: "p", path: "a:b" }]) {
    const r = await post("/api/repo-prefs/folder", { ...bad, starred: true });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.code, "INVALID_INPUT");
  }
});

test("常用目錄暱稱 API：存得起來、狀態帶回；不是常用目錄回 400；拿掉常用目錄暱稱跟著消失", async () => {
  await post("/api/repo-prefs/folder", { repo: "暱稱專案", path: "x/y", starred: true });
  const named = await post("/api/repo-prefs/folder-nickname", { repo: "暱稱專案", path: "x/y", nickname: "好認的名字" });
  assert.equal(named.status, 200);
  assert.equal(named.json.prefs.folderNicknames["暱稱專案"]["x/y"], "好認的名字");
  assert.equal((await call("GET", "/api/state")).json.repoPrefs.folderNicknames["暱稱專案"]["x/y"], "好認的名字");

  const notFav = await post("/api/repo-prefs/folder-nickname", { repo: "暱稱專案", path: "不是常用", nickname: "x" });
  assert.equal(notFav.status, 400);
  assert.equal(notFav.json.code, "INVALID_INPUT");
  assert.equal((await post("/api/repo-prefs/folder-nickname", { repo: "暱稱專案", path: "x/y", nickname: "x".repeat(31) })).status, 400);

  const removed = await post("/api/repo-prefs/folder", { repo: "暱稱專案", path: "x/y", starred: false });
  assert.equal("暱稱專案" in removed.json.prefs.folderNicknames, false);
});
