// get_role_prompt / get_project_rules / get_sd_spec_* 的組裝行為（in-memory client）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTmpDir, removeDir, writeFile, connectClient, callTool, isolateDataDir } from "./helpers/support.mjs";
import { registerPipelineInfoTools } from "../dist/pipeline-info-tools.js";
import { registerSdDocTools } from "../dist/sd-doc-tools.js";
import { getRolePrompt } from "../dist/prompts.js";

const SEP = "\n\n---\n\n";
const ROLES = ["analyst", "spec-writer", "engineer", "verifier", "tester"];
const templatesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");

const data = isolateDataDir();
const savedDisable = process.env.DEV_PIPELINE_DISABLE_TOOLSETS;
delete process.env.DEV_PIPELINE_DISABLE_TOOLSETS;
test.after(() => {
  data.cleanup();
  if (savedDisable !== undefined) process.env.DEV_PIPELINE_DISABLE_TOOLSETS = savedDisable;
});

async function withClient(fn) {
  const dir = makeTmpDir("dpm-prompt-");
  const conn = await connectClient((s) => {
    registerPipelineInfoTools(s);
    registerSdDocTools(s);
  });
  try {
    await fn(conn.client, dir);
  } finally {
    await conn.close();
    removeDir(dir);
  }
}

/** 讓 taskGid 反查得到 project_dir：寫 tickets-index.json 與該票的 status.json。 */
function linkTicket(taskGid, projectDir) {
  const ticketDir = path.join(projectDir, ".asana-pipeline", taskGid);
  writeFile(ticketDir, "status.json", JSON.stringify({ project_dir: projectDir }));
  const indexFile = path.join(data.dir, "tickets-index.json");
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf-8")) : {};
  index[taskGid] = ticketDir;
  fs.writeFileSync(indexFile, JSON.stringify(index));
}

test("get_role_prompt: every role returns its generic text; no projectDir adds nothing", () =>
  withClient(async (client) => {
    for (const role of ROLES) {
      const res = await callTool(client, "get_role_prompt", { role });
      assert.equal(res.isError, false);
      assert.equal(res.text, getRolePrompt(role), role);
    }
  }));

test("get_role_prompt: project without rule files gets the generic text only", () =>
  withClient(async (client, dir) => {
    const res = await callTool(client, "get_role_prompt", { role: "analyst", projectDir: dir });
    assert.equal(res.text, getRolePrompt("analyst"));
  }));

test("get_role_prompt: generic, then common rules, then role-specific rules", () =>
  withClient(async (client, dir) => {
    writeFile(dir, ".pipeline/roles/all.md", "COMMON-RULE-MARK");
    writeFile(dir, ".pipeline/roles/engineer.md", "ENGINEER-RULE-MARK");
    const base = getRolePrompt("engineer");
    const res = await callTool(client, "get_role_prompt", { role: "engineer", projectDir: dir });
    const iBase = res.text.indexOf(base);
    const iCommon = res.text.indexOf("COMMON-RULE-MARK");
    const iRole = res.text.indexOf("ENGINEER-RULE-MARK");
    assert.equal(iBase, 0);
    assert.ok(iCommon > iBase + base.length);
    assert.ok(iRole > iCommon);
    assert.equal(res.text.split(SEP).length, 3);
    assert.match(res.text, /\.pipeline\/roles\/all\.md/);
    assert.match(res.text, /\.pipeline\/roles\/engineer\.md/);

    // 別的角色只拿到共通規則，不會拿到工程師專屬規則
    const analyst = await callTool(client, "get_role_prompt", { role: "analyst", projectDir: dir });
    assert.ok(analyst.text.includes("COMMON-RULE-MARK"));
    assert.ok(!analyst.text.includes("ENGINEER-RULE-MARK"));
  }));

test("get_role_prompt: .pipeline/ wins over the legacy location, legacy still works alone", () =>
  withClient(async (client, dir) => {
    writeFile(dir, ".claude/pipeline-roles/verifier.md", "LEGACY-MARK");
    const legacyOnly = await callTool(client, "get_role_prompt", { role: "verifier", projectDir: dir });
    assert.ok(legacyOnly.text.includes("LEGACY-MARK"));
    writeFile(dir, ".pipeline/roles/verifier.md", "NEW-MARK");
    const both = await callTool(client, "get_role_prompt", { role: "verifier", projectDir: dir });
    assert.ok(both.text.includes("NEW-MARK"));
    assert.ok(!both.text.includes("LEGACY-MARK"));
  }));

