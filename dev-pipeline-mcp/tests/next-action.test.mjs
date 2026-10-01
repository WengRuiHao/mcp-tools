// computeNextAction：各 stage 與主要分支（純函式）。
import test from "node:test";
import assert from "node:assert/strict";
import { fakeStatus } from "./helpers/support.mjs";
import { computeNextAction } from "../dist/next-action.js";

const STAGES = ["new", "snapshot", "project_dir_confirmed", "analyzed", "sd_drafted", "implemented", "verified", "tested"];
const confirmed = (ok = true, note = null) => ({ confirmed: ok, confirmedAt: "2026-10-01 10:00:00", note });
const has = (arr, name) => arr.some((s) => s.startsWith(name));

test("new: fetch the snapshot first", () => {
  const r = computeNextAction(fakeStatus({ stage: "new" }));
  assert.deepEqual(r.suggestedTools, ["get_ticket_snapshot"]);
  assert.deepEqual(r.blockedBy, []);
  assert.match(r.summary, /stage=new/);
});

test("snapshot: blocked without project_dir, plain advance when set", () => {
  const blocked = computeNextAction(fakeStatus({ stage: "snapshot" }));
  assert.equal(blocked.blockedBy.length, 1);
  assert.match(blocked.blockedBy[0], /project_dir/);
  assert.ok(blocked.suggestedTools.includes("resolve_project_dir"));
  const ok = computeNextAction(fakeStatus({ stage: "snapshot", project_dir: "/p" }));
  assert.deepEqual(ok.blockedBy, []);
  assert.deepEqual(ok.suggestedTools, ["advance_ticket_stage"]);
});

test("project_dir_confirmed: analyst; record_sasd_check blocker until checked", () => {
  const unchecked = computeNextAction(fakeStatus({ stage: "project_dir_confirmed" }));
  assert.ok(unchecked.suggestedTools.includes("record_sasd_check"));
  assert.ok(unchecked.suggestedTools.includes("write_ticket_artifact"));
  assert.ok(unchecked.blockedBy.some((b) => b.includes("record_sasd_check")));
  assert.ok(has(unchecked.suggestedTools, "get_role_prompt"));
  const checked = computeNextAction(fakeStatus({ stage: "project_dir_confirmed", sasd_checked: true }));
  assert.deepEqual(checked.blockedBy, []);
  assert.ok(!checked.suggestedTools.includes("record_sasd_check"));
});

test("analyzed: depends on sdMode / specOrder", () => {
  const unknown = computeNextAction(fakeStatus({ stage: "analyzed" }));
  assert.ok(unknown.suggestedTools.includes("resolve_sasd_config"));
  const specFirst = computeNextAction(fakeStatus({ stage: "analyzed" }), { sasd: { sdMode: "self-generated", specOrder: "spec_first" } });
  assert.ok(specFirst.suggestedTools.includes("write_project_sd_doc"));
  assert.ok(specFirst.suggestedTools.includes('get_role_prompt({role:"spec-writer"})'));
  const codeFirst = computeNextAction(fakeStatus({ stage: "analyzed" }), { sasd: { sdMode: "self-generated", specOrder: "code_first" } });
  assert.ok(codeFirst.suggestedTools.includes('get_role_prompt({role:"engineer"})'));
  assert.ok(!codeFirst.suggestedTools.includes("write_project_sd_doc"));
  const external = computeNextAction(fakeStatus({ stage: "analyzed" }), { sasd: { sdMode: "external", specOrder: null } });
  assert.ok(external.suggestedTools.includes('get_role_prompt({role:"engineer"})'));
});

