// 讀取 docs/sasd-standard 的已確認範本（SA／SD／資料表結構／mockup），當作各項檢查的合格樣本。
import fs, { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STANDARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "sasd-standard");
export const readStandard = (name) => readFileSync(path.join(STANDARD_DIR, name), "utf-8").replace(/\r\n/g, "\n");
export const SA_TEMPLATE = () => readStandard("SA-範本.md");
export const SD_TEMPLATE = () => readStandard("SD-範本.md");
export const MOCKUP_TEMPLATE = () => readStandard("mockup-狀態切換範例.html");

/** 資料表結構文件範本拆成每份文件：{ 主表名: 內容 }（以「交付檔案：TableSchema/<名稱>.md」辨識）。 */
export function tableSchemaTemplates() {
  const out = {};
  for (const part of readStandard("資料表結構文件-範本.md").split(/\n---\n/)) {
    const m = /交付檔案：TableSchema\/(\w[\w-]*)\.md/.exec(part);
    if (m) out[m[1]] = part.trim() + "\n";
  }
  return out;
}

/** 範本 SQL：與資料表結構文件範本（orders 含 order_items、members）一致。 */
export const TEMPLATE_SQL = `CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS "orders" (
  id INTEGER PRIMARY KEY, /* 主鍵 */
  order_no TEXT UNIQUE,
  member_id INTEGER NOT NULL REFERENCES members(id),
  ordered_at TEXT,
  FOREIGN KEY (member_id) REFERENCES members(id)
);
CREATE INDEX idx_orders_member_date ON orders(member_id, ordered_at);
CREATE TABLE dbo.order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, product_name TEXT, quantity INTEGER CHECK (quantity > 0), subtotal INTEGER, CONSTRAINT fk FOREIGN KEY (order_id) REFERENCES orders(id));
`;
export const systemErTemplate = () => readStandard("系統ER圖-範本.md");

/** 把範本的系統 ER 圖文件與全部 ER 圖 PNG 放進工作項目的 TableSchema/（模組文件由呼叫端自己放）。 */
export function installSchemaExtras(dir) {
  fs.mkdirSync(path.join(dir, "TableSchema", "er"), { recursive: true });
  fs.writeFileSync(path.join(dir, "TableSchema", "system-er.md"), systemErTemplate());
  for (const f of ["orders", "members", "system-er"]) fs.copyFileSync(path.join(STANDARD_DIR, "er", `${f}.png`), path.join(dir, "TableSchema", "er", `${f}.png`));
}
