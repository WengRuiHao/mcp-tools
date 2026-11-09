import type { Renderer } from "../render/index.js";
import { need, okReply, type ToolReply } from "./common.js";
import { loadWorkItem } from "./context.js";
import type { WorkItemArgs } from "./schema.js";
import { textResult } from "../shared.js";

const ATTACH_FALLBACK = "（改由 AI 用自己的瀏覽器工具截圖／轉圖後，用 work_item action=attach 存入）";

/** 內建產圖：可用才渲染；不可用或渲染失敗是預期分支，回 ok:false 與 hint（不算工具錯誤），引導走 attach 流程。 */
export async function handleRender(a: WorkItemArgs, renderer: Renderer): Promise<ToolReply> {
  const { workItemId, kind, src, out } = need("render", a, ["workItemId", "kind", "src", "out"]);
  const ctx = await loadWorkItem(workItemId);
  const availability = await renderer.isAvailable(kind);
  if (!availability.available) {
    return textResult({ success: false, ok: false, reason: availability.reason, hint: `${availability.hint ?? "內建產圖功能不可用"}${ATTACH_FALLBACK}` });
  }
  const result =
    kind === "html"
      ? await renderer.renderHtmlToPng({ baseDir: ctx.dir, htmlPath: src, outPath: out })
      : await renderer.renderMermaidToPng({ baseDir: ctx.dir, mmdPath: src, outPath: out });
  if (!result.ok) return textResult({ success: false, ok: false, reason: result.reason, hint: `${result.hint}${ATTACH_FALLBACK}` });
  return okReply({ workItemId: ctx.id, ok: true, out, bytes: result.bytes });
}