test("get_role_prompt: blank rule files are ignored", () =>
  withClient(async (client, dir) => {
    writeFile(dir, ".pipeline/roles/all.md", "  \n\n ");
    const res = await callTool(client, "get_role_prompt", { role: "tester", projectDir: dir });
    assert.equal(res.text, getRolePrompt("tester"));
  }));

test("get_role_prompt: taskGid resolves projectDir; explicit projectDir wins; unknown taskGid falls back to generic", () =>
  withClient(async (client, dir) => {
    writeFile(dir, ".pipeline/roles/all.md", "VIA-TICKET-MARK");
    linkTicket("T100", dir);
    const viaTicket = await callTool(client, "get_role_prompt", { role: "analyst", taskGid: "T100" });
    assert.ok(viaTicket.text.includes("VIA-TICKET-MARK"));

    const other = makeTmpDir("dpm-prompt-other-");
    try {
      writeFile(other, ".pipeline/roles/all.md", "OTHER-MARK");
      const explicit = await callTool(client, "get_role_prompt", { role: "analyst", taskGid: "T100", projectDir: other });
      assert.ok(explicit.text.includes("OTHER-MARK"));
      assert.ok(!explicit.text.includes("VIA-TICKET-MARK"));
    } finally {
      removeDir(other);
    }

    const unknown = await callTool(client, "get_role_prompt", { role: "analyst", taskGid: "NOPE" });
    assert.equal(unknown.isError, false);
    assert.equal(unknown.text, getRolePrompt("analyst"));
  }));

test("get_role_prompt: bridge group disabled appends the replacement note", () =>
  withClient(async (client) => {
    process.env.DEV_PIPELINE_DISABLE_TOOLSETS = "bridge";
    try {
      const res = await callTool(client, "get_role_prompt", { role: "analyst" });
      assert.ok(res.text.startsWith(getRolePrompt("analyst")));
      assert.match(res.text, /svn_cat/);
      assert.ok(res.text.length > getRolePrompt("analyst").length);
    } finally {
      delete process.env.DEV_PIPELINE_DISABLE_TOOLSETS;
    }
  }));

test("get_role_prompt: engineer prompt is shortened when the project registered test capability 'none'", () =>
  withClient(async (client, dir) => {
    const full = getRolePrompt("engineer");
    const slim = getRolePrompt("engineer", { testCapabilityMode: "none" });
    assert.ok(slim.length < full.length);
    fs.writeFileSync(path.join(data.dir, "project-dir-config.json"), JSON.stringify({ P1: dir }));
    fs.writeFileSync(path.join(data.dir, "test-capability-config.json"), JSON.stringify({ P1: { mode: "none", note: null } }));
    try {
      const res = await callTool(client, "get_role_prompt", { role: "engineer", projectDir: dir });
      assert.equal(res.text, slim);
      const analyst = await callTool(client, "get_role_prompt", { role: "analyst", projectDir: dir });
      assert.equal(analyst.text, getRolePrompt("analyst"));
    } finally {
      fs.rmSync(path.join(data.dir, "project-dir-config.json"), { force: true });
      fs.rmSync(path.join(data.dir, "test-capability-config.json"), { force: true });
    }
  }));

test("get_project_rules: reports 'none' for a bare project, lists files otherwise", () =>
  withClient(async (client, dir) => {
    const bare = await callTool(client, "get_project_rules", { projectDir: dir });
    assert.equal(bare.json.success, true);
    assert.equal(bare.json.commonRules, null);
    assert.deepEqual(bare.json.roleRuleFiles, []);
    assert.equal(bare.json.analysisGatesFile, null);
    assert.ok(bare.json.note);

    writeFile(dir, ".pipeline/roles/all.md", "COMMON");
    writeFile(dir, ".pipeline/roles/engineer.md", "E");
    writeFile(dir, ".claude/pipeline-roles/tester.md", "T");
    writeFile(dir, ".pipeline/gates.json", "{}");
    const full = await callTool(client, "get_project_rules", { projectDir: dir });
    assert.deepEqual(full.json.commonRules, { file: ".pipeline/roles/all.md", content: "COMMON" });
    assert.deepEqual(full.json.roleRuleFiles.sort(), [".claude/pipeline-roles/tester.md", ".pipeline/roles/engineer.md"]);
    assert.equal(full.json.analysisGatesFile, ".pipeline/gates.json");
    assert.equal(full.json.note, undefined);
  }));

