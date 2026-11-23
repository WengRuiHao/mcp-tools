// 黃金快照：規格先行（spec-first）13 個角色說明書的輸出（問題 87 的保護網；prompts.json 只涵蓋 Asana 流程五個角色，不可更動）。
// 每個角色 × 選項組合存 sha256 與長度；沒有選項的基本版另存全文，方便檢視差異。UPDATE_GOLDEN=1 才會重寫 tests/golden/spec-first-prompts.json。
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { checkGolden } from "./helpers/golden.mjs";
import { getSpecFirstRolePrompt, SPEC_FIRST_ROLE_IDS } from "../dist/prompts-spec-first.js";

const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

const WORK_ITEM_DIR = ".dev-pipeline/work-items/001_範例";
const OPTION_SETS = {
  base: {},
  workItemDir: { workItemDir: WORK_ITEM_DIR },
  roleNotes: { roleNotes: "專案補充：一律使用繁體中文。" },
  projectGuide: { projectGuide: { title: "專案規範", text: "命名使用 camelCase。" } },
  all: { workItemDir: WORK_ITEM_DIR, roleNotes: "專案補充：一律使用繁體中文。", projectGuide: { title: "專案規範", text: "命名使用 camelCase。" } },
};

test("golden: 規格先行 13 個角色清單固定", () => {
  assert.deepEqual([...SPEC_FIRST_ROLE_IDS].sort(), [
    "arch-post", "arch-pre", "backend-engineer", "baseline-survey", "db-designer", "frontend-engineer", "mockup-designer",
    "sa-analyst", "sd-analyst", "spec-verifier", "tech-selector", "tester", "verifier",
  ]);
});

test("golden: 規格先行角色說明書與快照逐字相同", () => {
  const flat = {};
  for (const role of SPEC_FIRST_ROLE_IDS) {
    for (const [name, options] of Object.entries(OPTION_SETS)) {
      const text = getSpecFirstRolePrompt(role, options);
      flat[`role|${role}|${name}`] = { sha256: sha(text), length: text.length };
      if (name === "base") flat[`body|${role}`] = text;
    }
  }
  checkGolden("spec-first-prompts.json", flat);
});
