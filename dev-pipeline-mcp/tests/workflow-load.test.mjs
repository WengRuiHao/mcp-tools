// load：讀專案 flow.json（沿用 gates.json 候選路徑機制）；無檔案回 null；壞檔／越權丟錯。
import test from "node:test";
import assert from "node:assert/strict";
import { makeTmpDir, removeDir, writeFile } from "./helpers/support.mjs";
import { loadProjectFlowOverride, FLOW_FILE_CANDIDATES } from "../dist/workflow/load.js";

function withDir(fn) {
  return async () => {
    const dir = makeTmpDir("dpm-flow-");
    try {
      await fn(dir);
    } finally {
      removeDir(dir);
    }
  };
}

test("候選路徑與 gates.json 對應", () => {
  assert.deepEqual(FLOW_FILE_CANDIDATES, [".pipeline/flow.json", ".claude/pipeline-roles/flow.json"]);
});

test("沒有 flow.json 回 null", withDir(async (dir) => {
  assert.equal(await loadProjectFlowOverride(dir), null);
}));

test("讀 .pipeline/flow.json", withDir(async (dir) => {
  writeFile(dir, ".pipeline/flow.json", JSON.stringify({ schemaVersion: 1, confirmDefault: "auto" }));
  assert.deepEqual(await loadProjectFlowOverride(dir), { schemaVersion: 1, confirmDefault: "auto" });
}));

test("退而讀 .claude/pipeline-roles/flow.json；.pipeline 優先", withDir(async (dir) => {
  writeFile(dir, ".claude/pipeline-roles/flow.json", JSON.stringify({ schemaVersion: 1, confirmDefault: "auto" }));
  assert.equal((await loadProjectFlowOverride(dir)).confirmDefault, "auto");
  writeFile(dir, ".pipeline/flow.json", JSON.stringify({ schemaVersion: 1, confirmDefault: "manual" }));
  assert.equal((await loadProjectFlowOverride(dir)).confirmDefault, "manual");
}));

test("壞 JSON 丟錯，不悄悄退回", withDir(async (dir) => {
  writeFile(dir, ".pipeline/flow.json", "{ not json");
  await assert.rejects(() => loadProjectFlowOverride(dir), /不是合法的 JSON/);
}));

test("越權欄位（hardStops、locked）丟錯", withDir(async (dir) => {
  writeFile(dir, ".pipeline/flow.json", JSON.stringify({ schemaVersion: 1, hardStops: [] }));
  await assert.rejects(() => loadProjectFlowOverride(dir), /不合法/);
  writeFile(dir, ".pipeline/flow.json", JSON.stringify({ schemaVersion: 1, gates: { g: { locked: false } } }));
  await assert.rejects(() => loadProjectFlowOverride(dir), /不合法/);
}));
