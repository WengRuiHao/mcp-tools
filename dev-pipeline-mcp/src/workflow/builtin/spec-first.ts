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
  flow: "flow-analyst",
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
      { id: "tech-stack", file: "tech-stack.md", kind: "markdown" },
      { id: "mockup", file: "sa-mockup/", kind: "html" },
      { id: "sa", file: "01-sa.md", kind: "markdown", attachments: ["sa-images/", "01-sa.docx"] },
      { id: "sa-notes", file: "sa-notes.md", kind: "markdown" },
      { id: "db", file: "02-db.sql", kind: "sql", attachments: ["02-db.md"] },
      { id: "table-schema", file: "TableSchema/", kind: "markdown" },
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
        id: "tech-selector",
        promptRef: "tech-selector",
        dependsOn: ["baseline-survey"], inputs: ["baseline", "impact"], outputs: ["tech-stack"],
        roleNotes: "依「技術來源」決定技術棧並寫 tech-stack.md：沿用現有只記錄現況盤點查到的技術棧（程式自動記錄確認）；換技術、全新有規範、全新待選都要等使用者確認技術棧，確認後鎖定，後面角色不可自行換語言或框架。",
      },
      {
        id: "mockup-designer",
        promptRef: "mockup-designer",
        dependsOn: ["baseline-survey", "tech-selector"], inputs: ["impact", "tech-stack"], outputs: ["mockup"],
        optional: true,
        when: "hasFrontend==true",
        roleNotes: "只負責畫 mockup：產出能在瀏覽器開啟的檔案（例如 HTML），放 sa-mockup/。既有系統以現有畫面為底，標出新增／修改的部分。畫完先等使用者確認畫面方向，確認後才進 SA 分析師。",
      },
      {
        id: "sa-analyst",
        promptRef: "sa-analyst",
        dependsOn: ["baseline-survey", "tech-selector", "mockup-designer"], inputs: ["impact", "tech-stack", "mockup"], outputs: ["sa", "sa-notes"],
        roleNotes:
          "規格是給客戶看的客戶版（格式以 docs/sasd-standard/SA-範本.md 為準）。程式未開發前畫面只能靠 mockup 截圖：依已確認的 mockup（sa-mockup/）用網址 #狀態名稱 切換狀態截圖，整體畫面一張、每種提示狀態各一張，圖檔放 sa-images/ 並在規格中引用。定稿後圖片不換成實際系統畫面。待確認問題、需求依據與翻新案的程式依據寫在內部檔 sa-notes.md，不放進 SA。",
      },
      { id: "db-designer", promptRef: "db-designer", dependsOn: ["sa-analyst"], inputs: ["sa", "tech-stack"], outputs: ["db", "table-schema"], optional: true, when: "hasDb==true" },
      { id: "flow-analyst", promptRef: "flow-analyst", dependsOn: ["sa-analyst", "db-designer"], inputs: ["sa", "db"], outputs: ["flow"] },
      { id: "sd-analyst", promptRef: "sd-analyst", dependsOn: ["sa-analyst", "flow-analyst"], inputs: ["sa", "db", "table-schema", "flow", "tech-stack"], outputs: ["sd"] },
      {
        id: "spec-verifier",
        promptRef: "spec-verifier",
        dependsOn: ["sa-analyst", "db-designer", "flow-analyst", "sd-analyst"],
        inputs: ["sa", "db", "table-schema", "flow", "sd", "impact", "tech-stack"],
        outputs: ["spec-check"],
        roleNotes: "只看規格、不看程式碼：驗證 SA 與 SD 能串起來（雙向可追溯、SD 與 SA 各功能對得上、SD 與資料表結構文件的欄位一致、流程與 flow.mmd 一致、新增／修改／不動與影響分析一致）。另須檢查 SA 的畫面與每個提示狀態都有 mockup 截圖（sa-images/）且圖與說明對得上；前端功能只需要出現在 SD 的「前端功能與 API 對應表」。",
      },
      { id: "frontend-engineer", promptRef: "frontend-engineer", dependsOn: ["spec-verifier"], parallelWith: ["backend-engineer"], inputs: ["sa", "spec-check", "tech-stack"], outputs: ["impl-fe"], optional: true, when: "hasFrontend==true" },
      { id: "backend-engineer", promptRef: "backend-engineer", dependsOn: ["spec-verifier"], parallelWith: ["frontend-engineer"], inputs: ["sd", "spec-check", "tech-stack"], outputs: ["impl-be"], optional: true, when: "hasBackend==true" },
      { id: "verifier", promptRef: "verifier", dependsOn: ["frontend-engineer", "backend-engineer"], inputs: ["sa", "sd", "impl-fe", "impl-be", "tech-stack"], outputs: ["verify"] },
      { id: "tester", promptRef: "tester", dependsOn: ["verifier"], inputs: ["impl-fe", "impl-be", "verify", "tech-stack"], outputs: ["test"] },
    ],
    gates: [
      { id: "impact-content", after: "baseline-survey", type: "content", confirmMode: "auto", checks: [] },
      { id: "tech-confirm", after: "tech-selector", type: "confirmation", confirmMode: "manual" },
      { id: "mockup-confirm", after: "mockup-designer", type: "confirmation", confirmMode: "manual" },
      {
        id: "sa-content-check",
        after: "sa-analyst",
        type: "content",
        confirmMode: "auto",
        checks: [
          {
            id: "sa-mockup-screenshot",
            description:
              "01-sa.md 至少一張畫面圖且所有圖片引用有效（sa-images/ 內存在的圖）；必備章節、基本資料表、版本管控歷程、規則表格；沒有禁用詞與內部檔名；每個提示狀態附有效截圖；截圖取自已確認的 mockup。",
          },
        ],
      },
      { id: "sa-confirm", after: "sa-analyst", type: "confirmation", confirmMode: "auto" },
      { id: "db-flow-confirm", after: ["db-designer", "flow-analyst"], type: "confirmation", confirmMode: "auto" },
      { id: "sd-confirm", after: "sd-analyst", type: "confirmation", confirmMode: "auto" },
      { id: "spec-check-verdict", after: "spec-verifier", type: "verdict", confirmMode: "auto", routeOnFail: { ...SPEC_CHECK_ROUTES } },
      { id: "implementation-content", after: ["frontend-engineer", "backend-engineer"], type: "content", confirmMode: "auto", checks: [] },
      { id: "verdict", after: "verifier", type: "verdict", confirmMode: "auto", routeOnFail: { sa: "sa-analyst", db: "db-designer", flow: "flow-analyst", sd: "sd-analyst", fe: "frontend-engineer", be: "backend-engineer" } },
      { id: "test-evidence", after: "tester", type: "evidence", confirmMode: "auto" },
      { id: "final-acceptance", after: "tester", type: "confirmation", confirmMode: "manual", locked: true },
    ],
  };
}
