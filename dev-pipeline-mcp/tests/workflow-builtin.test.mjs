// 內建 asana-ticket：含全部 6 個硬停點、最終驗收 locked manual、每次建立都是新物件。
import test from "node:test";
import assert from "node:assert/strict";
import { buildAsanaTicketWorkflow, ASANA_ROLE_STAGE } from "../dist/workflow/builtin/asana-ticket.js";
import { HARD_STOP_IDS } from "../dist/workflow/schema.js";

test("內建定義包含全部硬停點與 locked 最終驗收", () => {
  const d = buildAsanaTicketWorkflow();
  assert.deepEqual(d.hardStops, [...HARD_STOP_IDS]);
  const fin = d.gates.find((g) => g.id === "final-acceptance");
  assert.deepEqual([fin.locked, fin.confirmMode, fin.type], [true, "manual", "confirmation"]);
  assert.deepEqual([d.granularity, d.source, d.schemaVersion], ["feature", "asana", 1]);
});

test("每個角色都有對應 stage，且每次建立都是獨立物件", () => {
  const a = buildAsanaTicketWorkflow();
  for (const r of a.roles) assert.ok(ASANA_ROLE_STAGE[r.id], r.id);
  a.roles.pop();
  assert.equal(buildAsanaTicketWorkflow().roles.length, 6);
});
