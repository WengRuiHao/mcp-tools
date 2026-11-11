import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRenderer, type Renderer } from "./render/index.js";
import { handleAttach } from "./work-item-actions/attach.js";
import { WorkItemActionError, errorMessage, errorReply, type ToolReply } from "./work-item-actions/common.js";
import { handleConfirm } from "./work-item-actions/confirm.js";
import { handleCreate } from "./work-item-actions/create.js";
import { handleDone } from "./work-item-actions/done.js";
import { handleGet } from "./work-item-actions/get.js";
import { handleRender } from "./work-item-actions/render.js";
import { handleRolePrompt } from "./work-item-actions/role-prompt.js";
import { workItemShape, type WorkItemArgs } from "./work-item-actions/schema.js";
import { handleSetScope } from "./work-item-actions/set-scope.js";
import { handleVerdict } from "./work-item-actions/verdict.js";
import { handleWrite } from "./work-item-actions/write.js";

const WORK_ITEM_DESCRIPTION =
  "非 Asana 的「規格先行」工作項目（不靠 Asana，自己建立工作項目並走完 mockup→SA→DB／流程→SD→規格驗證→前後端→驗證→測試→最終驗收）。用 action 分派：\n" +
  "- create：建立（projectDir、title、requirement、baseline、scope、hasDb；選填 styleSource、techSource、renewal），回傳 workItemId 與第一步。畫面風格來源與技術來源沒給時：既有系統非翻新＝沿用現有；翻新案必須明確給；全新系統有專案規範＝全新有規範、沒有＝全新待選。\n" +
  "- get：下一步誰做、要交哪些檔、卡在哪道關卡（等使用者或 AI 審查）。\n" +
  "- role_prompt：取該角色說明（roleId，附專案 flow.json 的 roleNotes）。\n" +
  "- set_scope：改 scope／hasDb（SA 確認後鎖定）、styleSource（mockup 確認後鎖定）、techSource（技術確認後鎖定）。\n" +
  "- write：寫入產出檔（filename 限流程定義的產出檔，content 上限 512KB；不會自動完成）。\n" +
  "- attach：把截圖或 mockup 檔存進工作項目（srcPath 絕對路徑、destDir：sa-mockup｜sa-images｜evidence｜flow）。AI 用自己的瀏覽器工具截好圖後用它存放。\n" +
  "- render：選用的內建產圖（kind=html｜mermaid，src、out）；不可用會回 ok:false 與 hint，改走 attach。kind=docx 把 01-sa.md 轉成 01-sa.docx（不需 src、out；SA 的 Word 只能由它產生，SA 交件時也會自動轉）。\n" +
  "- done：交件（roleId）；會檢查產出檔、SA 截圖、flow.png、PASS／FAIL 報告格式，不合格不標記完成。\n" +
  "- confirm：確認關卡（gateId、decision、by）。by:\"human\" 只能在使用者本人明確說確認時使用，AI 不可冒用；by:\"agent\" 只有該關卡為 auto 且審查申報（review）通過才成功，final-acceptance 與 manual 關卡一律拒絕代確認。\n" +
  "- verdict：規格驗證／驗證判定（gateId=spec-check-verdict｜verdict、result、rootCause、by、review）。\n" +
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
