import { HARD_STOP_IDS, type WorkflowDefinition } from "../schema.js";

/**
 * 通用「規格先行」主線（不綁 Asana）：SA、SD 規格確認並通過規格驗證師，才能開工前後端。
 * 沒有先寫程式再補規格這條路（code_first 只存在於 asana-ticket 舊流程）。
 */

export const SPEC_FIRST_WORKFLOW_ID = "spec-first";

/** 規格驗證 FAIL 時的 rootCause → 退回的角色。 */
export const SPEC_CHECK_ROUTES: Readonly<Record<string, string>> = {
  sa: "sa-analyst",
  db: "db-designer",
  sd: "sd-analyst",
};

export function buildSpecFirstWorkflow(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id: SPEC_FIRST_WORKFLOW_ID,
    granularity: "feature",
    source: "manual",
    baseline: "brownfield",
    confirmDefault: "manual",
    hardStops: [...HARD_STOP_IDS],
    artifacts: [
      { id: "baseline", file: "baseline.md", kind: "markdown" },
      { id: "impact", file: "impact.md", kind: "markdown" },
      { id: "sa", file: "01-sa.md", kind: "markdown", attachments: ["sa-images/"] },
      { id: "db", file: "02-db.sql", kind: "sql", attachments: ["02-db.md"] },
      { id: "flow", file: "flow.mmd", kind: "mermaid", render: "flow.png" },
      { id: "sd", file: "03-sd.md", kind: "markdown" },
      { id: "spec-check", file: "spec-check.md", kind: "report" },
      { id: "impl-fe", file: "impl-fe.md", kind: "code-change" },
      { id: "impl-be", file: "impl-be.md", kind: "code-change" },
      { id: "verify", file: "verify.md", kind: "report" },
      { id: "test", file: "test.md", kind: "report", attachments: ["evidence/"], evidence: ["screenshot"] },
    ],
    roles: [
      { id: "baseline-survey", promptRef: "baseline-survey", dependsOn: [], inputs: [], outputs: ["baseline", "impact"], optional: true, when: "baseline==brownfield" },
      {
        id: "sa-analyst",
        promptRef: "sa-analyst",
        dependsOn: ["baseline-survey"], inputs: ["impact"], outputs: ["sa"],
        roleNotes:
          "規格是給客戶看的，程式未開發前前端畫面只能靠 mockup 截圖：先畫能在瀏覽器開啟的 mockup（例如 HTML）再截圖，每個前端功能條目附對應截圖，圖檔放 sa-images/ 並在規格中引用；純後端條目不需截圖。定稿後圖片不換成實際系統畫面。",
      },
      { id: "db-designer", promptRef: "db-designer", dependsOn: ["sa-analyst"], inputs: ["sa"], outputs: ["db"], optional: true },
      { id: "flow-analyst", promptRef: "flow-analyst", dependsOn: ["sa-analyst", "db-designer"], inputs: ["sa", "db"], outputs: ["flow"] },
      { id: "sd-analyst", promptRef: "sd-analyst", dependsOn: ["sa-analyst", "flow-analyst"], inputs: ["sa", "db", "flow"], outputs: ["sd"] },
      {
        id: "spec-verifier",
        promptRef: "spec-verifier",
        dependsOn: ["sa-analyst", "db-designer", "flow-analyst", "sd-analyst"],
        inputs: ["sa", "db", "flow", "sd", "impact"],
        outputs: ["spec-check"],
        roleNotes: "只看規格、不看程式碼：驗證 SA 與 SD 能串起來（雙向可追溯、欄位／型別／流程與 DB 一致、新增／修改／不動與影響分析一致）。另須檢查每個前端功能條目都有 mockup 截圖（sa-images/）且圖與功能對得上，純後端條目除外。",
      },
      { id: "frontend-engineer", promptRef: "frontend-engineer", dependsOn: ["spec-verifier"], parallelWith: ["backend-engineer"], inputs: ["sa", "spec-check"], outputs: ["impl-fe"], optional: true },
      { id: "backend-engineer", promptRef: "backend-engineer", dependsOn: ["spec-verifier"], parallelWith: ["frontend-engineer"], inputs: ["sd", "spec-check"], outputs: ["impl-be"], optional: true },
      { id: "verifier", promptRef: "verifier", dependsOn: ["frontend-engineer", "backend-engineer"], inputs: ["sa", "sd", "impl-fe", "impl-be"], outputs: ["verify"] },
      { id: "tester", promptRef: "tester", dependsOn: ["verifier"], inputs: ["impl-fe", "impl-be", "verify"], outputs: ["test"] },
    ],
    gates: [
      { id: "impact-content", after: "baseline-survey", type: "content", checks: [] },
      {
        id: "sa-content-check",
        after: "sa-analyst",
        type: "content",
        checks: [
          {
            id: "sa-mockup-screenshot",
            description:
              "每個前端功能條目都附 mockup 截圖：圖檔存在於 sa-images/ 且被規格（01-sa.md）引用；純後端條目除外。",
          },
        ],
      },
      { id: "sa-confirm", after: "sa-analyst", type: "confirmation", confirmMode: "inherit" },
      { id: "db-flow-confirm", after: ["db-designer", "flow-analyst"], type: "confirmation", confirmMode: "inherit" },
      { id: "sd-confirm", after: "sd-analyst", type: "confirmation", confirmMode: "inherit" },
      { id: "spec-check-verdict", after: "spec-verifier", type: "verdict", confirmMode: "inherit", routeOnFail: { ...SPEC_CHECK_ROUTES } },
      { id: "implementation-content", after: ["frontend-engineer", "backend-engineer"], type: "content", checks: [] },
      { id: "verdict", after: "verifier", type: "verdict", routeOnFail: { sa: "sa-analyst", db: "db-designer", sd: "sd-analyst", fe: "frontend-engineer", be: "backend-engineer" } },
      { id: "test-evidence", after: "tester", type: "evidence" },
      { id: "final-acceptance", after: "tester", type: "confirmation", confirmMode: "manual", locked: true },
    ],
  };
}
