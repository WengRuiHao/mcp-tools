// build-info：呼叫端可從回傳的 server 欄位判斷 MCP 程序跑的是哪一版。
import test from "node:test";
import assert from "node:assert/strict";
import { makeTmpDir, removeDir, isolateDataDir, connectClient, callTool } from "./helpers/support.mjs";
import { getServerInfo } from "../dist/build-info.js";
import { registerProjectConfigTools } from "../dist/project-config-tools.js";

test("getServerInfo: 欄位存在且型別正確", () => {
  const info = getServerInfo();
  assert.equal(typeof info.startedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(info.startedAt)));
  assert.ok(info.builtAt === null || !Number.isNaN(Date.parse(info.builtAt)));
  assert.equal(typeof info.pid, "number");
  assert.ok(info.version === null || typeof info.version === "string");
});

test("getServerInfo: build 完的 dist/index.js 讀得到 builtAt，startedAt 兩次呼叫不變", () => {
  const a = getServerInfo();
  const b = getServerInfo();
  assert.equal(typeof a.builtAt, "string");
  assert.equal(a.startedAt, b.startedAt);
});

test("prepare_project: 回傳頂層帶 server 欄位", async () => {
  const data = isolateDataDir();
  const dir = makeTmpDir("dpm-bi-");
  const conn = await connectClient(registerProjectConfigTools);
  try {
    const r1 = await callTool(conn.client, "prepare_project", { cwd: dir });
    const r2 = await callTool(conn.client, "prepare_project", { cwd: dir });
    assert.equal(typeof r1.json.server.startedAt, "string");
    assert.equal(r1.json.server.startedAt, r2.json.server.startedAt);
    assert.equal(r1.json.server.pid, process.pid);
  } finally {
    await conn.close();
    removeDir(dir);
    data.cleanup();
  }
});
