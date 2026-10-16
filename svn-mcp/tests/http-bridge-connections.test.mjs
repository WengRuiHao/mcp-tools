// svn-mcp HTTP bridge：連線資料只存在 svn-mcp。claudeweb 列連線（不含帳密）、以 connectionId 呼叫 /run，帳密不離開這個行程。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
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

test("POST /run + connectionId：args 自帶 --username／--password → 403（帳密只由 svn-mcp 附上）", async () => {
  const res = await post({ connectionId: "order-repo", args: ["info", "https://svn.example.invalid/svn/order-repo", "--password", "x"] });
  assert.equal(res.status, 403);
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

const GOOD_URL = "https://svn.example.invalid/svn/order-repo";

test("安全：沒有 connectionId（舊的帳密寫在 args 的形式）→ 400", async () => {
  const res = await post({ args: ["info", GOOD_URL, "--username", "u", "--password", "p"] });
  assert.equal(res.status, 400);
});

test("安全：URL 前綴要有邊界——order-repo 的帳密不能用在 order-repo2、order-repo-evil", async () => {
  for (const url of [GOOD_URL + "2", GOOD_URL + "-evil", GOOD_URL + ".evil.example.invalid"]) {
    assert.equal((await post({ connectionId: "order-repo", args: ["info", url] })).status, 403, url);
  }
});

test("安全：連線底下的子路徑與 @peg 版本號可以通過（不是 403）", { timeout: 60000 }, async () => {
  for (const url of [GOOD_URL, GOOD_URL + "/", GOOD_URL + "/docs/a.docx", GOOD_URL + "/docs/a.docx@12"]) {
    assert.notEqual((await post({ connectionId: "order-repo", args: ["info", url] })).status, 403, url);
  }
});

test("安全：.. 與 %2e%2e 路徑穿越 → 403", async () => {
  for (const url of [GOOD_URL + "/../billing-repo/x", GOOD_URL + "/%2e%2e/billing-repo/x", GOOD_URL + "/a/%2E%2E/%2E%2E/b"]) {
    assert.equal((await post({ connectionId: "order-repo", args: ["cat", url] })).status, 403, url);
  }
});

test("安全：危險選項一律 403（--diff-cmd 會執行任意程式、--config-option/--config-dir 可改設定外洩帳密）", async () => {
  const bad = [
    ["diff", "--diff-cmd", "cmd.exe", GOOD_URL],
    ["diff", "--diff-cmd=calc.exe", GOOD_URL],
    ["diff", "-x", "-w", GOOD_URL],
    ["info", "--config-option", "servers:global:http-proxy-host=evil.invalid", GOOD_URL],
    ["info", "--config-dir", "C:/evil", GOOD_URL],
    ["info", "--trust-server-cert", GOOD_URL],
    ["cat", "--", GOOD_URL],
  ];
  for (const args of bad) assert.equal((await post({ connectionId: "order-repo", args })).status, 403, args.join(" "));
});

test("安全：位置參數必須是 URL——本機路徑 403", async () => {
  for (const target of ["C:/Windows", ["C:", "Users", "x", "wc"].join(String.fromCharCode(92)), "./wc", "file:///C:/x"]) {
    assert.equal((await post({ connectionId: "order-repo", args: ["info", target] })).status, 403, target);
  }
});

test("正常用法：claudeweb 會送的選項組合都放行（不是 403）", { timeout: 120000 }, async () => {
  const ok = [
    ["ls", "--xml", GOOD_URL],
    ["cat", "-r", "HEAD", GOOD_URL + "/a.docx"],
    ["log", "--xml", "-l", "30", GOOD_URL],
    ["diff", "-r", "3:5", GOOD_URL + "/a.md"],
    ["info", "--xml", GOOD_URL],
    ["list", "--revision=HEAD", "--depth=immediates", GOOD_URL],
  ];
  for (const args of ok) assert.notEqual((await post({ connectionId: "order-repo", args })).status, 403, args.join(" "));
});

test("安全：Host 標頭不是本機名稱（DNS rebinding）→ 403；本機名稱正常", async () => {
  const hostStatus = (host) =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, path: "/connections", headers: { Host: host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      r.on("error", reject);
      r.end();
    });
  assert.equal(await hostStatus("evil.example.com"), 403);
  assert.equal(await hostStatus("evil.example.com:" + port), 403);
  assert.equal(await hostStatus("localhost:" + port), 200);
  assert.equal(await hostStatus("127.0.0.1:" + port), 200);
});

test("安全：POST /run 的 Content-Type 不是 application/json → 415（避免跨站表單／text/plain 繞過預檢）", async () => {
  const res = await fetch(`${base}/run`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ connectionId: "order-repo", args: ["info", GOOD_URL] }) });
  assert.equal(res.status, 415);
});
