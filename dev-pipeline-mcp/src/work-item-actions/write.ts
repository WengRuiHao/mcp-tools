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

export async function handleWrite(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId, filename } = need("write", a, ["workItemId", "filename"]);
  if (typeof a.content !== "string") throw new WorkItemActionError("action=write 缺少必填參數：content");
  const allowed = writableFilenames();
  if (!allowed.includes(filename)) throw new WorkItemActionError(`不允許寫入「${filename}」：只能寫流程定義的產出檔（${allowed.join("、")}）。圖片請用 attach，不可帶路徑。`);
  const bytes = Buffer.byteLength(a.content, "utf-8");
  if (bytes > MAX_WRITE_BYTES) throw new WorkItemActionError(`content 太大（${bytes} bytes），上限 ${MAX_WRITE_BYTES} bytes。`);
  const ctx = await loadWorkItem(workItemId);
  try {
    const full = resolveArtifactPath(ctx.dir, filename);
    await mkdir(path.dirname(full), { recursive: true });
    const existing = await lstat(full).catch(() => null);
    if (existing?.isSymbolicLink()) throw new WorkItemActionError(`「${filename}」是符號連結，拒絕寫入。`);
    await writeFile(full, a.content, "utf-8");
  } catch (e) {
    if (e instanceof WorkItemActionError) throw e;
    throw new WorkItemActionError(`寫入失敗：${errorMessage(e)}`);
  }
  return okReply({ workItemId: ctx.id, filename, bytes, note: "已寫入；不會自動標記完成，寫好後請用 done 交件。" });
}
