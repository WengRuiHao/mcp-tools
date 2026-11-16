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
    if (m) out[m[1]] = withInlineEr(part.trim() + "\n", m[1]);
  }
  return out;
}

/** 範本 SQL：與資料表結構文件範本（orders_master 含 orders_detail、members）一致。 */
export const TEMPLATE_SQL = `CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS "orders_master" (
  id INTEGER PRIMARY KEY, /* 主鍵 */
  order_no TEXT UNIQUE,
  member_id INTEGER NOT NULL REFERENCES members(id),
  ordered_at TEXT,
  FOREIGN KEY (member_id) REFERENCES members(id)
);
CREATE INDEX idx_orders_member_date ON orders_master(member_id, ordered_at);
CREATE TABLE dbo.orders_detail (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, product_name TEXT, quantity INTEGER CHECK (quantity > 0), subtotal INTEGER, CONSTRAINT fk FOREIGN KEY (order_id) REFERENCES orders_master(id));
`;
/** 把 er-src/<stem>.mmd 以 ```mermaid 區塊放回文件的圖片引用前面（測試用內嵌形式：方便各測試用字串替換改圖，檢查前用 splitErInline 拆成 TableSchema/_src/<stem>.mmd）。 */
export function withInlineEr(text, stem) {
  const img = new RegExp(String.raw`^!\[[^\]]*\]\(er/` + stem + String.raw`\.png\)`, "m");
  return text.replace(img, (m) => "```mermaid\n" + readStandard(`er-src/${stem}.mmd`).trimEnd() + "\n```\n\n" + m);
}

/** 把工作項目 TableSchema/*.md 的 ER 章節內嵌 mermaid 拆出：寫成 TableSchema/_src/<檔名>.mmd，文件只留圖片引用。 */
export function splitErInline(dir) {
  const td = path.join(dir, "TableSchema");
  if (!fs.existsSync(td)) return;
  for (const f of fs.readdirSync(td).filter((x) => x.endsWith(".md"))) {
    const text = fs.readFileSync(path.join(td, f), "utf-8");
    const m = /^```mermaid[^\n]*\n([\s\S]*?)^```\r?\n(?:\r?\n)?/m.exec(text);
    if (!m) continue;
    fs.mkdirSync(path.join(td, "_src"), { recursive: true });
    fs.writeFileSync(path.join(td, "_src", `${f.replace(/\.md$/, "")}.mmd`), m[1]);
    fs.writeFileSync(path.join(td, f), text.replace(m[0], ""));
  }
  // 範本的 PNG 是複製來的（保留舊的修改時間）：視為剛轉好，避免被「圖片比來源舊」擋下
  const er = path.join(td, "er");
  if (fs.existsSync(er)) for (const p of fs.readdirSync(er).filter((x) => x.endsWith(".png"))) fs.utimesSync(path.join(er, p), new Date(), new Date());
}
/** 把範本的流程圖（flow.mmd 來源與轉出的 flow.png）放進工作項目目錄，SD 的「## 流程圖」引用它。 */
export function installFlowImage(dir) {
  fs.copyFileSync(path.join(STANDARD_DIR, "flow.mmd"), path.join(dir, "flow.mmd"));
  fs.copyFileSync(path.join(STANDARD_DIR, "flow.png"), path.join(dir, "flow.png"));
  fs.utimesSync(path.join(dir, "flow.png"), new Date(), new Date());
}
export const systemErTemplate = () => withInlineEr(readStandard("系統ER圖-範本.md"), "system-er");

/** 把範本的系統 ER 圖文件（內嵌 Mermaid 的測試用形式，檢查前用 splitErInline 拆成 _src）與全部 ER 圖 PNG 放進工作項目的 TableSchema/（模組文件由呼叫端自己放）。 */
export function installSchemaExtras(dir) {
  fs.mkdirSync(path.join(dir, "TableSchema", "er"), { recursive: true });
  fs.writeFileSync(path.join(dir, "TableSchema", "system-er.md"), systemErTemplate());
  for (const f of ["orders_master", "members", "system-er"]) fs.copyFileSync(path.join(STANDARD_DIR, "er", `${f}.png`), path.join(dir, "TableSchema", "er", `${f}.png`));
}
