// project_config kind:"flow"：唯讀 resolve，套用專案 flow.json，拒絕越權覆寫與 register。
import test from "node:test";
import assert from "node:assert/strict";
import { makeTmpDir, removeDir, writeFile, isolateDataDir, connectClient, callTool } from "./helpers/support.mjs";
import { registerProjectConfigTools } from "../dist/project-config-tools.js";

function withConfig(fn) {
  return async () => {
    const data = isolateDataDir();
    const dir = makeTmpDir("dpm-flowcfg-");
    const conn = await connectClient(registerProjectConfigTools);
    const call = (args) => callTool(conn.client, "project_config", args);
    try {
      await fn(call, dir);
    } finally {
      await conn.close();
      removeDir(dir);
      data.cleanup();
    }
  };
}

async function setup(call, dir, sdMode = "self-generated", specOrder = "spec_first") {
  await call({ kind: "project_dir", action: "register", projectGid: "PF", projectDir: dir });
  const extra = sdMode === "self-generated" ? { sdOutputPath: "sd.md", specOrder } : {};
  const reg = await call({ kind: "sasd_config", action: "register", projectGid: "PF", saRoot: "N/A-x", sdMode, ...extra });
  assert.equal(reg.json.success, true);
}

test("flow resolve：依 spec_first 展開角色與關卡，locked 關卡為 manual", withConfig(async (call, dir) => {
  await setup(call, dir);
  const r = await call({ kind: "flow", action: "resolve", projectGid: "PF" });
  assert.equal(r.json.readOnly, true);
  assert.deepEqual(r.json.roles.map((x) => x.id), ["analyst", "spec-writer-first", "engineer", "verifier", "tester"]);
  const fin = r.json.gates.find((g) => g.id === "final-acceptance");
  assert.deepEqual([fin.locked, fin.confirm], [true, "manual"]);
  assert.equal(r.json.hardStops.length, 6);
  assert.equal(r.json.overrideApplied, false);
}));

test("flow resolve：套用 flow.json 的 confirmMode 覆寫", withConfig(async (call, dir) => {
  await setup(call, dir, "unregistered", null);
  writeFile(dir, ".pipeline/flow.json", JSON.stringify({ schemaVersion: 1, confirmDefault: "auto" }));
  const r = await call({ kind: "flow", action: "resolve", projectGid: "PF" });
  assert.equal(r.json.overrideApplied, true);
  assert.equal(r.json.gates.find((g) => g.id === "verdict").confirm, "auto");
  assert.equal(r.json.gates.find((g) => g.id === "final-acceptance").confirm, "manual");
}));

test("flow resolve：覆寫 locked 關卡被拒、壞 flow.json 回錯誤", withConfig(async (call, dir) => {
  await setup(call, dir, "unregistered", null);
  writeFile(dir, ".pipeline/flow.json", JSON.stringify({ schemaVersion: 1, gates: { "final-acceptance": { confirmMode: "auto" } } }));
  const r = await call({ kind: "flow", action: "resolve", projectGid: "PF" });
  assert.equal(r.json.success, false);
  assert.match(r.json.message, /locked/);
  writeFile(dir, ".pipeline/flow.json", "{ bad");
  const bad = await call({ kind: "flow", action: "resolve", projectGid: "PF" });
  assert.equal(bad.json.success, false);
}));

test("flow：register 被拒（唯讀）；缺 projectGid 回缺欄位", withConfig(async (call) => {
  const reg = await call({ kind: "flow", action: "register", projectGid: "PF" });
  assert.equal(reg.json.success, false);
  assert.match(reg.json.message, /只支援 action="resolve"/);
  const miss = await call({ kind: "flow", action: "resolve" });
  assert.match(miss.json.message, /缺少欄位 projectGid/);
}));

test("flow resolve：專案尚未登記任何設定時仍回傳最小流程並附 warning", withConfig(async (call) => {
  const r = await call({ kind: "flow", action: "resolve", projectGid: "NONE" });
  assert.equal(r.json.found, true);
  assert.ok(r.json.warnings.length > 0);
}));

test("M1：flow.json checks 追加到 gates.json 對映的既有檢查，空陣列不清掉", withConfig(async (call, dir) => {
  await setup(call, dir, "unregistered", null);
  writeFile(dir, ".pipeline/gates.json", JSON.stringify({ implementationSections: [{ ticketNamePattern: ".*", heading: "查重", minChars: 40 }] }));
  const ids = async () => (await call({ kind: "flow", action: "resolve", projectGid: "PF" })).json.gates.find((g) => g.id === "implementation-content").checks.map((c) => c.id);
  writeFile(dir, ".pipeline/flow.json", JSON.stringify({ schemaVersion: 1, gates: { "implementation-content": { checks: [] } } }));
  assert.deepEqual(await ids(), ["implementation-section-1"]);
  writeFile(dir, ".pipeline/flow.json", JSON.stringify({ schemaVersion: 1, gates: { "implementation-content": { checks: [{ id: "x", description: "d" }, { id: "implementation-section-1", description: "專案版" }] } } }));
  assert.deepEqual(await ids(), ["implementation-section-1", "x"]);
}));

test("M2：角色 optional 帶出，並警告階段 1 只宣告不生效", withConfig(async (call, dir) => {
  await setup(call, dir, "unregistered", null);
  const none = await call({ kind: "flow", action: "resolve", projectGid: "PF" });
  assert.ok(!none.json.warnings.some((w) => /optional/.test(w)));
  writeFile(dir, ".pipeline/flow.json", JSON.stringify({ schemaVersion: 1, roles: { tester: { optional: true } } }));
  const r = await call({ kind: "flow", action: "resolve", projectGid: "PF" });
  assert.equal(r.json.roles.find((x) => x.id === "tester").optional, true);
  assert.ok(r.json.warnings.some((w) => /optional 只宣告、不影響角色是否出現/.test(w)));
}));

test("L4：登記的專案目錄不存在時視為不可用（projectDir 為 null）", withConfig(async (call, dir) => {
  await call({ kind: "project_dir", action: "register", projectGid: "PG", projectDir: dir });
  removeDir(dir);
  const r = await call({ kind: "flow", action: "resolve", projectGid: "PG" });
  assert.equal(r.json.projectDir, null);
  assert.equal(r.json.overrideApplied, false);
}));

test("L5：gates.json 形狀錯誤回清楚訊息", withConfig(async (call, dir) => {
  await setup(call, dir, "unregistered", null);
  writeFile(dir, ".pipeline/gates.json", JSON.stringify({ analysisReferences: [{ ticketNamePattern: ".*", pathPrefix: "src/" }] }));
  const r = await call({ kind: "flow", action: "resolve", projectGid: "PF" });
  assert.equal(r.json.success, false);
  assert.match(r.json.message, /gates\.json 不合法.*heading/);
}));
