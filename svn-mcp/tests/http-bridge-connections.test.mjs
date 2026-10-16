// svn-mcp HTTP bridge：連線資料只存在 svn-mcp。claudeweb 列連線（不含帳密）、以 connectionId 呼叫 /run，帳密不離開這個行程。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "svn-bridge-conn-test-")));
const file = path.join(root, "svn-connections.json");
const PASSWORD = "TOP-SECRET-PW";
fs.writeFileSync(
  file,
  JSON.stringify({
    _readme: ["測試用"],
    version: 2,
    accounts: [
      {
        id: "acct1", name: "測試帳號", url: "https://svn.example.invalid/svn", username: "tester", password: PASSWORD, kind: "server",
        aliases: {}, legacyIds: { oldid42: "billing-repo" },
      },
    ],
    repoCache: { acct1: { repos: ["order-repo", "billing-repo"], fetchedAt: new Date().toISOString() } },
    prefs: { starred: [], recent: {}, nicknames: { "billing-repo": "帳務" }, folders: {}, folderNicknames: {} },
  })
);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(here, "..", "dist", "http-server.js")], {
  env: { ...process.env, SVN_CONNECTIONS_FILE: file, SVN_MCP_HTTP_PORT: String(port), SVN_BRIDGE_TOKEN: "" , SVN_EDIT_AUTOSTART: "0" },
  stdio: ["ignore", "ignore", "ignore"],
});
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${base}/health`)).ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

test.after(() => {
  child.kill();
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (body) => fetch(`${base}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("GET /connections：每個 repo 一筆，沒有帳密欄位也沒有密碼內容", async () => {
  const res = await fetch(`${base}/connections`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text.includes(PASSWORD), false);
  assert.equal(text.includes("tester"), false);
  const list = JSON.parse(text);
  assert.deepEqual(list.map((c) => c.name).sort(), ["billing-repo", "order-repo"]);
  assert.equal(list.find((c) => c.name === "billing-repo").url, "https://svn.example.invalid/svn/billing-repo");
  assert.equal(list.find((c) => c.name === "billing-repo").nickname, "帳務");
});

test("GET /connection?id=：舊 id、名稱、簡稱都解析到同一個 repo；找不到回 404", async () => {
  for (const id of ["oldid42", "billing-repo", "帳務"]) {
    const res = await fetch(`${base}/connection?id=${encodeURIComponent(id)}`);
    assert.equal(res.status, 200, id);
    assert.equal((await res.json()).name, "billing-repo", id);
  }
  assert.equal((await fetch(`${base}/connection?id=nope`)).status, 404);
});

test("POST /run + connectionId：連線不存在 → 404", async () => {
  const res = await post({ connectionId: "nope", args: ["info", "https://svn.example.invalid/svn/order-repo"] });
  assert.equal(res.status, 404);
});

test("POST /run + connectionId：URL 不在該連線底下 → 403（帳密不能拿去打別的主機）", async () => {
  const res = await post({ connectionId: "order-repo", args: ["info", "https://evil.example.invalid/svn/order-repo"] });
  assert.equal(res.status, 403);
  // 同一個帳號底下的「另一個 repo」也不行：帳密綁定在被指定的那個連線上
  const other = await post({ connectionId: "order-repo", args: ["info", "https://svn.example.invalid/svn/billing-repo"] });
  assert.equal(other.status, 403);
});

test("POST /run + connectionId：args 自帶 --username／--password → 400", async () => {
  const res = await post({ connectionId: "order-repo", args: ["info", "https://svn.example.invalid/svn/order-repo", "--password", "x"] });
  assert.equal(res.status, 400);
});

test("POST /run + connectionId：只允許唯讀子命令（commit → 403）", async () => {
  const res = await post({ connectionId: "order-repo", args: ["commit", "-m", "x", "https://svn.example.invalid/svn/order-repo"] });
  assert.equal(res.status, 403);
});

test("POST /run + connectionId：svn 執行失敗時，錯誤訊息不含密碼", { timeout: 60000 }, async () => {
  const res = await post({ connectionId: "order-repo", args: ["info", "https://svn.example.invalid/svn/order-repo"] });
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.equal(text.includes(PASSWORD), false);
});

test("POST /run + connectionId：ls 是唯讀別名，子命令通過白名單（失敗只會是 svn 連線錯誤 500，不是 403）", { timeout: 60000 }, async () => {
  const res = await post({ connectionId: "order-repo", args: ["ls", "--xml", "https://svn.example.invalid/svn/order-repo"] });
  assert.equal(res.status, 500);
});
