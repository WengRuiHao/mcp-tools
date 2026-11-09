// 依票名切換 profile 的票層級行為：get_role_prompt（帶 taskGid）、get_ticket_status 的 stepPlan、
// prepare_project／project_config 的預設值標示、進行中的報表票仍是 code_first。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir, isolateDataDir, connectClient, callTool } from "./helpers/support.mjs";
import { registerPipelineInfoTools } from "../dist/pipeline-info-tools.js";
import { registerProjectConfigTools } from "../dist/project-config-tools.js";
import { registerTicketLifecycleTools } from "../dist/ticket-lifecycle-tools.js";
import { registerProjectDir } from "../dist/project-registry.js";
import { getRolePrompt } from "../dist/prompts.js";

const GID = "p-test-1";
const REPORT_PATTERN = "RPT|a_report_";
const REPORT_TICKET = "RPT-001 月報表調整";
const FEATURE_TICKET = "新增 翻新功能";
const SASD = { saRoot: "N/A-sa", sdMode: "self-generated", sdRoot: null, sdOutputPath: "doc/sd", svnConnectionId: null };
const PROFILES = [
  { match: { projectGid: GID, ticketNamePattern: REPORT_PATTERN }, sasd: { ...SASD, specOrder: "code_first" } },
  { match: { projectGid: GID }, sasd: { ...SASD, specOrder: "spec_first" } },
];

const savedDisable = process.env.DEV_PIPELINE_DISABLE_TOOLSETS;
delete process.env.DEV_PIPELINE_DISABLE_TOOLSETS;
test.after(() => {
  if (savedDisable !== undefined) process.env.DEV_PIPELINE_DISABLE_TOOLSETS = savedDisable;
});

function withTickets(profiles, fn) {
  return async () => {
    const data = isolateDataDir();
    const dir = makeTmpDir("dpm-flowtix-");
    const store = await import("../dist/pipeline-store.js");
    const conn = await connectClient((s) => {
      registerPipelineInfoTools(s);
      registerProjectConfigTools(s);
      registerTicketLifecycleTools(s);
    });
    try {
      await registerProjectDir(GID, dir);
      fs.mkdirSync(path.join(dir, ".pipeline"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".pipeline", "settings.json"), JSON.stringify({ flow: { profiles } }));
      const makeTicket = async (taskGid, name, stage = "analyzed") => {
        await store.assignTicketDir(dir, taskGid, "Proj", taskGid, null, name);
        await store.recordProjectContext(taskGid, dir, "Proj", name, null, false, GID);
        if (stage !== "new") await store.advanceStage(taskGid, stage);
      };
      await fn({ client: conn.client, dir, makeTicket, call: (n, a) => callTool(conn.client, n, a) });
    } finally {
      await conn.close();
      removeDir(dir);
      data.cleanup();
    }
  };
}

const rolePrompt = (call, role, taskGid) => call("get_role_prompt", { role, taskGid });

test("get_role_prompt（帶 taskGid）：報表票出 code_first 版、非報表票出 spec_first 版", withTickets(PROFILES, async ({ call, makeTicket }) => {
  await makeTicket("t-rpt", REPORT_TICKET);
  await makeTicket("t-feat", FEATURE_TICKET);
  for (const role of ["spec-writer", "engineer"]) {
    const rpt = await rolePrompt(call, role, "t-rpt");
    const feat = await rolePrompt(call, role, "t-feat");
    assert.ok(rpt.text.startsWith(getRolePrompt(role, { sdMode: "self-generated", specOrder: "code_first", testCapabilityMode: null, flowRoleNotes: [] })), `${role} report`);
    assert.ok(feat.text.startsWith(getRolePrompt(role, { sdMode: "self-generated", specOrder: "spec_first", testCapabilityMode: null, flowRoleNotes: [] })), `${role} feature`);
    assert.notEqual(rpt.text, feat.text);
  }
}));

test("get_ticket_status：每張票各自的 stepPlan（報表票含 3.6、非報表票含 3.4）", withTickets(PROFILES, async ({ call, makeTicket }) => {
  await makeTicket("t-rpt", REPORT_TICKET);
  await makeTicket("t-feat", FEATURE_TICKET);
  const rpt = (await call("get_ticket_status", { taskGid: "t-rpt" })).json;
  const feat = (await call("get_ticket_status", { taskGid: "t-feat" })).json;
  assert.equal(rpt.stepPlan.specOrder, "code_first");
  assert.ok(rpt.stepPlan.steps.includes("3.6") && !rpt.stepPlan.steps.includes("3.4"));
  assert.equal(feat.stepPlan.specOrder, "spec_first");
  assert.ok(feat.stepPlan.steps.includes("3.4") && !feat.stepPlan.steps.includes("3.6"));
}));

