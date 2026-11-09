// work_item 工具測試的共用環境：隔離資料目錄、in-memory MCP client、依角色補齊交件檔、依序推進流程。
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CLEAN_REVIEW = { breaksExisting: false, reviewerUncertain: false, scopeSplit: false };
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

export async function setupEnv(prefix, { renderer } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.ASANA_PIPELINE_DATA_DIR = path.join(tmp, "data");
  const projectDir = path.join(tmp, "proj");
  await mkdir(projectDir, { recursive: true });
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { registerWorkItemTools } = await import("../../dist/work-item-tools.js");
  const store = await import("../../dist/pipeline-store.js");
  const server = new McpServer({ name: "t", version: "0" });
  registerWorkItemTools(server, renderer ? { renderer } : {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);

  async function call(args) {
    const r = await client.callTool({ name: "work_item", arguments: args });
    const text = r.content[0].text;
    return { isError: !!r.isError, text, json: JSON.parse(text) };
  }
  async function create(extra = {}) {
    const r = await call({ action: "create", projectDir, title: "測試需求", requirement: "需求原文", baseline: "greenfield", scope: "both", hasDb: true, ...extra });
    if (r.isError) throw new Error(r.text);
    return { id: r.json.workItemId, dir: r.json.dir };
  }
  return { tmp, projectDir, call, create, store, client, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

/** 依角色補齊合格的交件檔。 */
export async function fulfil(dir, roleId, opts = {}) {
  const w = (rel, text) => mkdir(path.dirname(path.join(dir, rel)), { recursive: true }).then(() => writeFile(path.join(dir, rel), text));
  const files = {
    "baseline-survey": async () => { await w("baseline.md", "基線"); await w("impact.md", "影響"); },
    "mockup-designer": () => w("sa-mockup/index.html", "<html></html>"),
    "sa-analyst": async () => { await w("01-sa.md", "## 功能：登入\n![畫面](sa-images/a.png)\n"); await writeFile(path.join(dir, "sa-images", "a.png"), PNG); },
    "db-designer": () => w("02-db.sql", opts.sql ?? "CREATE TABLE t (id INT);"),
    "flow-analyst": async () => { await w("flow.mmd", "graph TD\nA-->B"); await writeFile(path.join(dir, "flow.png"), PNG); },
    "sd-analyst": () => w("03-sd.md", "SD"),
    "spec-verifier": () => w("spec-check.md", opts.verdictText ?? "PASS\n對照表"),
    "frontend-engineer": () => w("impl-fe.md", "FE"),
    "backend-engineer": () => w("impl-be.md", "BE"),
    verifier: () => w("verify.md", opts.verdictText ?? "PASS\n"),
    tester: () => w("test.md", "測試"),
  };
  await files[roleId]();
}

const STEPS = [
  ["mockup-designer"], ["mockup-confirm", "human"], ["sa-analyst"], ["sa-confirm", "agent"], ["db-designer"], ["flow-analyst"],
  ["db-flow-confirm", "agent"], ["sd-analyst"], ["sd-confirm", "agent"], ["spec-verifier"], ["spec-check-verdict", "verdict"],
  ["frontend-engineer"], ["backend-engineer"], ["implementation-content", "human"], ["verifier"], ["verdict", "verdict"], ["tester"], ["test-evidence", "human"],
];

/** 依序推進直到「下一步」是 stopBefore（角色 id 或關卡 id）；全部做完則推進到最終驗收之前。 */
export async function runUntil(env, id, dir, stopBefore) {
  env.cursor ??= new Map();
  for (let i = env.cursor.get(id) ?? 0; i < STEPS.length; i++) {
    const [label, kind] = STEPS[i];
    if (label === stopBefore) return;
    let r;
    if (!kind) {
      await fulfil(dir, label);
      r = await env.call({ action: "done", workItemId: id, roleId: label });
    } else if (kind === "verdict") {
      r = await env.call({ action: "verdict", workItemId: id, gateId: label, result: "pass", by: "agent", review: CLEAN_REVIEW });
    } else {
      r = await env.call({ action: "confirm", workItemId: id, gateId: label, decision: "confirmed", by: kind, ...(kind === "agent" ? { review: CLEAN_REVIEW } : {}) });
    }
    if (r.isError) throw new Error(`推進到 ${label} 失敗：${r.text}`);
    env.cursor.set(id, i + 1);
  }
}
