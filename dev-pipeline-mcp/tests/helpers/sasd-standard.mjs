// 讀取 docs/sasd-standard 的已確認範本（SA／SD／資料表結構／mockup），當作各項檢查的合格樣本。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STANDARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "sasd-standard");
export const readStandard = (name) => readFileSync(path.join(STANDARD_DIR, name), "utf-8").replace(/\r\n/g, "\n");
export const SA_TEMPLATE = () => readStandard("SA-範本.md");
export const SD_TEMPLATE = () => readStandard("SD-範本.md");
export const MOCKUP_TEMPLATE = () => readStandard("mockup-狀態切換範例.html");

/** 資料表結構文件範本拆成每張表一份：{ 表名: 內容 }。 */
export function tableSchemaTemplates() {
  const out = {};
  for (const part of readStandard("資料表結構文件-範本.md").split(/\n---\n/)) {
    const m = /^# (\w+) 資料表結構/m.exec(part);
    if (m) out[m[1]] = part.trim() + "\n";
  }
  return out;
}
