// svn-mcp 啟動時自動拉起 svn-edit：冪等、可關閉、不引用任何寫入 SVN 的模組。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createEditServer } from "../dist/edit-server.js";
import { ensureEditServer, isEditServerRunning, resolveLaunchCommand } from "../dist/edit-autostart.js";

const srcDir = path.resolve(import.meta.dirname, "..", "src");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(check, timeoutMs, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

const healthy = (port) =>
  new Promise((resolve) => {
    fetch(`http://127.0.0.1:${port}/health`)
      .then((r) => r.json())
      .then((j) => resolve(j.service === "svn-edit"))
      .catch(() => resolve(false));
  });

/** 測試收尾用：把占用這個埠的程序結束（自動拉起的程序是分離模式，沒有別的辦法關掉）。 */
function killListener(port) {
  if (process.platform !== "win32") return;
  execFileSync("powershell", ["-NoProfile", "-Command", `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`]);
}

test("autostart 模組不引用任何寫入 SVN 的模組", () => {
  const text = fs.readFileSync(path.join(srcDir, "edit-autostart.ts"), "utf-8");
  const imports = text.split("\n").filter((l) => /^\s*import\b/.test(l)).join("\n");
  assert.doesNotMatch(imports, /remote-edit-client|workcopy-client|edit-server|connections-store/);
});

test("SVN_EDIT_AUTOSTART=0 時完全不處理", async () => {
  process.env.SVN_EDIT_AUTOSTART = "0";
  try {
    assert.equal(await ensureEditServer(), "disabled");
  } finally {
    delete process.env.SVN_EDIT_AUTOSTART;
  }
});

test("服務已經在跑時什麼都不做（冪等）", async () => {
  const { server } = createEditServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.SVN_EDIT_PORT = String(server.address().port);
  try {
    assert.equal(await ensureEditServer(), "already-running");
    assert.equal(await ensureEditServer(), "already-running");
  } finally {
    delete process.env.SVN_EDIT_PORT;
    server.close();
  }
});

test("健康檢查：埠被別的東西占用、或根本沒東西，都不算 svn-edit 在跑", async () => {
  const blocker = net.createServer((socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi"));
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const blockedPort = blocker.address().port;
  try {
    assert.equal(await isEditServerRunning(blockedPort), false);
  } finally {
    blocker.close();
  }
  assert.equal(await isEditServerRunning(await freePort()), false);
  const { server } = createEditServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal(await isEditServerRunning(server.address().port), true);
  } finally {
    server.close();
  }
});

test("找得到啟動指令：優先用 dist-exe 的執行檔，否則用 node 跑 edit-main.js，且一律帶 --no-open", () => {
  const launch = resolveLaunchCommand();
  assert.ok(launch, "應該找得到 svn-edit.exe 或 dist/edit-main.js");
  assert.ok(launch.args.includes("--no-open"));
  assert.ok(fs.existsSync(launch.command));
});

test("沒有服務在跑時會真的拉起一個，且之後再呼叫就是 already-running", async (t) => {
  const port = await freePort();
  process.env.SVN_EDIT_PORT = String(port);
  process.env.SVN_EDIT_IDLE_MINUTES = "0.02"; // 拉起的服務閒置約 1 分鐘內自己結束：收尾時服務可能還沒綁定埠，killListener 會落空
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "svn-edit-auto-"));
  process.env.SVN_EDIT_TEMP_DIR = path.join(tempBase, "tmp");
  t.after(() => {
    killListener(port);
    delete process.env.SVN_EDIT_PORT;
    delete process.env.SVN_EDIT_IDLE_MINUTES;
    fs.rmSync(tempBase, { recursive: true, force: true });
  });
  const t0 = Date.now();
  assert.equal(await ensureEditServer(), "started");
  t.diagnostic(`ensureEditServer 回傳花了 ${Date.now() - t0} ms，command=${resolveLaunchCommand()?.command}`);
  const t1 = Date.now();
  const up = await waitFor(() => healthy(port), 60000);
  t.diagnostic(`啟動後 ${Date.now() - t1} ms 內 /health ${up ? "可連線" : "仍然連不上"}`);
  assert.ok(up, "拉起的服務應該在 60 秒內可以連線（平行跑其他測試時 PowerShell 冷啟動會變慢）");
  assert.equal(await ensureEditServer(), "already-running");
});

test("拉起服務後，父程序一結束管道就會關閉（服務不能握著父程序的 stdout，否則等管道結束的一方會被卡住）", async (t) => {
  const port = await freePort();
  t.after(() => killListener(port));
  const script = `import("${pathToFileURL(path.resolve(import.meta.dirname, "..", "dist", "edit-autostart.js")).href}").then(async (m) => { console.log(await m.ensureEditServer()); });`;
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SVN_EDIT_PORT: String(port), SVN_EDIT_IDLE_MINUTES: "0.02", SVN_EDIT_TEMP_DIR: path.join(os.tmpdir(), `svn-edit-eof-${port}`) },
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  // 'close' 要等到 stdio 管道全部關閉才會觸發；服務如果握著管道，這裡就永遠等不到
  const closed = await Promise.race([
    new Promise((resolve) => child.on("close", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 90000)),
  ]);
  if (!closed) child.kill();
  assert.equal(closed, true, "父程序結束後管道應該要關閉，服務不能握著它");
  assert.match(out, /started/);
  assert.ok(await waitFor(() => healthy(port), 60000), "服務應該仍然在背景執行");
});
