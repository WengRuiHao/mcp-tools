import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveArtifactPath } from "../pipeline-store.js";
import { WorkItemActionError, errorMessage, need, okReply, type ToolReply } from "./common.js";
import { builtinDefinition, loadWorkItem } from "./context.js";
import type { WorkItemArgs } from "./schema.js";

export const MAX_WRITE_BYTES = 512 * 1024;
const TEXT_EXTENSIONS = new Set([".md", ".sql", ".mmd"]);

/** 流程定義的文字產出檔名白名單（不含資料夾與 render 出來的圖片）。 */
export function writableFilenames(): string[] {
  const names = builtinDefinition().artifacts.flatMap((a) => [a.file, ...(a.attachments ?? [])]);
  return names.filter((n) => !n.endsWith("/") && TEXT_EXTENSIONS.has(path.extname(n).toLowerCase()));
}

/** 資料表結構文件：TableSchema/<主表名>.md（名稱限英數字與底線），另加固定檔名的系統 ER 圖 TableSchema/system-er.md（含連字號，不會與表名衝突）。 */
export const TABLE_SCHEMA_FILE_RE = /^TableSchema\/(?:[A-Za-z0-9_]+|system-er)\.md$/;

export async function handleWrite(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId, filename } = need("write", a, ["workItemId", "filename"]);
  if (typeof a.content !== "string") throw new WorkItemActionError("action=write 缺少必填參數：content");
  const allowed = writableFilenames();
  if (!allowed.includes(filename) && !TABLE_SCHEMA_FILE_RE.test(filename)) throw new WorkItemActionError(`不允許寫入「${filename}」：只能寫流程定義的產出檔（${allowed.join("、")}），或資料表結構文件 TableSchema/<名稱>.md（名稱限英數字與底線）或系統 ER 圖 TableSchema/system-er.md。圖片請用 attach，不可帶路徑。`);
  const bytes = Buffer.byteLength(a.content, "utf-8");
  if (bytes > MAX_WRITE_BYTES) throw new WorkItemActionError(`content 太大（${bytes} bytes），上限 ${MAX_WRITE_BYTES} bytes。`);
  const ctx = await loadWorkItem(workItemId);
  try {
    const full = resolveArtifactPath(ctx.dir, filename);
    await mkdir(path.dirname(full), { recursive: true });
    if (TABLE_SCHEMA_FILE_RE.test(filename) && (await lstat(path.dirname(full))).isSymbolicLink()) throw new WorkItemActionError("TableSchema 資料夾是符號連結，拒絕寫入。");
    const existing = await lstat(full).catch(() => null);
    if (existing?.isSymbolicLink()) throw new WorkItemActionError(`「${filename}」是符號連結，拒絕寫入。`);
    await writeFile(full, a.content, "utf-8");
  } catch (e) {
    if (e instanceof WorkItemActionError) throw e;
    throw new WorkItemActionError(`寫入失敗：${errorMessage(e)}`);
  }
  return okReply({ workItemId: ctx.id, filename, bytes, note: "已寫入；不會自動標記完成，寫好後請用 done 交件。" });
}
