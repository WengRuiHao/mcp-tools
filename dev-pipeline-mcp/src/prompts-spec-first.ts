import { renderRolePrompt, type RoleSections, type SpecFirstPromptOptions } from "./prompts-spec-first/common.js";
import { BASELINE_SURVEY, MOCKUP_DESIGNER } from "./prompts-spec-first/survey-design.js";
import { TECH_SELECTOR } from "./prompts-spec-first/tech-select.js";
import { DB_DESIGNER, FLOW_ANALYST, SA_ANALYST } from "./prompts-spec-first/sa-db-flow.js";
import { SD_ANALYST, SPEC_VERIFIER } from "./prompts-spec-first/sd-verify-spec.js";
import { BACKEND_ENGINEER, FRONTEND_ENGINEER, TESTER, VERIFIER } from "./prompts-spec-first/implement-test.js";

/**
 * 規格先行（spec-first）內建流程 12 個角色的說明。
 * 與 prompts.ts（Asana 流程的 5 個角色）完全分開；get_role_prompt 不經過這裡，由 work_item 工具接上。
 */

export type { SpecFirstPromptOptions };

const ROLE_SECTIONS: Readonly<Record<string, RoleSections>> = {
  "baseline-survey": BASELINE_SURVEY,
  "tech-selector": TECH_SELECTOR,
  "mockup-designer": MOCKUP_DESIGNER,
  "sa-analyst": SA_ANALYST,
  "db-designer": DB_DESIGNER,
  "flow-analyst": FLOW_ANALYST,
  "sd-analyst": SD_ANALYST,
  "spec-verifier": SPEC_VERIFIER,
  "frontend-engineer": FRONTEND_ENGINEER,
  "backend-engineer": BACKEND_ENGINEER,
  verifier: VERIFIER,
  tester: TESTER,
};

export const SPEC_FIRST_ROLE_IDS: readonly string[] = Object.freeze(Object.keys(ROLE_SECTIONS));

export function getSpecFirstRolePrompt(roleId: string, options: SpecFirstPromptOptions = {}): string {
  const sections = Object.prototype.hasOwnProperty.call(ROLE_SECTIONS, roleId) ? ROLE_SECTIONS[roleId] : undefined;
  if (!sections) {
    throw new Error(`未知的規格先行角色「${roleId}」。可用角色：${SPEC_FIRST_ROLE_IDS.join("、")}`);
  }
  return renderRolePrompt(sections, options);
}
