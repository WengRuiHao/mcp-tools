import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkItemActionError, need, okReply, type ToolReply } from "./common.js";
import type { WorkItemArgs } from "./schema.js";

/** template 動作可取的範本：名稱對應引擎自帶的 docs/sasd-standard 檔案（不依賴專案目錄）。 */
export const TEMPLATE_FILES = {
  sa: "SA-範本.md",
  sd: "SD-範本.md",
  "table-schema": "資料表結構文件-範本.md",
  "system-er": "系統ER圖-範本.md",
  "mockup-states": "mockup-狀態切換範例.html",
} as const;
export type TemplateName = keyof typeof TEMPLATE_FILES;
export const TEMPLATE_NAMES = Object.keys(TEMPLATE_FILES) as TemplateName[];

const STANDARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "sasd-standard");

/** 取範本全文：範本是已通過各項檢查的合格樣本，照結構改寫內容即可。 */
export async function handleTemplate(a: WorkItemArgs): Promise<ToolReply> {
  const { template } = need("template", a, ["template"]);
  const file = TEMPLATE_FILES[template];
  if (!file) throw new WorkItemActionError(`未知的範本「${template}」，可用：${TEMPLATE_NAMES.join("、")}`);
  let content: string;
  try {
    content = (await readFile(path.join(STANDARD_DIR, file), "utf-8")).replace(/\r\n/g, "\n");
  } catch {
    throw new WorkItemActionError(`讀不到範本檔「${file}」（引擎安裝不完整）；請回報給維護者，先依角色說明的結構自行撰寫。`);
  }
  return okReply({ template, content, note: "這是已通過系統檢查的合格樣本：照它的章節、表頭與格式，把內容換成這次需求。" });
}
