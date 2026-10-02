// 報告上的「SVN 變更」區塊與 bridge 的 /svn/* 端點：用本機臨時 SVN 儲存庫（file://），不連任何真實 SVN。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeTmpDir, removeDir, isolateDataDir } from "./helpers/support.mjs";

const svnAvailable = ["svn", "svnadmin"].every((bin) => spawnSync(bin, ["--version", "--quiet"]).status === 0);
const skip = svnAvailable ? false : "本機沒有 svn／svnadmin，略過需要真實 SVN 的測試";

const data = isolateDataDir();
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dpm-svn-")));
const svn = (...args) => execFileSync("svn", [...args, "--non-interactive"], { encoding: "utf-8" });

const previousEnv = {
  SVN_MCP_PATH: process.env.SVN_MCP_PATH,
  SVN_CONNECTIONS_FILE: process.env.SVN_CONNECTIONS_FILE,
  DEV_PIPELINE_MCP_HTTP_PORT: process.env.DEV_PIPELINE_MCP_HTTP_PORT,
  PIPELINE_ASANA_USER_GID: process.env.PIPELINE_ASANA_USER_GID,
};
// 重建報告會順手查 pipeline 帳號 gid（會 spawn 真的 asana-mcp 子行程、讓測試程序結束不了）；直接指定，不去碰真實 Asana。
process.env.PIPELINE_ASANA_USER_GID = "gid-test-user";
// 指到同一個 repo 底下的 svn-mcp（已 build）；工作副本模組是用動態 import 載入，連線檔用環境變數指向臨時檔。
process.env.SVN_MCP_PATH = path.resolve(import.meta.dirname, "..", "..", "svn-mcp", "dist", "index.js");

test.after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeDir(root);
  data.cleanup();
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

let repoUrl = "";
let wcDir = "";
if (svnAvailable) {
  const repoDir = path.join(root, "repo");
  execFileSync("svnadmin", ["create", repoDir]);
  repoUrl = pathToFileURL(repoDir).href;
  fs.writeFileSync(path.join(root, "connections.json"), JSON.stringify([{ id: "t1", name: "test", url: repoUrl, username: "u", password: "p" }]));
  process.env.SVN_CONNECTIONS_FILE = path.join(root, "connections.json");

  wcDir = path.join(root, "wc");
  svn("checkout", repoUrl, wcDir);
  fs.writeFileSync(path.join(wcDir, "spec.txt"), "v1\n");
  svn("add", path.join(wcDir, "spec.txt"));
  svn("commit", "-m", "seed", wcDir);
}

const PROJECT_NAME = "Svn Test Project";
const PROJECT_FOLDER = "Svn_Test_Project";
const EMPTY_INPUT = {
  awaitingSpecConfirmation: [],
  awaitingConfirmation: [],
  needsHumanReview: [],
  contentChanged: [],
  manualActions: [],
  uncommittedChanges: { registered: false, roots: [] },
};

async function loadModules() {
  const store = await import("../dist/pipeline-store.js");
  const registry = await import("../dist/svn-workcopy-store.js");
  const token = await import("../dist/bridge-token.js");
  return { store, registry, token };
}

const readReport = (projectDir) =>
  fs.readFileSync(path.join(projectDir, ".asana-pipeline", PROJECT_FOLDER, "PENDING_HUMAN_ACTIONS.html"), "utf-8");

test("report without a registered work copy shows the how-to hint", async () => {
  const { store } = await loadModules();
  const projectDir = makeTmpDir("dpm-svn-proj-");
  try {
    await store.writePendingActionsReport(projectDir, PROJECT_NAME, EMPTY_INPUT);
    const html = readReport(projectDir);
    assert.match(html, /register_svn_workcopies/);
    assert.doesNotMatch(html, /data-svn-op="commit"/);
  } finally {
    removeDir(projectDir);
  }
});

