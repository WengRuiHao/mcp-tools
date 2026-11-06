import type { SdMode, SpecOrder } from "./project-registry.js";

/**
 * 依專案已登記的 sdMode／specOrder，算出「這個專案的票單要走哪些步驟」。
 * 由 prepare_project 回傳，讓核心流程說明（get_pipeline_overview）不必同時描述所有模式分支。
 * 步驟編號對應核心流程的 3.1～3.8。
 */
export interface StepPlan {
  sdMode: SdMode;
  specOrder: SpecOrder | null;
  /** 這個專案每張票依序要做的步驟編號。 */
  steps: string[];
  /** 規格撰寫者步驟的做法；只有 self-generated 才有，且只含這個專案適用的那一段。 */
  specWriterStep?: string;
  /** 補充提醒（例如 external 不可建議改 SD）。 */
  notes: string[];
}

const SPEC_FIRST_STEP =
  "3.4 規格先定案才能寫程式碼：`get_role_prompt({ role: \"spec-writer\", projectDir })`（可派子任務），產出/更新 SD 草稿（`write_project_sd_doc`），`advance_ticket_stage({ taskGid: T, stage: \"sd_drafted\" })` 後**停在這裡，不要自己接著當工程師**，告訴使用者草稿在哪個檔案，等他 `record_spec_confirmation`。`confirmed: true` 才能進 3.5；`false` 依打回意見修改、重推 `sd_drafted`，直到通過。";

const CODE_FIRST_STEP =
  "3.6 依剛寫完的程式碼反推補規格（接在 3.5 之後）：`get_role_prompt({ role: \"spec-writer\", projectDir })`（可派子任務），依工程師實際改動反推完整 SD 草稿（見 spec-writer 說明的 `code_first` 段）；`write_project_sd_doc`、`advance_ticket_stage({ ..., stage: \"sd_drafted\" })` 後**停下**等 `record_spec_confirmation`（告知這是依程式碼反推、在哪個檔案）。`true` 才能進 3.7；`false` 依意見修改重推 `sd_drafted`。";

export function buildStepPlan(sasd: { sdMode: SdMode; specOrder?: SpecOrder | null } | null): StepPlan | null {
  if (!sasd) return null;
  const { sdMode } = sasd;
  const specOrder = sdMode === "self-generated" ? (sasd.specOrder ?? null) : null;

  if (sdMode !== "self-generated") {
    const notes =
      sdMode === "external"
        ? ["SD 是別人產的：只能調整程式碼配合它，不可建議修改 SD。"]
        : sdMode === "unregistered"
          ? ["這個專案沒有登記 SD：每張票都要問使用者有沒有對應的 SD。"]
          : [];
    return { sdMode, specOrder: null, steps: ["3.1", "3.2", "3.3", "3.5", "3.7", "3.8"], notes };
  }

  const notes = ["SD 草稿要經 `record_spec_confirmation` 確認才能往下；不可自行決定略過 SD，僅使用者明確說本票不需 SD 時才帶 `sdNotRequired: true` 與原話。"];
  if (specOrder === "spec_first") {
    return { sdMode, specOrder, steps: ["3.1", "3.2", "3.3", "3.4", "3.5", "3.7", "3.8"], specWriterStep: SPEC_FIRST_STEP, notes };
  }
  if (specOrder === "code_first") {
    return { sdMode, specOrder, steps: ["3.1", "3.2", "3.3", "3.5", "3.6", "3.7", "3.8"], specWriterStep: CODE_FIRST_STEP, notes };
  }
  // self-generated 但 specOrder 缺漏（設定不完整）：不猜，兩種都列出
  return {
    sdMode,
    specOrder: null,
    steps: ["3.1", "3.2", "3.3", "3.4｜3.6（依 specOrder）", "3.5", "3.7", "3.8"],
    specWriterStep: `${SPEC_FIRST_STEP}\n${CODE_FIRST_STEP}`,
    notes,
  };
}
