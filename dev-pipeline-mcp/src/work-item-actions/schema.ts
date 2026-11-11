import { z } from "zod";

/** work_item 單一工具的參數：以 action 分派，其餘欄位依動作選填（缺必填欄位由各動作回清楚錯誤）。 */

export const WORK_ITEM_ACTIONS = ["create", "get", "role_prompt", "set_scope", "write", "attach", "render", "done", "confirm", "verdict"] as const;
export type WorkItemAction = (typeof WORK_ITEM_ACTIONS)[number];

const reviewShape = {
  breaksExisting: z.boolean().optional().describe("審查員申報：是否會破壞既有功能"),
  reviewerUncertain: z.boolean().optional().describe("審查員申報：是否不確定或發現規格矛盾"),
  scopeSplit: z.boolean().optional().describe("審查員申報：是否涉及模組切分這類一錯全部重工的決策"),
};

export const workItemShape = {
  action: z.enum(WORK_ITEM_ACTIONS).describe("動作：create｜get｜role_prompt｜set_scope｜write｜attach｜render｜done｜confirm｜verdict"),
  workItemId: z.string().optional().describe("工作項目編號（wi-YYYYMMDD-NNN）；create 以外都要"),
  projectDir: z.string().optional().describe("create：專案目錄絕對路徑（必須存在）"),
  title: z.string().optional().describe("create：標題"),
  requirement: z.string().optional().describe("create：需求原文"),
  baseline: z.enum(["greenfield", "brownfield"]).optional().describe("create：全新系統｜既有系統"),
  scope: z.enum(["frontend", "backend", "both"]).optional().describe("create／set_scope：範圍"),
  hasDb: z.boolean().optional().describe("create／set_scope：是否需要 DB 設計"),
  styleSource: z.enum(["existing", "redesign", "new-guided", "new-select"]).optional().describe("create／set_scope：畫面風格來源 existing沿用現有｜redesign換新（既有系統）；new-guided全新有規範｜new-select全新待選（全新系統）；mockup 確認後鎖定。create 沒給時依預設值規則決定，翻新案必須明確給"),
  techSource: z.enum(["existing", "change", "new-guided", "new-select"]).optional().describe("create／set_scope：技術來源 existing沿用現有｜change換技術（既有系統）；new-guided全新有規範｜new-select全新待選（全新系統）；技術確認後鎖定。翻新案必須明確給"),
  renewal: z.boolean().optional().describe("create：是否翻新案（預設 false）；翻新案不替使用者猜風格與技術，styleSource 與 techSource 都必須明確給"),
  roleId: z.string().optional().describe("role_prompt／done：角色 id（例如 sa-analyst）"),
  filename: z.string().optional().describe("write：產出檔名（只能是流程定義的產出檔，例如 01-sa.md）"),
  content: z.string().optional().describe("write：檔案內容（上限 512KB）"),
  srcPath: z.string().optional().describe("attach：來源檔絕對路徑（必須存在且為檔案）"),
  destDir: z.enum(["sa-mockup", "sa-images", "evidence", "flow"]).optional().describe("attach：目的位置；flow＝根目錄的 flow.png"),
  name: z.string().optional().describe("attach：存檔檔名（選填，預設沿用來源檔名；會淨化）"),
  kind: z.enum(["html", "mermaid", "docx"]).optional().describe("render：html（mockup 轉 PNG）｜mermaid（流程圖轉 PNG）｜docx（01-sa.md 轉 01-sa.docx，不需 src／out）"),
  src: z.string().optional().describe("render：輸入檔，相對於工作項目目錄"),
  out: z.string().optional().describe("render：輸出 PNG，相對於工作項目目錄"),
  gateId: z.string().optional().describe("confirm：關卡 id；verdict：spec-check-verdict｜verdict"),
  decision: z.enum(["confirmed", "rejected"]).optional().describe("confirm：確認或打回"),
  by: z.enum(["human", "agent"]).optional().describe("confirm／verdict：human＝使用者本人說了算；agent＝AI 代為決定：核准只有該關卡解析為 auto 且通過把關才成功；打回（confirm rejected、verdict fail）不受硬性停止限制，最終驗收除外（核准與打回都只能 human）"),
  reason: z.string().optional().describe("confirm：理由；human 時請寫使用者原話；AI 打回（by:agent、decision:rejected）必填，寫退回原因"),
  review: z.object(reviewShape).optional().describe("by:agent 時必填：審查員申報 {breaksExisting, reviewerUncertain, scopeSplit}，三個都要是布林值"),
  result: z.enum(["pass", "fail"]).optional().describe("verdict：通過或不通過"),
  rootCause: z.string().optional().describe("verdict fail：根因（該關卡 routeOnFail 的 key，例如 sa、db、flow、sd、fe、be）"),
};

export type WorkItemArgs = z.infer<z.ZodObject<typeof workItemShape>>;