test("report lists pending SVN changes with buttons, escaped paths and the bridge token", { skip }, async () => {
  const { store, registry, token } = await loadModules();
  const projectDir = makeTmpDir("dpm-svn-proj-");
  try {
    const wc = path.join(root, "wc-report");
    svn("checkout", repoUrl, wc);
    fs.writeFileSync(path.join(wc, "spec.txt"), "v2\n");
    fs.writeFileSync(path.join(wc, "new&'x.txt"), "n\n");
    fs.writeFileSync(path.join(wc, "~$lock.docx"), "x");
    await registry.registerSvnWorkCopies(projectDir, [{ label: "規格", workCopyPath: wc, connectionId: "t1" }]);

    await store.writePendingActionsReport(projectDir, PROJECT_NAME, EMPTY_INPUT);
    const html = readReport(projectDir);
    assert.match(html, /data-svn-label="規格"/);
    assert.match(html, /data-svn-path="spec\.txt" data-svn-status="modified"/);
    assert.match(html, /data-svn-path="new&amp;&#39;x\.txt" data-svn-status="unversioned"/);
    assert.doesNotMatch(html, /~\$lock/);
    assert.match(html, /data-svn-op="commit"/);
    assert.match(html, /data-svn-op="update"/);
    assert.match(html, new RegExp(`data-bridge-token="${await token.getBridgeToken()}"`));
    assert.doesNotMatch(html, /new&'x/);
  } finally {
    removeDir(projectDir);
  }
});

test("an invalid work copy path shows an error instead of breaking the report", { skip }, async () => {
  const { store, registry } = await loadModules();
  const projectDir = makeTmpDir("dpm-svn-proj-");
  try {
    await registry.registerSvnWorkCopies(projectDir, [{ label: "壞的", workCopyPath: path.join(root, "nope"), connectionId: "t1" }]);
    await store.writePendingActionsReport(projectDir, PROJECT_NAME, EMPTY_INPUT);
    const html = readReport(projectDir);
    assert.match(html, /不是有效的 SVN 工作副本/);
  } finally {
    removeDir(projectDir);
  }
});

test("registry rejects duplicate labels", async () => {
  const { registry } = await loadModules();
  await assert.rejects(
    registry.registerSvnWorkCopies("C:\\x", [
      { label: "A", workCopyPath: "C:\\a", connectionId: "t1" },
      { label: "a", workCopyPath: "C:\\b", connectionId: "t1" },
    ]),
    /重複/
  );
});

test("bridge: svn endpoints require the token, commit end-to-end, audit log written", { skip }, async () => {
  const { registry, token } = await loadModules();
  const { startHttpBridge } = await import("../dist/http-server.js");
  const port = await freePort();
  process.env.DEV_PIPELINE_MCP_HTTP_PORT = String(port);
  const server = startHttpBridge({ exitOnConflict: false });
  await new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));

  const projectDir = makeTmpDir("dpm-svn-proj-");
  try {
    const wc = path.join(root, "wc-bridge");
    svn("checkout", repoUrl, wc);
    fs.writeFileSync(path.join(wc, "spec.txt"), "v3 from web\n");
    fs.writeFileSync(path.join(wc, "規格_新.txt"), "new\n");
    await registry.registerSvnWorkCopies(projectDir, [{ label: "規格", workCopyPath: wc, connectionId: "t1" }]);
    const goodToken = await token.getBridgeToken();
    const base = `http://127.0.0.1:${port}`;
    const post = (route, body, headers = {}) =>
      fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const common = { projectDir, projectName: PROJECT_FOLDER, label: "規格" };

    // 沒 token／錯 token：401，且沒有任何東西被送出
    assert.equal((await post("/svn/commit", { ...common, files: ["spec.txt"], message: "m" })).status, 401);
    assert.equal((await post("/svn/commit", { ...common, files: ["spec.txt"], message: "m" }, { "X-Bridge-Token": "wrong" })).status, 401);
    assert.doesNotMatch(svn("cat", `${repoUrl}/spec.txt`), /from web/);

    // CORS preflight 允許自訂 header（瀏覽器從 file:// 開的報告需要）
    const preflight = await fetch(base + "/svn/commit", { method: "OPTIONS" });
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /X-Bridge-Token/i);

    const auth = { "X-Bridge-Token": goodToken };
    // 沒登記的 label／跳出工作副本的路徑／空訊息：一律拒絕
    assert.equal((await post("/svn/commit", { ...common, label: "不存在", files: ["spec.txt"], message: "m" }, auth)).status, 500);
    const escape = await post("/svn/commit", { ...common, files: ["../evil.txt"], message: "m" }, auth);
    assert.match((await escape.json()).message, /\.\./);
    const noMessage = await post("/svn/commit", { ...common, files: ["spec.txt"], message: "  " }, auth);
    assert.match((await noMessage.json()).message, /message/);

    // diff 看得到內容
    const diff = await (await post("/svn/diff", { ...common, files: ["spec.txt"] }, auth)).json();
    assert.equal(diff.success, true);
    assert.match(diff.text, /\+v3 from web/);

    // 正常 commit（含中文檔名與中文訊息）
    const result = await (await post("/svn/commit", { ...common, files: ["spec.txt", "規格_新.txt"], message: "[UGLT-1] 更新規格" }, auth)).json();
    assert.equal(result.success, true);
    assert.ok(result.committedRevision > 1);
    assert.match(svn("cat", `${repoUrl}/spec.txt`), /v3 from web/);
    assert.match(svn("log", "--xml", "-l", "1", repoUrl), /\[UGLT-1\] 更新規格/);

    // commit 後報告已被重建，且 SVN 區塊變乾淨
    assert.match(readReport(projectDir), /沒有尚未上傳的變更/);

    // 稽核紀錄有成功與失敗的紀錄
    const log = fs.readFileSync(path.join(data.dir, "svn-operations.log"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(log.some((r) => r.op === "commit" && r.ok === true && r.messagePreview === "[UGLT-1] 更新規格"));
    assert.ok(log.some((r) => r.op === "commit" && r.ok === false));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    removeDir(projectDir);
  }
});

