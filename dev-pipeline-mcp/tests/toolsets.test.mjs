// 工具群組開關、工具清單與關鍵參數的契約測試。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectClient } from "./helpers/support.mjs";
import { parseDisabledToolsets, registerAllTools, bridgeDisabledNote, TOOLSET_NAMES } from "../dist/toolsets.js";

async function listToolsWith(disabled = []) {
  const { client, close } = await connectClient((s) => registerAllTools(s, new Set(disabled)));
  try {
    return (await client.listTools()).tools;
  } finally {
    await close();
  }
}

const EXPECTED_TOOLS = [
  "abandon_ticket_round", "advance_ticket_stage", "create_ticket_worktree", "download_ticket_attachment", "finalize_ticket_worktree",
  "get_pipeline_overview", "get_project_rules", "get_recent_commits", "get_role_prompt", "get_sd_spec_template",
  "get_sd_spec_versioning_rules", "get_test_engineer_guide", "get_ticket_activity", "get_ticket_snapshot", "get_ticket_status",
  "get_worktree_status", "install_git_hooks", "join_ticket_worktree", "list_pending_tickets", "list_project_dir",
  "list_rule_history", "list_worktrees", "merge_ticket_worktree", "read_project_file", "read_project_sd_doc",
  "prepare_project", "project_config", "read_ticket_artifact", "record_confirmation", "record_sasd_check", "record_spec_confirmation", "record_test_evidence",
  "relocate_ticket_project", "request_reanalysis",
  "resolve_manual_action", "restore_rule_file",
  "resync_ticket_artifact", "run_project_shell", "search_project_text", "svn_browse", "svn_cat", "svn_doc_images",
  "svn_diff", "svn_find_repo", "svn_list_connections", "svn_log", "svn_test_connection", "write_project_file", "write_project_sd_doc", "write_ticket_artifact",
];
const WORKTREE_TOOLS = [
  "create_ticket_worktree", "join_ticket_worktree", "list_worktrees", "get_worktree_status", "merge_ticket_worktree",
  "finalize_ticket_worktree", "abandon_ticket_round", "install_git_hooks",
];
const BRIDGE_TOOLS = [
  "svn_find_repo", "svn_list_connections", "svn_test_connection", "svn_browse", "svn_cat", "svn_doc_images", "svn_log", "svn_diff",
  "get_ticket_activity", "download_ticket_attachment", "get_recent_commits",
];

test("parseDisabledToolsets: case, whitespace, empty items, duplicates", () => {
  const r = parseDisabledToolsets(" Worktree , BRIDGE ,, ");
  assert.deepEqual([...r.disabled].sort(), ["bridge", "worktree"]);
  assert.deepEqual(r.unknown, []);
  assert.deepEqual([...parseDisabledToolsets("bridge,bridge, Bridge").disabled], ["bridge"]);
});

test("parseDisabledToolsets: unknown names are reported once, undefined/empty means nothing disabled", () => {
  const r = parseDisabledToolsets("bridge,foo,FOO,bar");
  assert.deepEqual([...r.disabled], ["bridge"]);
  assert.deepEqual(r.unknown, ["foo", "bar"]);
  for (const v of [undefined, "", " , ,"]) {
    const e = parseDisabledToolsets(v);
    assert.equal(e.disabled.size, 0);
    assert.deepEqual(e.unknown, []);
  }
  assert.deepEqual([...TOOLSET_NAMES].sort(), ["bridge", "worktree"]);
});

test("registerAllTools: tool counts by disabled group", async () => {
  assert.equal((await listToolsWith()).length, 50);
  assert.equal((await listToolsWith(["worktree"])).length, 42);
  assert.equal((await listToolsWith(["bridge"])).length, 39);
  assert.equal((await listToolsWith(["worktree", "bridge"])).length, 31);
});

test("registerAllTools: each group removes exactly its own tools", async () => {
  const noWorktree = (await listToolsWith(["worktree"])).map((t) => t.name);
  for (const n of WORKTREE_TOOLS) assert.ok(!noWorktree.includes(n), n);
  for (const n of BRIDGE_TOOLS) assert.ok(noWorktree.includes(n), n);
  const noBridge = (await listToolsWith(["bridge"])).map((t) => t.name);
  for (const n of BRIDGE_TOOLS) assert.ok(!noBridge.includes(n), n);
  for (const n of WORKTREE_TOOLS) assert.ok(noBridge.includes(n), n);
});

test("bridgeDisabledNote: non-null only when bridge is disabled", () => {
  assert.equal(bridgeDisabledNote(undefined), null);
  assert.equal(bridgeDisabledNote(""), null);
  assert.equal(bridgeDisabledNote("worktree"), null);
  assert.equal(bridgeDisabledNote("unknown"), null);
  const note = bridgeDisabledNote("worktree, Bridge");
  assert.equal(typeof note, "string");
  assert.match(note, /svn_cat/);
  assert.match(note, /get_ticket_activity/);
});

// ---- 契約測試：避免不小心刪掉工具或參數 ----

