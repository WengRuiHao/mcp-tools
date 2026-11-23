import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveArtifactPath, updateStatus } from "../pipeline-store.js";
import { buildWhenContext } from "../work-item-store.js";
import { highRiskOnlyFiles, withoutHiddenHighRiskArtifacts } from "../workflow/high-risk-hidden.js";
import { hashRoleOutputs } from "./deliverable-hash.js";
import { WorkItemActionError, errorMessage, need, okReply, type ToolReply } from "./common.js";
import { builtinDefinition, loadEffectiveDef, loadWorkItem } from "./context.js";
import { refreshIndexDoc } from "./index-doc.js";
import { recheckAfterWrite, type RecheckResult } from "./recheck.js";
import type { WorkItemArgs } from "./schema.js";

export const MAX_WRITE_BYTES = 512 * 1024;
const TEXT_EXTENSIONS = new Set([".md", ".sql", ".mmd"]);

/** 流程定義的文字產出檔名白名單（不含資料夾與 render 出來的圖片）。 */
export function writableFilenames(): string[] {
  const def = builtinDefinition();
  const hrOnly = highRiskOnlyFiles(def); // 高風險專屬的產出檔（architecture.md）不列在一般清單，只有高風險工作項目才能寫
  const names = def.artifacts.flatMap((a) => [a.file, ...(a.attachments ?? [])]).filter((n) => !hrOnly.has(n));
  return names.filter((n) => !n.endsWith("/") && TEXT_EXTENSIONS.has(path.extname(n).toLowerCase()));
}

/** 資料表結構文件：TableSchema/<主表名>.md（名稱限英數字與底線），另加固定檔名的系統 ER 圖 TableSchema/system-er.md（含連字號，不會與表名衝突）。 */
export const TABLE_SCHEMA_FILE_RE = /^TableSchema\/(?:[A-Za-z0-9_]+|system-er)\.md$/;

/** ER 圖 Mermaid 來源（內部檔）：TableSchema/_src/<名稱>.mmd（名稱限英數字與底線，或系統圖 system-er）。 */
export const ER_SRC_FILE_RE = /^TableSchema\/_src\/(?:[A-Za-z0-9_]+|system-er)\.mmd$/;

const MOCKUP_OR_IMAGE_RE = /^sa-mockup[\\/]|\.(?:html?|css|js|png|jpe?g|webp)$/i;

export async function handleWrite(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId, filename } = need("write", a, ["workItemId", "filename"]);
  if (typeof a.content !== "string") throw new WorkItemActionError("action=write 缺少必填參數：content");
  const allowed = writableFilenames();
  const hrOnly = highRiskOnlyFiles(builtinDefinition());
  const isHighRiskFile = hrOnly.has(filename);
  if (!allowed.includes(filename) && !TABLE_SCHEMA_FILE_RE.test(filename) && !ER_SRC_FILE_RE.test(filename) && MOCKUP_OR_IMAGE_RE.test(filename)) throw new WorkItemActionError(`write 不接受「${filename}」（mockup 與圖片不走 write）：請改用 attach destDir=sa-mockup（mockup 的 html／css／js／圖片；srcPath 為來源檔絕對路徑、name 為存檔檔名）；畫面截圖用 destDir=sa-images。`);
  const reject = (): WorkItemActionError => new WorkItemActionError(`不允許寫入「${filename}」：只能寫流程定義的產出檔（${allowed.join("、")}），或資料表結構文件 TableSchema/<名稱>.md（名稱限英數字與底線）或系統 ER 圖 TableSchema/system-er.md，或 ER 圖 Mermaid 來源 TableSchema/_src/<名稱>.mmd（系統圖為 system-er.mmd）。圖片請用 attach，不可帶路徑。`);
  if (!allowed.includes(filename) && !isHighRiskFile && !TABLE_SCHEMA_FILE_RE.test(filename) && !ER_SRC_FILE_RE.test(filename)) throw reject();
  const bytes = Buffer.byteLength(a.content, "utf-8");
  if (bytes > MAX_WRITE_BYTES) throw new WorkItemActionError(`content 太大（${bytes} bytes），上限 ${MAX_WRITE_BYTES} bytes。`);
  const ctx = await loadWorkItem(workItemId);
  if (isHighRiskFile) {
    const visible = withoutHiddenHighRiskArtifacts(builtinDefinition(), buildWhenContext(ctx.status));
    if (!visible.artifacts.some((a) => a.file === filename || (a.attachments ?? []).includes(filename))) throw reject(); // 一般需求不能寫高風險專屬檔
  }
  try {
    const full = resolveArtifactPath(ctx.dir, filename);
    await mkdir(path.dirname(full), { recursive: true });
    if ((TABLE_SCHEMA_FILE_RE.test(filename) || ER_SRC_FILE_RE.test(filename)) && (await lstat(path.dirname(full))).isSymbolicLink()) throw new WorkItemActionError("TableSchema 資料夾是符號連結，拒絕寫入。");
    const existing = await lstat(full).catch(() => null);
    if (existing?.isSymbolicLink()) throw new WorkItemActionError(`「${filename}」是符號連結，拒絕寫入。`);
    await writeFile(full, a.content, "utf-8");
  } catch (e) {
    if (e instanceof WorkItemActionError) throw e;
    throw new WorkItemActionError(`寫入失敗：${errorMessage(e)}`);
  }
  const recheck = await tryRecheck(ctx.dir, ctx.status, filename);
  if (recheck?.ok) await recordHashes(ctx.id, ctx.dir, ctx.status, recheck.roles);
  const indexWarning = await refreshIndexDoc(ctx);
  return okReply({
    workItemId: ctx.id,
    filename,
    bytes,
    note: "已寫入；不會自動標記完成，寫好後請用 done 交件。",
    ...(recheck ? { recheck: { ok: recheck.ok, failures: recheck.failures }, ...(recheck.ok ? {} : { warning: recheckWarning(recheck) }) } : {}),
    ...(indexWarning ? { indexWarning } : {}),
  });
}

const recheckWarning = (r: RecheckResult): string => `警告：角色「${r.roles.join("、")}」已經 done，但重寫後的內容檢查未通過（${r.failures.length} 項，見 recheck.failures）。檔案已寫入，請修正後再 write 一次直到 recheck.ok 為 true。`;

/** write 後重檢通過：把受影響角色的產出檔雜湊記回 status，done 時才知道檔案沒被外部改動。記錄失敗不影響 write。 */
async function recordHashes(id: string, dir: string, status: Parameters<typeof recheckAfterWrite>[1], roles: string[]): Promise<void> {
  try {
    const { def } = await loadEffectiveDef(status);
    const entries = await Promise.all(roles.map(async (r) => [r, await hashRoleOutputs(dir, def, r)] as const));
    await updateStatus(id, (s) => ({ ...s, deliverable_hashes: { ...(s.deliverable_hashes ?? {}), ...Object.fromEntries(entries) } }));
  } catch {
    // 沒記到雜湊只會讓下次 done 多重檢一次
  }
}

/** 已 done 的角色重寫產出檔：重跑交件內容檢查。流程定義載入失敗時略過（write 本身不受影響）。 */
async function tryRecheck(dir: string, status: Parameters<typeof recheckAfterWrite>[1], filename: string): Promise<RecheckResult | undefined> {
  try {
    const { def } = await loadEffectiveDef(status);
    return await recheckAfterWrite(dir, status, def, filename);
  } catch {
    return undefined;
  }
}
