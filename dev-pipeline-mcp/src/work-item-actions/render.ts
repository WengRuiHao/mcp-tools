import type { Renderer } from "../render/index.js";
import { WorkItemActionError, need, okReply, type ToolReply } from "./common.js";
import { loadWorkItem } from "./context.js";
import type { WorkItemArgs } from "./schema.js";
import { convertSaToDocx } from "../export/sa-docx.js";
import { textResult } from "../shared.js";

/** ER 圖 PNG 的固定輸出位置、Mermaid 來源位置與（舊格式）內嵌 ER 圖的文件。 */
export const ER_PNG_OUT_RE = /^TableSchema\/er\/([A-Za-z0-9_-]+)\.png$/;
const ER_SRC_RE = /^TableSchema\/_src\/([A-Za-z0-9_-]+)\.mmd$/;
const ER_MD_RE = /^TableSchema\/(?:[A-Za-z0-9_]+|system-er)\.md$/;

const ATTACH_FALLBACK = "（改由 AI 用自己的瀏覽器工具截圖／轉圖後，用 work_item action=attach 存入）";

/** 內建產圖：可用才渲染；不可用或渲染失敗是預期分支，回 ok:false 與 hint（不算工具錯誤），引導走 attach 流程。 */
export async function handleRender(a: WorkItemArgs, renderer: Renderer): Promise<ToolReply> {
  if (a.kind === "docx") return handleRenderDocx(a);
  const { workItemId, src, out } = need("render", a, ["workItemId", "kind", "src", "out"]);
  const kind = a.kind === "mermaid" ? "mermaid" : "html";
  if (kind === "mermaid") checkErRenderPaths(src, out);
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

/** ER 圖來源改放 TableSchema/_src/<名稱>.mmd，輸出必須是 TableSchema/er/<同名>.png；舊的「來源是資料表結構文件 .md」不再支援。 */
function checkErRenderPaths(src: string, out: string): void {
  if (ER_MD_RE.test(src)) throw new WorkItemActionError(`ER 圖來源不再從文件 ${src} 取出：請把 Mermaid erDiagram 寫在 TableSchema/_src/<名稱>.mmd（write），再用 render kind=mermaid src=TableSchema/_src/<名稱>.mmd out=TableSchema/er/<同名>.png 轉圖；文件內只放圖片引用。`);
  const m = ER_SRC_RE.exec(src);
  if (!m) return;
  const o = ER_PNG_OUT_RE.exec(out);
  if (!o || o[1] !== m[1]) throw new WorkItemActionError(`ER 圖來源 ${src} 的輸出必須是 TableSchema/er/${m[1]}.png（與來源同名）。`);
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