test("contract: the full tool name list is unchanged (update EXPECTED_TOOLS when adding/removing a tool on purpose)", async () => {
  const names = (await listToolsWith()).map((t) => t.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
  assert.equal(new Set(names).size, names.length);
});

test("contract: key tools keep their parameters", async () => {
  const tools = await listToolsWith();
  const props = (name) => Object.keys(tools.find((t) => t.name === name).inputSchema.properties ?? {});
  const expectParams = {
    list_pending_tickets: ["projectGid", "dueOn", "limit", "onlyAssignedToMe", "search"],
    record_spec_confirmation: ["taskGid", "confirmed", "note", "sdNotRequired", "userInstruction"],
    get_pipeline_overview: ["section"],
    write_ticket_artifact: ["taskGid", "filename", "mode", "content", "oldString", "newString", "summary", "syncNote", "manualActions", "producesOfficeFiles", "testLevel"],
    read_ticket_artifact: ["taskGid", "filename"],
    get_role_prompt: ["role", "projectDir", "taskGid", "forSubagent"],
    get_project_rules: ["projectDir", "taskGid"],
    get_sd_spec_template: ["projectDir", "taskGid"],
    get_sd_spec_versioning_rules: ["projectDir", "taskGid"],
    read_project_sd_doc: ["projectGid", "projectDir", "fileName"],
    write_project_sd_doc: ["projectGid", "projectDir", "content", "fileName"],
    list_rule_history: ["projectDir", "taskGid", "file"],
    restore_rule_file: ["projectDir", "taskGid", "file", "snapshot"],
    prepare_project: ["cwd", "projectGid"],
    project_config: ["kind", "action", "projectGid", "projectDir", "cwd", "workspaceGid", "projectName", "saRoot", "sdMode", "sdRoot", "svnConnectionId", "sdOutputPath", "specOrder", "legacyTestProfile", "mode", "note", "gitRoots", "workCopies"],
  };
  for (const [name, expected] of Object.entries(expectParams)) {
    const actual = props(name);
    for (const p of expected) assert.ok(actual.includes(p), `${name} lost parameter ${p}`);
  }
});

test("contract: project_config.kind enum and old resolve_*/register_* tools are gone", async () => {
  const tools = await listToolsWith();
  const schema = tools.find((t) => t.name === "project_config").inputSchema.properties;
  assert.deepEqual(
    [...schema.kind.enum].sort(),
    ["default_project", "git_roots", "legacy_test_profile", "project_dir", "sasd_config", "svn_workcopies", "test_capability"]
  );
  assert.deepEqual([...schema.action.enum].sort(), ["register", "resolve"]);
  const names = tools.map((t) => t.name);
  assert.deepEqual(names.filter((n) => /^(resolve|register)_(default_project|project_dir|git_roots|svn_workcopies|sasd_config|test_capability|legacy_test_profile)$/.test(n)), []);
});

test("contract: get_pipeline_overview.section enum and get_role_prompt.role enum", async () => {
  const tools = await listToolsWith();
  const schema = (n) => tools.find((t) => t.name === n).inputSchema.properties;
  assert.deepEqual(
    [...schema("get_pipeline_overview").section.enum].sort(),
    ["all", "appendix-a", "appendix-b", "appendix-c", "core", "setup"]
  );
  assert.deepEqual(
    [...schema("get_role_prompt").role.enum].sort(),
    ["analyst", "engineer", "spec-writer", "tester", "verifier"]
  );
});

test("文件裡寫的工具數量跟實際註冊數一致（README／MANUAL／toolsets.svg）", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf-8");
  const total = (await listToolsWith()).length;
  const withoutWorktree = (await listToolsWith(["worktree"])).length;
  const withoutBridge = (await listToolsWith(["bridge"])).length;
  const core = (await listToolsWith(["worktree", "bridge"])).length;
  const readme = read("README.md");
  const svg = read("docs/img/toolsets.svg");
  assert.ok(readme.includes(`共 ${total} 個工具`), `README 的總數要是 ${total}`);
  assert.ok(readme.includes(`展開完整工具清單（${total} 個）`), "README 工具清單標題的總數");
  assert.ok(read("docs/MANUAL.html").includes(`總共 ${total} 個工具`), `MANUAL 的總數要是 ${total}`);
  assert.ok(readme.includes(`關後剩 ${withoutWorktree} 個`) && readme.includes(`關後剩 ${withoutBridge} 個`), "README 各群組關掉後剩餘數");
  assert.ok(readme.includes(`剩 ${core} 個核心工具`), "README 核心工具數");
  for (const n of [total, withoutWorktree, withoutBridge, core]) {
    assert.ok(svg.includes(`>${n}<`), `toolsets.svg 要有 ${n}`);
  }
  assert.ok(svg.includes(`核心工具 ${core} 個`), "toolsets.svg 核心工具數");
});

test("每個實際註冊的工具都有出現在 README 與 MANUAL", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf-8");
  const manual = fs.readFileSync(path.join(root, "docs/MANUAL.html"), "utf-8");
  const names = (await listToolsWith()).map((t) => t.name);
  assert.deepEqual(names.filter((n) => !readme.includes(n)), [], "README 缺少這些工具");
  assert.deepEqual(names.filter((n) => !manual.includes(n)), [], "MANUAL 缺少這些工具");
});
