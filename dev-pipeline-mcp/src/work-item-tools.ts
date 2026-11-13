import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRenderer, type Renderer } from "./render/index.js";
import { handleAttach } from "./work-item-actions/attach.js";
import { WorkItemActionError, errorMessage, errorReply, type ToolReply } from "./work-item-actions/common.js";
import { handleConfirm } from "./work-item-actions/confirm.js";
import { handleRecordDecision } from "./work-item-actions/decisions.js";
import { handleCreate } from "./work-item-actions/create.js";
import { handleDone } from "./work-item-actions/done.js";
import { handleGet } from "./work-item-actions/get.js";
import { handleRender } from "./work-item-actions/render.js";
import { handleRolePrompt } from "./work-item-actions/role-prompt.js";
import { workItemShape, type WorkItemArgs } from "./work-item-actions/schema.js";
import { handleSetScope } from "./work-item-actions/set-scope.js";
import { handleUpdateRequirement } from "./work-item-actions/update-requirement.js";
import { handleVerdict } from "./work-item-actions/verdict.js";
import { handleWrite } from "./work-item-actions/write.js";

const WORK_ITEM_DESCRIPTION =
  "非 Asana 的「規格先行」工作項目（不靠 Asana，自己建立工作項目並走完 mockup→SA→DB／流程→SD→規格驗證→前後端→驗證→測試→最終驗收）。用 action 分派：\n" +
  "- create：建立（projectDir、title、requirement、baseline、scope、hasDb；選填 styleSource、techSource、renewal），回傳 workItemId 與第一步。畫面風格來源與技術來源沒給時：既有系統非翻新＝沿用現有；翻新案必須明確給；全新系統有專案規範＝全新有規範、沒有＝全新待選。\n" +
  "- get：下一步誰做、要交哪些檔、卡在哪道關卡（等使用者或 AI 審查）。\n" +
  "- role_prompt：取該角色說明（roleId，附專案 flow.json 的 roleNotes）；roleId=\"reviewer\" 取 AI 審查員說明書（審查申報判準，非流程角色）。\n" +
  "- set_scope：改 scope／hasDb（SA 確認後鎖定）、styleSource（mockup 確認後鎖定）、techSource（技術確認後鎖定）。\n" +
  "- write：寫入產出檔（filename 限流程定義的產出檔，content 上限 512KB；不會自動完成）。\n" +
  "- attach：把截圖或 mockup 檔存進工作項目（srcPath 絕對路徑、destDir：sa-mockup｜sa-images｜evidence｜flow｜er；er 存 TableSchema/er/，name 必填）。AI 用自己的瀏覽器工具截好圖後用它存放。\n" +
  "- render：選用的內建產圖（kind=html｜mermaid，src、out）；不可用會回 ok:false 與 hint，改走 attach。kind=docx 把 01-sa.md 轉成 01-sa.docx（不需 src、out；SA 的 Word 只能由它產生，SA 交件時也會自動轉）。\n" +
  "- done：交件（roleId）；會檢查產出檔、SA 截圖、flow.png、PASS／FAIL 報告格式，不合格不標記完成。\n" +
  "- confirm：確認關卡（gateId、decision、by；by:\"human\" 一律要附 reason＝使用者原話；打回時可用 alsoRewind 指定一併退回該關卡之前的角色）。by:\"human\" 只能在使用者本人明確說確認時使用，AI 不可冒用；by:\"agent\" 核准只有該關卡為 auto 且審查申報（review）通過才成功（review 任一申報為 true 必須在 review.reasons 附理由；判準見 role_prompt roleId=\"reviewer\"），硬性停止時 AI 不可核准；styleSource=new-select 核准 mockup-confirm 時必須用 selected 指定選定的風格檔（sa-mockup/ 內 style-*.html），其餘候選會移到 sa-mockup/_candidates/；AI 可用 decision:\"rejected\"（reason 必填）打回，不受硬性停止限制；final-acceptance 核准與打回都只能 human，manual 關卡 AI 不可核准。\n" +
  "- verdict：規格驗證／驗證判定（gateId=spec-check-verdict｜verdict、result、rootCause、by、review；by:\"human\" 與 AI 判不通過都要附 reason；spec-check-verdict 的 rootCause=sa-text 只退回 SA 與規格驗證師）。\n" +
  "- update_requirement：修改需求（workItemId、requirement＝新需求全文、reason＝使用者原話、by:\"human\"）；更新 item.md 並記錄修改歷程，列出已完成的角色，不自動退回任何角色（要重做請用 confirm 打回搭配 alsoRewind）。\n" +
  "- record_decision：記錄使用者的決定（workItemId、question＝sa-notes.md 待確認問題的編號或標題、answer、reason＝使用者原話、by:\"human\"）；使用者說「全部照建議」用 acceptAllSuggested:true（不需 question、answer，reason 仍要附原話）一次接受所有尚無記錄的待確認問題。sa-notes.md 還有沒決定記錄的待確認問題時，sa-confirm 不可由 AI 核准；已記錄的決定會出現在 get、審查員說明書與 00-索引.md。\n" +
  "Asana 票單不可用本工具，請用既有 Asana 工具。錯誤一律回 isError。";

async function dispatch(a: WorkItemArgs, renderer: Renderer): Promise<ToolReply> {
  switch (a.action) {
    case "create":
      return handleCreate(a);
    case "get":
      return handleGet(a);
    case "role_prompt":
      return handleRolePrompt(a);
    case "set_scope":
      return handleSetScope(a);
    case "write":
      return handleWrite(a);
    case "attach":
      return handleAttach(a);
    case "render":
      return handleRender(a, renderer);
    case "done":
      return handleDone(a);
    case "confirm":
      return handleConfirm(a);
    case "verdict":
      return handleVerdict(a);
    case "update_requirement":
      return handleUpdateRequirement(a);
    case "record_decision":
      return handleRecordDecision(a);
  }
}

/** 分派並把所有例外轉成 isError 結果（預期錯誤保留訊息與附加欄位）。 */
export async function runWorkItemAction(a: WorkItemArgs, renderer: Renderer): Promise<ToolReply> {
  try {
    return await dispatch(a, renderer);
  } catch (e) {
    if (e instanceof WorkItemActionError) return errorReply(e.message, e.extra);
    return errorReply(`work_item 動作 ${a.action} 失敗：${errorMessage(e)}`);
  }
}

export interface WorkItemToolDeps {
  renderer?: Renderer;
}

export function registerWorkItemTools(server: McpServer, deps: WorkItemToolDeps = {}): void {
  const renderer = deps.renderer ?? createRenderer();
  server.tool("work_item", WORK_ITEM_DESCRIPTION, workItemShape, async (args) => runWorkItemAction(args, renderer));
}
