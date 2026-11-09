// S4：getRolePrompt 的 flowRoleNotes 與 get_role_prompt 取專案 flow.json roleNotes。
import test from "node:test";
import assert from "node:assert/strict";
import { makeTmpDir, removeDir, writeFile, connectClient, callTool, isolateDataDir } from "./helpers/support.mjs";
import { registerPipelineInfoTools } from "../dist/pipeline-info-tools.js";
import { getRolePrompt } from "../dist/prompts.js";
import { getOverview } from "../dist/overview-prompts.js";

const SEP = "\n\n---\n\n";
const HEAD = "## 專案 flow 補充說明";
const data = isolateDataDir();
test.after(() => data.cleanup());

async function withClient(fn) {
  const dir = makeTmpDir("dpm-rolenotes-");
  const conn = await connectClient((s) => registerPipelineInfoTools(s));
  try {
    await fn(conn.client, dir);
  } finally {
    await conn.close();
    removeDir(dir);
  }
}
const flow = (roles) => JSON.stringify({ schemaVersion: 1, roles });

test("flowRoleNotes: 附在通用說明之後，含標題與內容", () => {
  const base = getRolePrompt("engineer");
  const out = getRolePrompt("engineer", { flowRoleNotes: "NOTE-A" });
  assert.ok(out.startsWith(base));
  assert.equal(out.slice(base.length), `\n${HEAD}\nNOTE-A\n`);
  const arr = getRolePrompt("engineer", { flowRoleNotes: ["N1", "N2"] });
  assert.ok(arr.includes(`${HEAD}\nN1\n\nN2\n`));
});

test("flowRoleNotes: 沒有、空字串、空陣列、null 都與沒傳逐字相同", () => {
  for (const role of ["analyst", "spec-writer", "engineer", "verifier", "tester"]) {
    const base = getRolePrompt(role);
    for (const v of [undefined, null, "", "  ", [], [""]]) {
      assert.equal(getRolePrompt(role, { flowRoleNotes: v }), base);
    }
  }
});

test("core overview 不受影響且不超過 8000 字元", () => {
  assert.ok(getOverview("core").length <= 8000);
});

test("get_role_prompt: 專案 flow.json 的 roleNotes 附在通用說明後、專案規則檔之前", () =>
  withClient(async (client, dir) => {
    writeFile(dir, ".pipeline/flow.json", flow({ engineer: { roleNotes: "FLOW-NOTE" }, "spec-writer-first": { roleNotes: "SW-NOTE" }, "sa-analyst": { roleNotes: "NO-MAP" } }));
    writeFile(dir, ".pipeline/roles/all.md", "COMMON-MARK");
    const res = await callTool(client, "get_role_prompt", { role: "engineer", projectDir: dir });
    const base = getRolePrompt("engineer", { flowRoleNotes: "FLOW-NOTE" });
    assert.equal(res.text.split(SEP)[0], base);
    assert.ok(res.text.indexOf("FLOW-NOTE") < res.text.indexOf("COMMON-MARK"));
    assert.ok(!res.text.includes("NO-MAP"));
    const sw = await callTool(client, "get_role_prompt", { role: "spec-writer", projectDir: dir });
    assert.ok(sw.text.includes("SW-NOTE"));
    const an = await callTool(client, "get_role_prompt", { role: "analyst", projectDir: dir });
    assert.equal(an.text.split(SEP)[0], getRolePrompt("analyst"));
  }));

test("get_role_prompt: 沒有 flow.json、flow.json 壞掉、無該角色 notes 時逐字不變", () =>
  withClient(async (client, dir) => {
    const base = getRolePrompt("verifier");
    assert.equal((await callTool(client, "get_role_prompt", { role: "verifier", projectDir: dir })).text, base);
    writeFile(dir, ".pipeline/flow.json", "{ not json");
    assert.equal((await callTool(client, "get_role_prompt", { role: "verifier", projectDir: dir })).text, base);
    writeFile(dir, ".pipeline/flow.json", flow({ engineer: { roleNotes: "X" } }));
    assert.equal((await callTool(client, "get_role_prompt", { role: "verifier", projectDir: dir })).text, base);
  }));

test("legacy 轉出的 roleNotes 不會被附加（無 flow.json 覆寫時 engineer／tester 輸出不變）", () =>
  withClient(async (client, dir) => {
    writeFile(dir, ".pipeline/flow.json", flow({ analyst: { optional: false } }));
    for (const role of ["engineer", "tester"]) {
      const res = await callTool(client, "get_role_prompt", { role, projectDir: dir });
      assert.equal(res.text, getRolePrompt(role));
    }
  }));
