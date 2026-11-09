// S1：舊 Asana 工具能分辨非 Asana 工作項目——兩個寫入類工具拒絕、next-action 三處分流；Asana／缺省行為不變。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir, connectClient, callTool, isolateDataDir } from "./helpers/support.mjs";
import { registerAllTools } from "../dist/toolsets.js";
import { assignTicketDir, readStatus, advanceStage } from "../dist/pipeline-store.js";
import { computeNextAction } from "../dist/next-action.js";
import { rejectIfNonAsana } from "../dist/workflow/non-asana-guard.js";

const data = isolateDataDir();
// 建票單狀態會順手同步報告，可能 spawn 真的 asana-mcp；指到不存在的檔案讓它立刻失敗，絕不碰真實憑證。
const previousAsanaPath = process.env.ASANA_MCP_PATH;
process.env.ASANA_MCP_PATH = path.join(data.dir, "no-such-asana-mcp.js");
const projectDir = makeTmpDir("dpm-nonasana-");

test.after(async () => {
  const { closeChildMcpClients } = await import("../dist/mcp-clients.js");
  await closeChildMcpClients();
  if (previousAsanaPath === undefined) delete process.env.ASANA_MCP_PATH;
  else process.env.ASANA_MCP_PATH = previousAsanaPath;
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

let counter = 0;
/** 建一張已 snapshot 的票；workflowId 為 undefined 時不寫 workflow_id 欄位（舊格式）。 */
async function newTicket(workflowId) {
  const gid = `ng${Date.now()}${counter++}`;
  const dir = await assignTicketDir(projectDir, gid, "Proj", `T-${gid}`);
  await advanceStage(gid, "snapshot", {});
  const file = path.join(dir, "status.json");
  if (workflowId !== undefined) {
    const base = JSON.parse(fs.readFileSync(file, "utf-8"));
    fs.writeFileSync(file, JSON.stringify({ ...base, workflow_id: workflowId }, null, 2), "utf-8");
  }
  return { gid, dir, file };
}

/** 各工具的最小可呼叫參數；若守門沒擋，這些參數會走到寫入路徑。 */
function guardedCalls(gid) {
  return [
    ["advance_ticket_stage", { taskGid: gid, stage: "analyzed" }],
    ["write_ticket_artifact", { taskGid: gid, filename: "01-analysis.md", content: "x", summary: "s" }],
  ];
}

function snapshotDir(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) out[name] = fs.readFileSync(path.join(dir, name), "utf-8");
  return out;
}

test("rejectIfNonAsana：缺省與 asana-ticket 回 null，其他流程回 isError 與繁中訊息", () => {
  assert.equal(rejectIfNonAsana({}, "x"), null);
  assert.equal(rejectIfNonAsana({ workflow_id: "asana-ticket" }, "x"), null);
  const res = rejectIfNonAsana({ workflow_id: "spec-first" }, "advance_ticket_stage");
  assert.equal(res.isError, true);
  const msg = JSON.parse(res.content[0].text).message;
  assert.match(msg, /非 Asana 的工作項目/);
  assert.match(msg, /advance_ticket_stage/);
  assert.match(msg, /work_item/);
});

test("workflow_id=spec-first：advance_ticket_stage 與 write_ticket_artifact 被拒，且票單目錄內所有檔案內容不變", async () => {
  const { gid, dir } = await newTicket("spec-first");
  const before = snapshotDir(dir);
  await withClient(async (client) => {
    for (const [name, args] of guardedCalls(gid)) {
      const res = await callTool(client, name, args);
      assert.equal(res.isError, true, `${name} 應被拒絕`);
      assert.match(res.json.message, /非 Asana 的工作項目/, name);
      assert.match(res.json.message, new RegExp(name), name);
    }
  });
  assert.deepEqual(snapshotDir(dir), before);
  assert.equal((await readStatus(gid)).stage, "snapshot");
});

test("缺省與 asana-ticket 的票：兩個工具不會被非 Asana 守門擋下", async () => {
  for (const wf of [undefined, "asana-ticket"]) {
    const { gid } = await newTicket(wf);
    await withClient(async (client) => {
      for (const [name, args] of guardedCalls(gid)) {
        const res = await callTool(client, name, args);
        assert.doesNotMatch(res.text, /非 Asana 的工作項目/, `${name}（workflow_id=${wf}）`);
      }
    });
  }
});

test("缺省與 asana-ticket 的票：寫入類工具結果逐字相同（守門不影響舊行為）", async () => {
  const a = await newTicket(undefined);
  const b = await newTicket("asana-ticket");
  await withClient(async (client) => {
    const norm = (t, gid) => t.split(gid).join("<gid>");
    for (const [i, [name, argsA]] of guardedCalls(a.gid).entries()) {
      const argsB = guardedCalls(b.gid)[i][1];
      const ra = await callTool(client, name, argsA);
      const rb = await callTool(client, name, argsB);
      assert.equal(ra.isError, rb.isError, name);
      assert.equal(norm(rb.text, b.gid).replace(/T-ng\d+/g, "T"), norm(ra.text, a.gid).replace(/T-ng\d+/g, "T"), name);
    }
  });
});

// S4 更新：spec-first 已有推進引擎實作，不再是「尚未支援」，改斷言回引擎結果；
// 「尚未支援」改由非 Asana 且非 spec-first 的 "other-flow" 驗證。Asana／缺省的逐字相同斷言不變。
test("next-action 三處：spec-first 回引擎結果、其他非 Asana 回「尚未支援」；Asana／缺省與 computeNextAction 逐字相同", async () => {
  const specFirst = await newTicket("spec-first");
  const nonAsana = await newTicket("other-flow");
  const legacy = await newTicket(undefined);
  const asana = await newTicket("asana-ticket");
  await withClient(async (client) => {
    // 0) spec-first：缺 baseline／scope 時視為既有系統、前後端皆做，第一步是 baseline-survey
    const sSpec = await callTool(client, "get_ticket_status", { taskGid: specFirst.gid });
    assert.match(sSpec.json.nextAction.summary, /下一步由 baseline-survey/);
    assert.doesNotMatch(sSpec.json.nextAction.summary, /尚未支援/);
    const cSpec = await callTool(client, "record_sasd_check", { taskGid: specFirst.gid, hasSasd: false });
    assert.match(cSpec.json.nextAction.summary, /下一步由 baseline-survey/);
    const bSpec = await callTool(client, "get_role_prompt", { role: "analyst", taskGid: specFirst.gid, forSubagent: true });
    assert.match(bSpec.text, /下一步由 baseline-survey/);
    assert.doesNotMatch(bSpec.text, /尚未支援/);

    // 1) get_ticket_status（ticket-lifecycle-tools）
    const sNon = await callTool(client, "get_ticket_status", { taskGid: nonAsana.gid });
    assert.match(sNon.json.nextAction.summary, /尚未支援/);
    assert.match(sNon.json.nextAction.blockedBy.join(""), /尚未支援/);
    const sLegacy = await callTool(client, "get_ticket_status", { taskGid: legacy.gid });
    const sAsana = await callTool(client, "get_ticket_status", { taskGid: asana.gid });
    assert.deepEqual(sAsana.json.nextAction, sLegacy.json.nextAction);
    const expected = computeNextAction(await readStatus(legacy.gid), {
      syncFlags: sLegacy.json.sync_flags,
      externalChanges: sLegacy.json.external_changes,
      sasd: null,
    });
    assert.deepEqual(sLegacy.json.nextAction, JSON.parse(JSON.stringify(expected)));

    // 2) stage-response 精簡狀態（record_sasd_check）
    const args = (gid) => ({ taskGid: gid, hasSasd: false });
    const cNon = await callTool(client, "record_sasd_check", args(nonAsana.gid));
    assert.match(cNon.json.nextAction.summary, /尚未支援/);
    const cLegacy = await callTool(client, "record_sasd_check", args(legacy.gid));
    const cAsana = await callTool(client, "record_sasd_check", args(asana.gid));
    assert.deepEqual(cAsana.json.nextAction, cLegacy.json.nextAction);
    assert.doesNotMatch(cLegacy.json.nextAction.summary, /尚未支援/);

    // 3) get_role_prompt forSubagent 簡報（pipeline-info-tools）
    const bNon = await callTool(client, "get_role_prompt", { role: "analyst", taskGid: nonAsana.gid, forSubagent: true });
    assert.match(bNon.text, /尚未支援/);
    const bLegacy = await callTool(client, "get_role_prompt", { role: "analyst", taskGid: legacy.gid, forSubagent: true });
    const bAsana = await callTool(client, "get_role_prompt", { role: "analyst", taskGid: asana.gid, forSubagent: true });
    const strip = (t, gid, dir) => t.split(gid).join("<gid>").split(path.basename(dir)).join("<dir>");
    assert.equal(strip(bAsana.text, asana.gid, asana.dir), strip(bLegacy.text, legacy.gid, legacy.dir));
    assert.doesNotMatch(bLegacy.text, /尚未支援/);
  });
});
