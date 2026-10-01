// get_pipeline_overview 的分章、字數與關鍵內容；resolve_xxx found:false 時的 instructions。
import test from "node:test";
import assert from "node:assert/strict";
import { makeTmpDir, removeDir, connectClient, callTool, isolateDataDir } from "./helpers/support.mjs";
import { registerPipelineInfoTools } from "../dist/pipeline-info-tools.js";
import { registerProjectConfigTools } from "../dist/project-config-tools.js";
import { getOverview, OVERVIEW_SECTIONS } from "../dist/overview-prompts.js";

const data = isolateDataDir();
const savedDisable = process.env.DEV_PIPELINE_DISABLE_TOOLSETS;
delete process.env.DEV_PIPELINE_DISABLE_TOOLSETS;
test.after(() => {
  data.cleanup();
  if (savedDisable !== undefined) process.env.DEV_PIPELINE_DISABLE_TOOLSETS = savedDisable;
});

const CORE_BUDGET = 9500;
const APPENDIX_A_TITLE = "附錄 A"; // appendix A
const APPENDIX_B_TITLE = "附錄 B";
const APPENDIX_C_TITLE = "附錄 C";

async function withClient(fn) {
  const conn = await connectClient((s) => {
    registerPipelineInfoTools(s);
    registerProjectConfigTools(s);
  });
  try {
    await fn(conn.client);
  } finally {
    await conn.close();
  }
}

test("overview: default section is core and fits the character budget", () =>
  withClient(async (client) => {
    const res = await callTool(client, "get_pipeline_overview", {});
    assert.equal(res.isError, false);
    assert.equal(res.text, getOverview("core"));
    assert.ok(res.text.length <= CORE_BUDGET, `core is ${res.text.length} chars`);
    assert.ok(res.text.length > 1000);
    assert.ok(!res.text.includes(APPENDIX_A_TITLE));
  }));

test("overview: core mentions the key tools and flags", () =>
  withClient(async (client) => {
    const { text } = await callTool(client, "get_pipeline_overview", { section: "core" });
    for (const needle of [
      "get_ticket_snapshot", "record_sasd_check", "awaitingConfirmation", "humanRejected", "humanRequestedReanalysis",
      "needsReanalysis", "advance_ticket_stage", "get_role_prompt",
    ]) {
      assert.ok(text.includes(needle), `core lost ${needle}`);
    }
  }));

test("overview: every section is retrievable and all is the superset", () =>
  withClient(async (client) => {
    assert.deepEqual([...OVERVIEW_SECTIONS].sort(), ["all", "appendix-a", "appendix-b", "appendix-c", "core", "setup"]);
    const texts = {};
    for (const section of OVERVIEW_SECTIONS) {
      const res = await callTool(client, "get_pipeline_overview", { section });
      assert.equal(res.isError, false, section);
      assert.ok(res.text.length > 100, section);
      texts[section] = res.text;
    }
    assert.ok(texts.all.length >= texts.core.length);
    for (const section of ["core", "setup", "appendix-a", "appendix-b", "appendix-c"]) {
      assert.ok(texts.all.includes(texts[section]), `all lacks ${section}`);
    }
    assert.ok(texts.all.includes(APPENDIX_A_TITLE));
    assert.ok(texts.all.includes(APPENDIX_B_TITLE));
    assert.ok(texts.all.includes(APPENDIX_C_TITLE));
    assert.ok(texts["appendix-a"].includes(APPENDIX_A_TITLE));
    assert.ok(texts["appendix-b"].includes(APPENDIX_B_TITLE));
    assert.ok(texts["appendix-c"].includes(APPENDIX_C_TITLE));
    assert.ok(texts.setup.includes("register_sasd_config"));
  }));

test("overview: an unknown section is rejected by the schema", () =>
  withClient(async (client) => {
    const res = await client.callTool({ name: "get_pipeline_overview", arguments: { section: "nope" } }).catch((e) => ({ isError: true, error: e }));
    assert.equal(res.isError, true);
  }));

test("overview: bridge-disabled note is appended only when the bridge group is off", () =>
  withClient(async (client) => {
    const plain = (await callTool(client, "get_pipeline_overview", {})).text;
    process.env.DEV_PIPELINE_DISABLE_TOOLSETS = "bridge";
    try {
      const noted = (await callTool(client, "get_pipeline_overview", {})).text;
      assert.ok(noted.startsWith(plain));
      assert.ok(noted.length > plain.length);
    } finally {
      delete process.env.DEV_PIPELINE_DISABLE_TOOLSETS;
    }
  }));

test("resolve_xxx: found:false carries instructions that match the setup section", () =>
  withClient(async (client) => {
    const dir = makeTmpDir("dpm-overview-");
    try {
      const setup = (await callTool(client, "get_pipeline_overview", { section: "setup" })).text;
      const calls = [
        ["resolve_default_project", { cwd: dir }],
        ["resolve_project_dir", { projectGid: "NO-SUCH-PROJECT" }],
        ["resolve_sasd_config", { projectGid: "NO-SUCH-PROJECT" }],
        ["resolve_git_roots", { projectDir: dir }],
      ];
      for (const [name, args] of calls) {
        const res = await callTool(client, name, args);
        assert.equal(res.isError, false, name);
        assert.equal(res.json.found, false, name);
        assert.equal(res.json.needsInput, true, name);
        assert.equal(typeof res.json.instructions, "string", name);
        assert.ok(res.json.instructions.length > 50, name);
        assert.ok(setup.includes(res.json.instructions), `${name} instructions differ from the setup section`);
      }
    } finally {
      removeDir(dir);
    }
  }));

test("resolve_project_dir: found:true after register_project_dir (no instructions)", () =>
  withClient(async (client) => {
    const dir = makeTmpDir("dpm-overview-");
    try {
      await callTool(client, "register_project_dir", { projectGid: "P-OVERVIEW", projectDir: dir });
      const res = await callTool(client, "resolve_project_dir", { projectGid: "P-OVERVIEW" });
      assert.deepEqual(res.json, { found: true, projectDir: dir });
    } finally {
      removeDir(dir);
    }
  }));
