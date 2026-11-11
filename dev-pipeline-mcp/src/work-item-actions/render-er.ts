// render kind=mermaid 的 ER 圖來源：src 為 TableSchema/ 內的 .md 時，取出文件裡的 Mermaid 區塊轉成 PNG（out 限 TableSchema/er/<名稱>.png）。
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { mermaidBlocks } from "../workflow/table-schema-doc.js";
import { WorkItemActionError } from "./common.js";

export const ER_MD_SRC_RE = /^TableSchema\/(?:[A-Za-z0-9_]+|system-er)\.md$/;
export const ER_PNG_OUT_RE = /^TableSchema\/er\/[A-Za-z0-9_-]+\.png$/;

/** src 是資料表結構文件時，把文件內唯一的 Mermaid 區塊寫成暫存 .mmd 交給 run，結束後刪除；回傳 run 的結果。 */
export async function withErDiagramSource<T>(dir: string, src: string, out: string, run: (mmdRel: string) => Promise<T>): Promise<T> {
  if (!ER_PNG_OUT_RE.test(out)) throw new WorkItemActionError("轉 ER 圖時 out 必須是 TableSchema/er/<名稱>.png（名稱限英數字、底線與連字號）。");
  const full = path.join(dir, ...src.split("/"));
  const st = await lstat(full).catch(() => null);
  if (!st || !st.isFile() || st.isSymbolicLink()) throw new WorkItemActionError(`找不到文件 ${src}（先用 write 寫好含 Mermaid 圖的資料表結構文件）。`);
  const blocks = mermaidBlocks(await readFile(full, "utf-8"));
  if (blocks.length !== 1) throw new WorkItemActionError(`${src} 要有且只有一個 \`\`\`mermaid 程式碼區塊（目前 ${blocks.length} 個）。`);
  await mkdir(path.join(dir, "TableSchema", "er"), { recursive: true });
  const tmpRel = `TableSchema/er/.render-${randomBytes(4).toString("hex")}.mmd`;
  await writeFile(path.join(dir, ...tmpRel.split("/")), blocks[0], "utf-8");
  try {
    return await run(tmpRel);
  } finally {
    await rm(path.join(dir, ...tmpRel.split("/")), { force: true });
  }
}
