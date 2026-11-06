import { HARD_STOP_IDS, type WorkflowDefinition } from "../schema.js";

/**
 * 現有 Asana 票單流程（核心流程 3.3～3.8）的等價定義。步驟語意見 step-plan.ts：
 * 3.3 analyst、3.4 spec-writer-first（spec_first）、3.5 engineer、3.6 spec-writer-reverse（code_first）、3.7 verifier、3.8 tester。
 * 3.1／3.2（快照、確認專案目錄）是流程前置動作，不是角色，不在此表達。
 */

const SELF_GEN = "sdMode==self-generated";

export const ASANA_TICKET_WORKFLOW_ID = "asana-ticket";

/** 角色對應的 pipeline-store 追蹤 stage；僅供等價性對照，不改任何既有行為。 */
export const ASANA_ROLE_STAGE: Readonly<Record<string, string>> = {
  analyst: "analyzed",
  "spec-writer-first": "sd_drafted",
  engineer: "implemented",
  "spec-writer-reverse": "sd_drafted",
  verifier: "verified",
  tester: "tested",
};

export function buildAsanaTicketWorkflow(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id: ASANA_TICKET_WORKFLOW_ID,
    granularity: "feature",
    source: "asana",
    baseline: "brownfield",
    confirmDefault: "manual",
    hardStops: [...HARD_STOP_IDS],
    artifacts: [
      { id: "ticket", file: "ticket.md", kind: "markdown" },
      { id: "analysis", file: "01-analysis.md", kind: "markdown" },
      { id: "sd", file: "sd-draft", kind: "markdown" },
      { id: "implementation", file: "02-implementation.md", kind: "markdown" },
      { id: "verification", file: "03-verification.md", kind: "report" },
      { id: "test", file: "04-test.md", kind: "report", evidence: ["screenshot"] },
    ],
    roles: [
      { id: "analyst", promptRef: "analyst", dependsOn: [], inputs: ["ticket"], outputs: ["analysis"] },
      {
        id: "spec-writer-first",
        promptRef: "spec-writer",
        dependsOn: ["analyst"],
        inputs: ["analysis"],
        outputs: ["sd"],
        when: `${SELF_GEN} && specOrder==spec_first`,
      },
      { id: "engineer", promptRef: "engineer", dependsOn: ["analyst", "spec-writer-first"], inputs: ["analysis", "sd"], outputs: ["implementation"] },
      {
        id: "spec-writer-reverse",
        promptRef: "spec-writer",
        dependsOn: ["engineer"],
        inputs: ["analysis", "implementation"],
        outputs: ["sd"],
        when: `${SELF_GEN} && specOrder==code_first`,
      },
      { id: "verifier", promptRef: "verifier", dependsOn: ["engineer", "spec-writer-reverse"], inputs: ["analysis", "implementation", "sd"], outputs: ["verification"] },
      { id: "tester", promptRef: "tester", dependsOn: ["verifier"], inputs: ["implementation", "verification"], outputs: ["test"] },
    ],
    gates: [
      { id: "analysis-content", after: "analyst", type: "content", checks: [] },
      { id: "sd-confirm-first", after: "spec-writer-first", type: "confirmation", confirmMode: "inherit" },
      { id: "implementation-content", after: "engineer", type: "content", checks: [] },
      { id: "sd-confirm-reverse", after: "spec-writer-reverse", type: "confirmation", confirmMode: "inherit" },
      { id: "verdict", after: "verifier", type: "verdict", routeOnFail: { analysis: "analyst", implementation: "engineer" } },
      { id: "test-evidence", after: "tester", type: "evidence" },
      { id: "final-acceptance", after: "tester", type: "confirmation", confirmMode: "manual", locked: true },
    ],
  };
}
