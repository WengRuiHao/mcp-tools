import test from "node:test";
import assert from "node:assert/strict";
import { fakeStatus } from "./helpers/support.mjs";
import { computeNextAction } from "../dist/next-action.js";
import { computeNextActionForWorkflow } from "../dist/workflow/next-action-dispatch.js";

const STAGES = ["new", "snapshot", "project_dir_confirmed", "analyzed", "sd_drafted", "implemented", "verified", "tested"];
const VERDICTS = [null, "PASS", "FAIL"];
const CONFS = [null, { confirmed: true, confirmedAt: "2026-10-01 10:00:00", note: null }, { confirmed: false, confirmedAt: "2026-10-01 10:00:00", note: "打回" }];
const SASDS = [undefined, null, { sdMode: "external", specOrder: null }, { sdMode: "self-generated", specOrder: "code_first" }];

function* samples() {
  for (const stage of STAGES)
    for (const verdict of VERDICTS)
      for (const confirmation of CONFS)
        for (const sasd of SASDS)
          yield { label: `${stage}/${verdict}/${confirmation?.confirmed}/${sasd?.sdMode}`, status: fakeStatus({ stage, verdict, confirmation, project_dir: "/p" }), ctx: { sasd } };
}

test("asana-ticket 與缺省 workflow_id 皆與直接呼叫 computeNextAction 逐字相同", () => {
  let n = 0;
  for (const { label, status, ctx } of samples()) {
    const expected = JSON.stringify(computeNextAction(status, ctx));
    assert.equal(JSON.stringify(computeNextActionForWorkflow(status, ctx, "asana-ticket")), expected, label);
    assert.equal(JSON.stringify(computeNextActionForWorkflow(status, ctx)), expected, label);
    assert.equal(JSON.stringify(computeNextActionForWorkflow(status, ctx, null)), expected, label);
    n++;
  }
  assert.ok(n >= 100);
});

test("未知 workflow 回尚未支援，不拋例外", () => {
  for (const id of ["other-flow", "", "ASANA-TICKET"]) {
    const r = computeNextActionForWorkflow(fakeStatus({ stage: "analyzed" }), {}, id);
    assert.match(r.summary, /尚未支援/);
    assert.equal(r.blockedBy.length, 1);
    assert.match(r.blockedBy[0], /尚未支援/);
    assert.deepEqual(r.suggestedTools, []);
  }
});
