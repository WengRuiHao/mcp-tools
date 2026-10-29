// get_role_prompt 的「一次載入工具」清單與 forSubagent 派工簡報。
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeTmpDir, removeDir, connectClient, callTool, isolateDataDir } from "./helpers/support.mjs";
import { registerAllTools } from "../dist/toolsets.js";
import { assignTicketDir, recordProjectContext, advanceStage } from "../dist/pipeline-store.js";
import { getRolePrompt, ROLE_TOOLS, ROLE_FORBIDDEN_TOOLS, TOOL_PREFIX, buildToolLoadQuery } from "../dist/prompts.js";
import { getOverview } from "../dist/overview-prompts.js";

const ROLES = ["analyst", "spec-writer", "engineer", "verifier", "tester"];
const data = isolateDataDir();
// 建票單狀態會順手同步報告，可能 spawn 真的 asana-mcp；指到不存在的檔案讓它立刻失敗，絕不碰真實憑證。
const previousAsanaPath = process.env.ASANA_MCP_PATH;
const previousUserGid = process.env.PIPELINE_ASANA_USER_GID;
process.env.ASANA_MCP_PATH = path.join(data.dir, "no-such-asana-mcp.js");
process.env.PIPELINE_ASANA_USER_GID = "gid-pipeline-user";
const projectDir = makeTmpDir("dpm-subagent-");

test.after(async () => {
  const { closeChildMcpClients } = await import("../dist/mcp-clients.js");
  await closeChildMcpClients();
  if (previousAsanaPath === undefined) delete process.env.ASANA_MCP_PATH;
  else process.env.ASANA_MCP_PATH = previousAsanaPath;
  if (previousUserGid === undefined) delete process.env.PIPELINE_ASANA_USER_GID;
  else process.env.PIPELINE_ASANA_USER_GID = previousUserGid;
  removeDir(projectDir);
  data.cleanup();
});

async function withClient(fn) {
  const conn = await connectClient((s) => registerAllTools(s, new Set()));
  try {
    await fn(conn.client);
  } finally {
    await conn.close();
  }
}

test("role toolset: every listed tool is a really registered tool", () =>
  withClient(async (client) => {
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const role of ROLES) {
      assert.ok(ROLE_TOOLS[role].length > 0, role);
      assert.equal(new Set(ROLE_TOOLS[role]).size, ROLE_TOOLS[role].length, `${role} has duplicates`);
      for (const tool of ROLE_TOOLS[role]) assert.ok(names.has(tool), `${role}: unknown tool ${tool}`);
    }
    for (const tool of ROLE_FORBIDDEN_TOOLS) assert.ok(names.has(tool), `forbidden list: unknown tool ${tool}`);
  }));

test("role toolset: no role is allowed a tool that is on the forbidden list", () => {
  for (const role of ROLES) {
    for (const tool of ROLE_TOOLS[role]) assert.ok(!ROLE_FORBIDDEN_TOOLS.includes(tool), `${role} lists forbidden ${tool}`);
  }
});

