// 批次 1-C：兩個互斥架構角色 arch-pre（全新系統，SA 之前）與 arch-post（既有系統，SA 之後），只在 highRisk 時啟用。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, fulfil } from "./helpers/work-item-env.mjs";
import { getBuiltinWorkflow } from "../dist/workflow/stage-order.js";
import { resolveWorkflow } from "../dist/workflow/resolve.js";
import { buildWhenContext } from "../dist/work-item-store.js";
import { KNOWN_WHEN_KEYS, validateWorkflow } from "../dist/workflow/validate.js";
import { getSpecFirstRolePrompt, SPEC_FIRST_ROLE_IDS } from "../dist/prompts-spec-first.js";

const def = getBuiltinWorkflow("spec-first");
const ids = (st) => resolveWorkflow(def, buildWhenContext({ scope: "both", has_db: true, ...st })).roles.map((r) => r.id);
const before = (list, a, b) => list.indexOf(a) >= 0 && list.indexOf(a) < list.indexOf(b);

test("流程定義合法（含新角色、新產出物與關卡）", () => {
  assert.deepEqual(validateWorkflow(def, KNOWN_WHEN_KEYS), []);
  assert.ok(def.artifacts.some((a) => a.id === "arch" && a.file === "architecture.md"));
  assert.ok(def.gates.some((g) => g.id === "arch-confirm" && g.type === "confirmation" && g.confirmMode === "manual"));
});

test("沒開 highRisk：啟用的角色與過去完全相同，沒有架構角色與 arch-confirm", () => {
  const green = ids({ baseline: "greenfield" });
  assert.deepEqual(green, ["tech-selector", "mockup-designer", "sa-analyst", "db-designer", "sd-analyst", "spec-verifier", "frontend-engineer", "backend-engineer", "verifier", "tester"]);
  const brown = ids({ baseline: "brownfield" });
  assert.deepEqual(brown, ["baseline-survey", "tech-selector", "mockup-designer", "sa-analyst", "db-designer", "sd-analyst", "spec-verifier", "frontend-engineer", "backend-engineer", "verifier", "tester"]);
  const resolved = resolveWorkflow(def, buildWhenContext({ baseline: "greenfield", scope: "both", has_db: true }));
  assert.ok(!resolved.gates.some((g) => g.id === "arch-confirm"));
});

test("highRisk＋全新系統：只有 arch-pre，排在技術選型之後、SA 之前，DB 與 SD 都在它之後", () => {
  const l = ids({ baseline: "greenfield", high_risk: true });
  assert.ok(l.includes("arch-pre") && !l.includes("arch-post"));
  assert.ok(before(l, "tech-selector", "arch-pre"));
  assert.ok(before(l, "arch-pre", "sa-analyst"));
  assert.ok(before(l, "arch-pre", "db-designer") && before(l, "arch-pre", "sd-analyst"));
  assert.ok(resolveWorkflow(def, buildWhenContext({ baseline: "greenfield", scope: "both", has_db: true, high_risk: true })).gates.some((g) => g.id === "arch-confirm"));
});

test("highRisk＋既有系統：只有 arch-post，排在 SA 之後，DB 與 SD 之前（沒有 DB 時 SD 也在它之後）", () => {
  const l = ids({ baseline: "brownfield", high_risk: true });
  assert.ok(l.includes("arch-post") && !l.includes("arch-pre"));
  assert.ok(before(l, "sa-analyst", "arch-post") && before(l, "arch-post", "db-designer") && before(l, "arch-post", "sd-analyst"));
  const noDb = ids({ baseline: "brownfield", high_risk: true, has_db: false });
  assert.ok(!noDb.includes("db-designer") && before(noDb, "arch-post", "sd-analyst"));
});

test("架構角色說明書：兩個 id 同一份內容、長度合理、角色清單固定為 13 個", () => {
  assert.ok(SPEC_FIRST_ROLE_IDS.includes("arch-pre") && SPEC_FIRST_ROLE_IDS.includes("arch-post") && SPEC_FIRST_ROLE_IDS.length === 13);
  const a = getSpecFirstRolePrompt("arch-pre");
  assert.equal(a, getSpecFirstRolePrompt("arch-post"));
  assert.ok(a.length >= 800 && a.length <= 2500, `長度 ${a.length}`);
  for (const w of ["architecture.md", "資料庫", "MQ", "語言", "一致性"]) assert.ok(a.includes(w), w);
});

const env = await setupEnv("wi-arch-");
after(() => env.cleanup());
const create = async (extra) => {
  const c = await env.call({ action: "create", projectDir: env.projectDir, title: "架構", requirement: "高併發", baseline: "greenfield", scope: "both", hasDb: true, techSource: "new-guided", styleSource: "new-guided", ...extra });
  assert.equal(c.isError, false, JSON.stringify(c.json));
  return c.json;
};

test("工具：技術確認後輪到 arch-pre；交件前必須有 architecture.md，交件後停在 arch-confirm 等使用者", async () => {
  const c = await create({ highRisk: true });
  const id = c.workItemId;
  const rp = await env.call({ action: "role_prompt", workItemId: id, roleId: "arch-pre" });
  assert.equal(rp.isError, false);
  assert.match(rp.json.prompt, /架構師/);
  await fulfil(c.dir, "tech-selector");
  assert.equal((await env.call({ action: "done", workItemId: id, roleId: "tech-selector" })).isError, false);
  const conf = await env.call({ action: "confirm", workItemId: id, gateId: "tech-confirm", decision: "confirmed", by: "human", reason: "使用者說技術棧確認" });
  assert.equal(conf.isError, false, JSON.stringify(conf.json));
  const g = await env.call({ action: "get", workItemId: id });
  assert.equal(g.json.nextRoles[0].roleId, "arch-pre");
  const noFile = await env.call({ action: "done", workItemId: id, roleId: "arch-pre" });
  assert.equal(noFile.isError, true);
  assert.match(JSON.stringify(noFile.json), /architecture\.md/);
  await writeFile(path.join(c.dir, "architecture.md"), "## 架構來源\n全新決策\n");
  const ok = await env.call({ action: "done", workItemId: id, roleId: "arch-pre" });
  assert.equal(ok.isError, false, JSON.stringify(ok.json));
  const after = await env.call({ action: "get", workItemId: id });
  assert.ok(after.json.waitingGates.some((x) => x.gateId === "arch-confirm" && x.waitingFor === "user"), JSON.stringify(after.json.waitingGates));
});

test("工具：一般工作項目不能對 arch-pre 交件（角色未啟用）", async () => {
  const c = await create({});
  await mkdir(c.dir, { recursive: true });
  await writeFile(path.join(c.dir, "architecture.md"), "x");
  const dn = await env.call({ action: "done", workItemId: c.workItemId, roleId: "arch-pre" });
  assert.equal(dn.isError, true);
});
