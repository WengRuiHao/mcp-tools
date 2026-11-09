// 步驟 4c：worktree、pipeline-info 工具與 http bridge 對外雙收 taskGid / workItemId。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { makeTmpDir, removeDir, isolateDataDir, connectClient, callTool } from "./helpers/support.mjs";

const iso = isolateDataDir();
const tmp = makeTmpDir("dpm-wi4c-");
const projectDir = path.join(tmp, "proj");

const store = await import("../dist/pipeline-store.js");
const { registerWorktreeTools } = await import("../dist/worktree-tools.js");
const { registerPipelineInfoTools } = await import("../dist/pipeline-info-tools.js");
const { startHttpBridge } = await import("../dist/http-server.js");

let ctx, server, base;
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });

before(async () => {
  ctx = await connectClient((s) => {
    registerWorktreeTools(s);
    registerPipelineInfoTools(s);
  });
  const port = await freePort();
  process.env.DEV_PIPELINE_MCP_HTTP_PORT = String(port);
  server = startHttpBridge({ exitOnConflict: false });
  await new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await ctx.close();
  iso.cleanup();
  removeDir(tmp);
});

const call = (name, args) => callTool(ctx.client, name, args);
const post = async (route, body) => {
  const r = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
async function newTicket(gid) {
  await store.assignTicketDir(projectDir, gid, "Proj", `T-${gid}`);
  await store.advanceStage(gid, "snapshot", { project_dir: projectDir });
}

test("工具清單：taskGid / workItemId 皆選填", async () => {
  const { tools } = await ctx.client.listTools();
  for (const n of ["create_ticket_worktree", "join_ticket_worktree", "get_worktree_status", "merge_ticket_worktree", "abandon_ticket_round", "get_role_prompt", "get_project_rules"]) {
    const t = tools.find((x) => x.name === n);
    assert.ok(t.inputSchema.properties.taskGid && t.inputSchema.properties.workItemId, n);
    assert.deepEqual((t.inputSchema.required ?? []).filter((k) => k === "taskGid" || k === "workItemId"), [], n);
  }
});

test("get_project_rules：workItemId 與 taskGid 等價，輸出含 workItemId", async () => {
  await newTicket("w1");
  const a = await call("get_project_rules", { taskGid: "w1" });
  const b = await call("get_project_rules", { workItemId: "w1" });
  assert.equal(b.isError, false, b.text);
  assert.equal(b.json.workItemId, "w1");
  assert.deepEqual({ ...a.json, workItemId: "w1" }, b.json);
});

test("get_role_prompt：workItemId 等價（純文字輸出不變）", async () => {
  await newTicket("w2");
  const a = await call("get_role_prompt", { role: "engineer", taskGid: "w2" });
  const b = await call("get_role_prompt", { role: "engineer", workItemId: "w2" });
  assert.equal(b.isError, false);
  assert.equal(b.text, a.text);
});

test("worktree 工具：兩者衝突回 isError；都缺回 isError", async () => {
  const withBoth = { taskGid: "a", workItemId: "b", worktreeId: "x", mergeMessage: "m", note: "n" };
  for (const n of ["create_ticket_worktree", "join_ticket_worktree", "get_worktree_status", "merge_ticket_worktree", "abandon_ticket_round"]) {
    const r = await call(n, withBoth);
    assert.equal(r.isError, true, n);
    assert.match(r.json.message, /同時提供但值不同/, n);
  }
  for (const n of ["create_ticket_worktree", "join_ticket_worktree"]) {
    const r = await call(n, { worktreeId: "x" });
    assert.equal(r.isError, true, n);
    assert.match(r.json.message, /taskGid 或 workItemId/, n);
  }
});

test("worktree 選填型：workItemId 與 taskGid 走同一路徑（找不到 worktree 的錯誤相同）", async () => {
  const a = await call("get_worktree_status", { taskGid: "nope" });
  const b = await call("get_worktree_status", { workItemId: "nope" });
  assert.equal(a.isError, true);
  assert.equal(b.isError, true);
  assert.equal(b.text.includes('taskGid=\\"nope\\"') || b.text.includes('taskGid="nope"'), true, b.text);
});

test("http bridge：taskGid 仍可用，workItemId 也可用，輸出兩者皆有", async () => {
  await newTicket("w3");
  const viaGid = await post("/request-reanalysis", { taskGid: "w3" });
  assert.equal(viaGid.status, 200);
  assert.deepEqual(viaGid.json, { success: true, taskGid: "w3", workItemId: "w3" });
  const viaWid = await post("/request-reanalysis", { workItemId: "w3" });
  assert.equal(viaWid.status, 200);
  assert.deepEqual(viaWid.json, viaGid.json);
});

test("http bridge：缺少或衝突不會動到票單", async () => {
  const none = await post("/request-reanalysis", {});
  assert.notEqual(none.status, 200);
  assert.equal(none.json.success, false);
  const both = await post("/request-reanalysis", { taskGid: "w3", workItemId: "other" });
  assert.notEqual(both.status, 200);
  assert.match(both.json.message, /同時提供但值不同/);
});