test("role prompt ends with a single ToolSearch select line matching the role's tools", () => {
  for (const role of ROLES) {
    const text = getRolePrompt(role);
    const lines = text.split("\n").filter((l) => l.startsWith("`select:"));
    assert.equal(lines.length, 1, role);
    const query = lines[0].replace(/`/g, "");
    assert.equal(query, buildToolLoadQuery(role));
    const listed = query.slice("select:".length).split(",");
    assert.deepEqual(listed, ROLE_TOOLS[role].map((n) => TOOL_PREFIX + n));
    assert.match(text, /不要逐個載入/);
    assert.match(text, /record_confirmation/);
    assert.match(text, /record_spec_confirmation/);
  }
});

test("role toolset: analyst keeps the tools named in the task and spec-writer does not write ticket artifacts", () => {
  for (const t of ["get_ticket_status", "record_sasd_check", "read_ticket_artifact", "write_ticket_artifact", "advance_ticket_stage", "svn_cat", "svn_doc_images", "get_recent_commits"]) {
    assert.ok(ROLE_TOOLS.analyst.includes(t), t);
  }
  assert.ok(!ROLE_TOOLS["spec-writer"].includes("write_ticket_artifact"));
  assert.ok(ROLE_TOOLS.tester.includes("record_test_evidence"));
});

test("forSubagent: brief comes first, carries ticket data, then the role text and project rules still follow", () =>
  withClient(async (client) => {
    await assignTicketDir(projectDir, "T-SUB-1", "Proj", "UGLT-159", null, "票名");
    await recordProjectContext("T-SUB-1", projectDir, "Proj", "票名", null, false, "PG-9");
    await advanceStage("T-SUB-1", "analyzed");
    const res = await callTool(client, "get_role_prompt", { role: "engineer", taskGid: "T-SUB-1", forSubagent: true });
    assert.equal(res.isError, false);
    assert.ok(res.text.startsWith("# 派工簡報：工程師"));
    for (const needle of ["T-SUB-1", "UGLT-159", "PG-9", projectDir, "stage：analyzed", "nextAction", "02-implementation.md", "syncNote", "manualActions"]) {
      assert.ok(res.text.includes(needle), `brief lost ${needle}`);
    }
    for (const needle of ["PowerShell 5.1", "timeoutMs", "CRLF", "ASANA_MCP_PATH", "U+FFFD", "最終訊息就是交付物", "git commit"]) {
      assert.ok(res.text.includes(needle), `brief lost ${needle}`);
    }
    assert.ok(res.text.indexOf("# 角色：工程師") > res.text.indexOf("# 派工簡報"));
    assert.ok(res.text.includes(buildToolLoadQuery("engineer")));
  }));

test("forSubagent: project addenda are still appended after the role text", () =>
  withClient(async (client) => {
    const { writeFile } = await import("./helpers/support.mjs");
    writeFile(projectDir, ".pipeline/roles/all.md", "SUB-COMMON-MARK");
    try {
      const res = await callTool(client, "get_role_prompt", { role: "verifier", taskGid: "T-SUB-1", forSubagent: true });
      assert.ok(res.text.indexOf("SUB-COMMON-MARK") > res.text.indexOf("# 角色：驗證師"));
      assert.ok(res.text.startsWith("# 派工簡報"));
    } finally {
      removeDir(path.join(projectDir, ".pipeline"));
    }
  }));

test("forSubagent: unknown taskGid or missing taskGid gives a structured error, not an exception", () =>
  withClient(async (client) => {
    const unknown = await callTool(client, "get_role_prompt", { role: "analyst", taskGid: "NO-SUCH", forSubagent: true });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.json.success, false);
    assert.match(unknown.json.message, /NO-SUCH/);
    const missing = await callTool(client, "get_role_prompt", { role: "analyst", forSubagent: true });
    assert.equal(missing.isError, true);
    assert.equal(missing.json.success, false);
  }));

test("without forSubagent the output has no brief (backward compatible)", () =>
  withClient(async (client) => {
    const res = await callTool(client, "get_role_prompt", { role: "analyst", taskGid: "T-SUB-1" });
    assert.ok(!res.text.includes("派工簡報"));
    assert.ok(res.text.startsWith(getRolePrompt("analyst")));
  }));

test("appendix-a describes the standard dispatch and keeps the core untouched", () => {
  const a = getOverview("appendix-a");
  for (const needle of ["forSubagent: true", "ToolSearch", "最終訊息就是交付物", "get_pipeline_overview"]) assert.ok(a.includes(needle), needle);
  assert.ok(a.length <= 1200, `appendix-a is ${a.length} chars`);
});

test("roleMismatchWarning flags a role that nextAction does not name", async () => {
  const { roleMismatchWarning } = await import("../dist/subagent-brief.js");
  const toTester = "目前 stage=verified、verdict=PASS。下一步：測試工程師：先 record_test_evidence 記錄測試證據。";
  assert.equal(roleMismatchWarning("tester", toTester), null);
  assert.match(roleMismatchWarning("engineer", toTester), /角色與票單進度可能不符/);
  const toEngineer = "目前 stage=analyzed。下一步：工程師：寫 02-implementation.md。";
  assert.equal(roleMismatchWarning("engineer", toEngineer), null);
  assert.match(roleMismatchWarning("tester", toEngineer), /測試工程師/);
  assert.match(roleMismatchWarning("verifier", "規格草稿等使用者確認，不要自行推進。"), /驗證師/);
});

test("forSubagent brief carries the mismatch warning only when the role is wrong", async () => {
  const { buildSubagentBrief } = await import("../dist/subagent-brief.js");
  const base = {
    taskGid: "T",
    ticketNumber: "PROJ-1",
    projectName: "P",
    projectGid: "G",
    projectDir: "/x",
    stage: "verified",
    verdict: "PASS",
    sdMode: null,
    specOrder: null,
    nextActionSummary: "目前 stage=verified。下一步：測試工程師：先記錄測試證據。",
    blockedBy: [],
  };
  assert.match(buildSubagentBrief({ ...base, role: "engineer" }), /角色與票單進度可能不符/);
  assert.ok(!buildSubagentBrief({ ...base, role: "tester" }).includes("角色與票單進度可能不符"));
});