test("sd_drafted: awaiting / rejected / confirmed by specOrder", () => {
  const waiting = computeNextAction(fakeStatus({ stage: "sd_drafted", spec_confirmation: null }));
  assert.deepEqual(waiting.suggestedTools, []);
  assert.ok(waiting.blockedBy.some((b) => b.includes("record_spec_confirmation")));

  const rejected = computeNextAction(fakeStatus({ stage: "sd_drafted", spec_confirmation: confirmed(false, "fix") }));
  assert.ok(rejected.suggestedTools.includes("write_project_sd_doc"));
  assert.deepEqual(rejected.blockedBy, []);

  const specFirst = computeNextAction(fakeStatus({ stage: "sd_drafted", spec_confirmation: confirmed() }), { sasd: { sdMode: "self-generated", specOrder: "spec_first" } });
  assert.match(specFirst.summary, /implemented/);
  assert.doesNotMatch(specFirst.summary, /verified/);
  const codeFirst = computeNextAction(fakeStatus({ stage: "sd_drafted", spec_confirmation: confirmed() }), { sasd: { sdMode: "self-generated", specOrder: "code_first" } });
  assert.match(codeFirst.summary, /verified/);
  assert.doesNotMatch(codeFirst.summary, /advance_ticket_stage implemented/);
  const noCtx = computeNextAction(fakeStatus({ stage: "sd_drafted", spec_confirmation: confirmed() }));
  assert.match(noCtx.summary, /spec_first/);
  assert.match(noCtx.summary, /code_first/);
});

test("implemented -> verifier; verified -> tester / failure branch / undecided", () => {
  const impl = computeNextAction(fakeStatus({ stage: "implemented" }));
  assert.ok(impl.suggestedTools.includes('get_role_prompt({role:"verifier"})'));

  const pass = computeNextAction(fakeStatus({ stage: "verified", verdict: "PASS" }));
  assert.ok(pass.suggestedTools.includes("get_test_engineer_guide"));

  const undecided = computeNextAction(fakeStatus({ stage: "verified", verdict: null }));
  assert.deepEqual(undecided.suggestedTools, ["advance_ticket_stage"]);

  const failAnalysis = computeNextAction(fakeStatus({ stage: "verified", verdict: "FAIL", verifier_root_cause: "analysis", consecutive_fail_count: 1 }));
  assert.ok(failAnalysis.suggestedTools.includes('get_role_prompt({role:"analyst"})'));
  const failImpl = computeNextAction(fakeStatus({ stage: "verified", verdict: "FAIL", verifier_root_cause: "implementation", consecutive_fail_count: 1 }));
  assert.ok(failImpl.suggestedTools.includes('get_role_prompt({role:"engineer"})'));
  const failUnknown = computeNextAction(fakeStatus({ stage: "verified", verdict: "FAIL", verifier_root_cause: null, consecutive_fail_count: 1 }));
  assert.deepEqual(failUnknown.suggestedTools, []);
});

test("tested: closed / waiting for the human / rejected by the human / FAIL / no verdict", () => {
  const waiting = computeNextAction(fakeStatus({ stage: "tested", verdict: "PASS", confirmation: null }));
  assert.deepEqual(waiting.suggestedTools, []);
  assert.ok(waiting.blockedBy.some((b) => b.includes("record_confirmation")));

  const closed = computeNextAction(fakeStatus({ stage: "tested", verdict: "PASS", confirmation: confirmed() }));
  assert.deepEqual(closed.suggestedTools, []);
  assert.deepEqual(closed.blockedBy, []);

  const rejected = computeNextAction(fakeStatus({ stage: "tested", verdict: "PASS", confirmation: confirmed(false, "no") }));
  assert.ok(rejected.suggestedTools.includes("advance_ticket_stage"));
  assert.ok(rejected.suggestedTools.includes("write_ticket_artifact"));

  const fail = computeNextAction(fakeStatus({ stage: "tested", verdict: "FAIL", verifier_root_cause: "implementation", consecutive_fail_count: 1 }));
  assert.ok(fail.suggestedTools.includes('get_role_prompt({role:"engineer"})'));

  const none = computeNextAction(fakeStatus({ stage: "tested", verdict: null }));
  assert.deepEqual(none.suggestedTools, ["advance_ticket_stage"]);
});

test("needs_reanalysis restarts from the analyst", () => {
  const r = computeNextAction(fakeStatus({ stage: "verified", verdict: "PASS", needs_reanalysis: true, sasd_checked: true }));
  assert.ok(r.blockedBy.some((b) => b.includes("needs_reanalysis")));
  assert.ok(r.suggestedTools.includes("get_ticket_snapshot"));
  assert.ok(r.suggestedTools.includes('get_role_prompt({role:"analyst"})'));
  assert.ok(!r.suggestedTools.includes("get_test_engineer_guide"));
  const unchecked = computeNextAction(fakeStatus({ stage: "tested", needs_reanalysis: true, sasd_checked: false }));
  assert.ok(unchecked.blockedBy.some((b) => b.includes("record_sasd_check")));
});