test("AI-facing tool surface has no SVN write tool", async () => {
  const { registerAllTools } = await import("../dist/toolsets.js");
  const { connectClient } = await import("./helpers/support.mjs");
  const { client, close } = await connectClient((s) => registerAllTools(s, new Set()));
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    const svnTools = names.filter((n) => n.startsWith("svn_"));
    assert.deepEqual(svnTools.sort(), ["svn_browse", "svn_cat", "svn_doc_images", "svn_list_connections", "svn_log", "svn_test_connection"]);
    // 登記/查詢工作副本的工具只存設定，名稱不含任何寫入動詞
    const workCopyTools = names.filter((n) => /workcop/i.test(n)).sort();
    assert.deepEqual(workCopyTools, ["register_svn_workcopies", "resolve_svn_workcopies"]);
    assert.equal(names.some((n) => /^(svn|wc)_.*(commit|add|delete|update|revert|put|import|cleanup|mkdir)/i.test(n)), false);
  } finally {
    await close();
  }
});

test("a conflicted row shows guidance and no delete/revert buttons", { skip }, async () => {
  const { store, registry } = await loadModules();
  const projectDir = makeTmpDir("dpm-svn-proj-");
  try {
    const a = path.join(root, "wc-conflict-a");
    const b = path.join(root, "wc-conflict-b");
    svn("checkout", repoUrl, a);
    svn("checkout", repoUrl, b);
    fs.writeFileSync(path.join(a, "spec.txt"), "A-side line\n");
    svn("commit", "-m", "a edits", a);
    fs.writeFileSync(path.join(b, "spec.txt"), "B-side line\n");
    svn("update", "--accept", "postpone", b);

    await registry.registerSvnWorkCopies(projectDir, [{ label: "衝突", workCopyPath: b, connectionId: "t1" }]);
    await store.writePendingActionsReport(projectDir, PROJECT_NAME, EMPTY_INPUT);
    const html = readReport(projectDir);
    const row = html.split('data-svn-path="spec.txt"')[1].split("</li>")[0];
    assert.match(row, /data-svn-status="conflicted"/);
    assert.match(row, /TortoiseSVN/);
    assert.doesNotMatch(row, /data-svn-op="(revert|delete)"/);
    assert.doesNotMatch(row, /data-svn-select/); // 不能勾選上傳
  } finally {
    removeDir(projectDir);
  }
});