test("進行中的報表票（已 implemented）重新比對仍是 code_first", withTickets(PROFILES, async ({ call, makeTicket }) => {
  await makeTicket("t-run", "a_report_sales 銷售報表", "implemented");
  const res = (await call("get_ticket_status", { taskGid: "t-run" })).json;
  assert.equal(res.stage, "implemented");
  assert.equal(res.stepPlan.specOrder, "code_first");
  assert.equal(res.flowProfileError, undefined);
  const { sasdForStatus } = await import("../dist/stage-response.js");
  const store = await import("../dist/pipeline-store.js");
  assert.equal((await sasdForStatus(await store.readStatus("t-run"))).specOrder, "code_first");
}));

test("設定有誤（多筆同時符合）時 get_ticket_status 明確回報 flowProfileError，不悄悄略過", withTickets(
  [...PROFILES, { match: { projectGid: GID, ticketNamePattern: "月報" }, sasd: { ...SASD, specOrder: "spec_first" } }],
  async ({ call, makeTicket }) => {
    await makeTicket("t-both", REPORT_TICKET);
    const res = (await call("get_ticket_status", { taskGid: "t-both" })).json;
    assert.match(res.flowProfileError, /同時符合票名/);
    assert.equal(res.stepPlan, undefined);
  }
));

test("舊格式（單筆、沒有 pattern）：get_ticket_status 的 stepPlan 與票名無關", withTickets(
  [{ match: { projectGid: GID }, sasd: { ...SASD, specOrder: "spec_first" } }],
  async ({ call, makeTicket }) => {
    await makeTicket("t-1", REPORT_TICKET);
    assert.equal((await call("get_ticket_status", { taskGid: "t-1" })).json.stepPlan.specOrder, "spec_first");
  }
));

test("prepare_project：回預設 profile 的 stepPlan，並標示預設值與其他 profile 摘要", withTickets(PROFILES, async ({ call, dir }) => {
  const res = (await call("prepare_project", { projectGid: GID, cwd: dir })).json;
  assert.equal(res.sasd.specOrder, "spec_first");
  assert.equal(res.stepPlan.specOrder, "spec_first");
  assert.equal(res.sasdAndStepPlanAreDefaults, true);
  assert.match(res.ticketNameProfiles.notice, /預設值.*依票名/);
  assert.equal(res.ticketNameProfiles.hasDefaultProfile, true);
  const byPattern = Object.fromEntries(res.ticketNameProfiles.profiles.map((p) => [String(p.ticketNamePattern), p]));
  assert.ok(byPattern[REPORT_PATTERN].stepPlanSteps.includes("3.6"));
  assert.equal(byPattern[REPORT_PATTERN].isDefault, false);
  assert.ok(byPattern["null"].stepPlanSteps.includes("3.4"));
  assert.equal(byPattern["null"].isDefault, true);
}));

test("prepare_project：舊格式輸出不多任何欄位", withTickets([{ match: { projectGid: GID }, sasd: { ...SASD, specOrder: "spec_first" } }], async ({ call, dir }) => {
  const res = (await call("prepare_project", { projectGid: GID, cwd: dir })).json;
  assert.equal("ticketNameProfiles" in res, false);
  assert.equal("sasdAndStepPlanAreDefaults" in res, false);
  assert.equal("configError" in res, false);
}));

test("prepare_project：全部都有 pattern（沒有預設）-> configError 清楚訊息、ready false，不誤報成缺 sasd_config", withTickets(
  [PROFILES[0]],
  async ({ call, dir }) => {
    const res = (await call("prepare_project", { projectGid: GID, cwd: dir })).json;
    assert.equal(res.ready, false);
    assert.match(res.configError, /沒有預設 profile/);
    assert.equal(res.missing.some((m) => m.kind === "sasd_config"), false);
    assert.match(res.nextStep, /修正/);
  }
));

test("project_config resolve：回預設值並標示、列出其他 profile；沒有預設時回明確錯誤", withTickets(PROFILES, async ({ call }) => {
  const sasd = (await call("project_config", { kind: "sasd_config", action: "resolve", projectGid: GID })).json;
  assert.equal(sasd.specOrder, "spec_first");
  assert.match(sasd.ticketNameProfiles.notice, /預設值/);
  assert.equal(sasd.ticketNameProfiles.profiles.length, 2);
}));

test("project_config resolve：沒有預設 profile 時明確回錯誤", withTickets([PROFILES[0]], async ({ call }) => {
  for (const kind of ["sasd_config", "test_capability", "legacy_test_profile"]) {
    const res = await call("project_config", { kind, action: "resolve", projectGid: GID });
    assert.equal(res.isError, true, kind);
    assert.match(res.json.message, /沒有預設 profile/);
  }
}));
