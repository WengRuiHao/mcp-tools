import type { Renderer } from "../render/index.js";
import { WorkItemActionError, need, okReply, type ToolReply } from "./common.js";
import { loadWorkItem } from "./context.js";
import { ER_MD_SRC_RE, withErDiagramSource } from "./render-er.js";
import type { WorkItemArgs } from "./schema.js";
import { convertSaToDocx } from "../export/sa-docx.js";
import { textResult } from "../shared.js";

const ATTACH_FALLBACK = "（改由 AI 用自己的瀏覽器工具截圖／轉圖後，用 work_item action=attach 存入）";

/** 內建產圖：可用才渲染；不可用或渲染失敗是預期分支，回 ok:false 與 hint（不算工具錯誤），引導走 attach 流程。 */
export async function handleRender(a: WorkItemArgs, renderer: Renderer): Promise<ToolReply> {
  if (a.kind === "docx") return handleRenderDocx(a);
  const { workItemId, src, out } = need("render", a, ["workItemId", "kind", "src", "out"]);
  const kind = a.kind === "mermaid" ? "mermaid" : "html";
  const ctx = await loadWorkItem(workItemId);
  const availability = await renderer.isAvailable(kind);
  if (!availability.available) {
    return textResult({ success: false, ok: false, reason: availability.reason, hint: `${availability.hint ?? "內建產圖功能不可用"}${ATTACH_FALLBACK}` });
  }
  const mermaid = (mmdPath: string) => renderer.renderMermaidToPng({ baseDir: ctx.dir, mmdPath, outPath: out });
  const result =
    kind === "html"
      ? await renderer.renderHtmlToPng({ baseDir: ctx.dir, htmlPath: src, outPath: out })
      : ER_MD_SRC_RE.test(src)
        ? await withErDiagramSource(ctx.dir, src, out, mermaid)
        : await mermaid(src);
  if (!result.ok) return textResult({ success: false, ok: false, reason: result.reason, hint: `${result.hint}${ATTACH_FALLBACK}` });
  return okReply({ workItemId: ctx.id, ok: true, out, bytes: result.bytes });
}

/** SA 轉 Word：固定 01-sa.md → 01-sa.docx；環境缺 Python／python-docx 回 ok:false 與 hint（不算工具錯誤），轉換失敗是錯誤。 */
async function handleRenderDocx(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId } = need("render", a, ["workItemId"]);
  const ctx = await loadWorkItem(workItemId);
  const r = await convertSaToDocx(ctx.dir);
  if (r.status === "unavailable") return textResult({ success: false, ok: false, reason: r.reason, hint: r.hint });
  if (r.status === "failed") throw new WorkItemActionError(r.message);
  return okReply({ workItemId: ctx.id, ok: true, out: r.out, bytes: r.bytes, images: r.images, tables: r.tables });
}