test("human_requested_reanalysis, sync debt and external changes are blockers", () => {
  const human = computeNextAction(fakeStatus({ stage: "implemented", human_requested_reanalysis: true }));
  assert.ok(human.blockedBy.some((b) => b.includes("get_ticket_snapshot")));

  const stale = computeNextAction(fakeStatus({ stage: "implemented" }), {
    syncFlags: { analysis_stale: true, implementation_stale: true, verification_stale: true },
  });
  assert.equal(stale.blockedBy.length, 3);

  const derived = computeNextAction(fakeStatus({ stage: "implemented", sync: { analysis_hash: "b", analysis_hash_at_impl_write: "a" } }));
  assert.equal(derived.blockedBy.length, 1);
  assert.match(derived.blockedBy[0], /01/);
  // 下游還沒寫過 (快照為 null) 不算同步債
  assert.deepEqual(computeNextAction(fakeStatus({ stage: "implemented", sync: { analysis_hash: "b" } })).blockedBy, []);

  const ext = computeNextAction(fakeStatus({ stage: "implemented" }), {
    externalChanges: { analysis_externally_modified: true, implementation_externally_modified: false, verification_externally_modified: true, test_externally_modified: false },
  });
  assert.equal(ext.blockedBy.length, 1);
  assert.match(ext.blockedBy[0], /01\/03/);
  assert.match(ext.blockedBy[0], /resync_ticket_artifact/);
});

test("manual actions are counted in the summary", () => {
  const r = computeNextAction(fakeStatus({ stage: "implemented", implementation_manual_actions: ["a"], verification_manual_actions: ["b"], test_manual_actions: ["c"] }));
  assert.match(r.summary, /resolve_manual_action/);
  assert.match(r.summary, /3/);
  assert.doesNotMatch(computeNextAction(fakeStatus({ stage: "implemented" })).summary, /resolve_manual_action/);
});

test("three consecutive FAILs: stop and ask the human, never suggest an automatic re-run", () => {
  for (const stage of ["verified", "tested", "implemented", "analyzed"]) {
    const r = computeNextAction(fakeStatus({ stage, verdict: "FAIL", verifier_root_cause: "implementation", consecutive_fail_count: 3 }));
    assert.deepEqual(r.suggestedTools, [], stage);
    assert.ok(r.blockedBy.some((b) => b.includes("needs_human_review")), stage);
    assert.ok(r.blockedBy.some((b) => b.includes("3")), stage);
    assert.doesNotMatch(r.summary, /advance_ticket_stage/);
  }
  const more = computeNextAction(fakeStatus({ stage: "verified", verdict: "FAIL", consecutive_fail_count: 5 }));
  assert.deepEqual(more.suggestedTools, []);
  // needs_reanalysis 不能蓋過停下來問人
  const both = computeNextAction(fakeStatus({ stage: "verified", verdict: "FAIL", consecutive_fail_count: 3, needs_reanalysis: true }));
  assert.deepEqual(both.suggestedTools, []);
  // 2 次還不算
  const two = computeNextAction(fakeStatus({ stage: "verified", verdict: "FAIL", verifier_root_cause: "implementation", consecutive_fail_count: 2 }));
  assert.ok(two.suggestedTools.length > 0);
  assert.ok(!two.blockedBy.some((b) => b.includes("needs_human_review")));
});

test("summary is always at most 600 characters and mentions the stage", () => {
  const verdicts = [null, "PASS", "FAIL"];
  const flags = [{}, { needs_reanalysis: true }, { human_requested_reanalysis: true }, { consecutive_fail_count: 3 }];
  for (const stage of STAGES) {
    for (const verdict of verdicts) {
      for (const flag of flags) {
        const r = computeNextAction(
          fakeStatus({
            stage, verdict, ...flag,
            implementation_manual_actions: ["x".repeat(400)], verification_manual_actions: ["y"], test_manual_actions: ["z"],
          }),
          { syncFlags: { analysis_stale: true, implementation_stale: true, verification_stale: true } }
        );
        assert.ok(r.summary.length <= 600, `${stage}/${verdict}/${JSON.stringify(flag)} -> ${r.summary.length}`);
        assert.ok(r.summary.includes(`stage=${stage}`));
        assert.equal(new Set(r.suggestedTools).size, r.suggestedTools.length);
      }
    }
  }
});