test("get_project_rules: taskGid lookup, and an error when neither is given", () =>
  withClient(async (client, dir) => {
    writeFile(dir, ".pipeline/roles/all.md", "COMMON");
    linkTicket("T200", dir);
    const res = await callTool(client, "get_project_rules", { taskGid: "T200" });
    assert.equal(res.json.commonRules.content, "COMMON");
    const none = await callTool(client, "get_project_rules", {});
    assert.equal(none.isError, true);
    assert.equal(none.json.success, false);
  }));

for (const [tool, file, builtIn] of [
  ["get_sd_spec_template", "SD_TEMPLATE.md", "SD_TEMPLATE.md"],
  ["get_sd_spec_versioning_rules", "SD_VERSIONING_RULES.md", "SD_VERSIONING_RULES.md"],
]) {
  test(`${tool}: project version replaces the built-in one entirely`, () =>
    withClient(async (client, dir) => {
      const builtInText = fs.readFileSync(path.join(templatesDir, builtIn), "utf-8");
      writeFile(dir, `.pipeline/templates/${file}`, "PROJECT-VERSION-MARK");
      const res = await callTool(client, tool, { projectDir: dir });
      assert.equal(res.text, "PROJECT-VERSION-MARK");

      const bare = makeTmpDir("dpm-prompt-bare-");
      try {
        const fallback = await callTool(client, tool, { projectDir: bare });
        assert.equal(fallback.text, builtInText);
      } finally {
        removeDir(bare);
      }
      assert.equal((await callTool(client, tool, {})).text, builtInText);
      assert.equal((await callTool(client, tool, { taskGid: "NOPE" })).text, builtInText);
    }));

  test(`${tool}: empty project file falls back to the built-in version; taskGid works`, () =>
    withClient(async (client, dir) => {
      const builtInText = fs.readFileSync(path.join(templatesDir, builtIn), "utf-8");
      writeFile(dir, `.pipeline/templates/${file}`, "   \n");
      assert.equal((await callTool(client, tool, { projectDir: dir })).text, builtInText);
      writeFile(dir, `.pipeline/templates/${file}`, "BY-TICKET-MARK");
      linkTicket("T300", dir);
      assert.equal((await callTool(client, tool, { taskGid: "T300" })).text, "BY-TICKET-MARK");
    }));
}

test("engineer prompt: 查重/共用工具歸屬/命名/SD 來源規則在每種專案設定下都存在", () => {
  const variants = [
    getRolePrompt("engineer"),
    getRolePrompt("engineer", { testCapabilityMode: "none" }),
    getRolePrompt("engineer", { sdMode: "external" }),
    getRolePrompt("engineer", { sdMode: "self-generated", specOrder: "code_first" }),
  ];
  for (const prompt of variants) {
    assert.match(prompt, /sasd_info/, "要告訴工程師 SA\/SD 去哪讀");
    assert.match(prompt, /標題含「查重」/, "要維持實作關卡認得的「查重」標題");
    assert.match(prompt, /不要新建只裝這幾個方法的 class 或 tsx\/ts 檔/, "新的共用方法要併入既有工具類");
    assert.match(prompt, /命名要有意義/);
    assert.match(prompt, /什麼時候停下來問使用者/);
    assert.match(prompt, /commit 不是每輪必做/);
    assert.doesNotMatch(prompt, /\`\`\`java\n\/\/ SD v0\.7/, "註解反例已精簡成單行");
  }
});

test("verifier prompt: 共用工具歸屬與命名檢查在每種 sdMode 下都存在", () => {
  const variants = [
    getRolePrompt("verifier"),
    getRolePrompt("verifier", { sdMode: "external" }),
    getRolePrompt("verifier", { sdMode: "self-generated", specOrder: "code_first" }),
  ];
  for (const prompt of variants) {
    assert.match(prompt, /額外檢查共用工具歸屬與命名/);
    assert.match(prompt, /只裝少數方法的 class 或 tsx\/ts 檔/);
    assert.match(prompt, /param1/);
  }
});

test("analyst prompt: 要求列出疑似可重用的既有候選且只當線索", () => {
  const prompt = getRolePrompt("analyst");
  assert.match(prompt, /疑似可重用的既有候選/);
  assert.match(prompt, /候選線索，工程師仍須自己搜尋確認/);
  assert.match(prompt, /有列出可重用候選就要一併帶進摘要/);
});
