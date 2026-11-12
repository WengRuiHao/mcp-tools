// 「無異動」夾具：沿用資料表結構文件範本的表與圖，示範既有系統只讀既有表（02-db.sql 只有註解）。
// 既有表的 NOT NULL 資訊未知，關聯一律視為可選：模組與系統 ER 圖的 `||--o{` 改為 `|o--o{`。
import fs from "node:fs";
import path from "node:path";
import { tableSchemaTemplates, systemErTemplate, installSchemaExtras } from "./sasd-standard.mjs";

export const NO_CHANGE_SQL = "-- 本次沒有資料庫異動：只讀既有表 members、orders、order_items\n-- 刻意不含任何 CREATE / ALTER / DROP\n";
export const EXISTING_SECTION = [
  "## 既有資料表", "", "| 資料表 | 主鍵 | 外鍵 | 欄位 | 說明 |", "| --- | --- | --- | --- | --- |",
  "| members | id | 無 | id、name、created_at | 會員 |",
  "| orders | id | member_id→members.id | id、order_no、member_id、ordered_at | 訂單主檔 |",
  "| order_items | id | order_id→orders.id | id、order_id、product_name、quantity、subtotal | 訂單明細 |", "",
].join("\n");
const optional = (t) => t.replaceAll("||--o{", "|o--o{");

/** 合格的無異動文件組：{ orders, members, systemEr }。 */
export function noChangeDocs() {
  const t = tableSchemaTemplates();
  return { orders: optional(t.orders), members: optional(t.members), systemEr: `${optional(systemErTemplate()).trimEnd()}\n\n${EXISTING_SECTION}` };
}

/** 把無異動夾具寫進工作項目目錄；over 可覆蓋 sql、orders、members、systemEr（orders／members 給 null 表示不寫）。 */
export function writeNoChangeItem(dir, over = {}) {
  const d = { ...noChangeDocs(), ...over };
  fs.mkdirSync(path.join(dir, "TableSchema"), { recursive: true });
  fs.writeFileSync(path.join(dir, "02-db.sql"), over.sql ?? NO_CHANGE_SQL);
  installSchemaExtras(dir);
  fs.writeFileSync(path.join(dir, "TableSchema", "system-er.md"), d.systemEr);
  for (const n of ["orders", "members"]) if (d[n] !== null) fs.writeFileSync(path.join(dir, "TableSchema", `${n}.md`), d[n]);
  return dir;
}
