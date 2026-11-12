// SQL（02-db.sql 或專案既有的 DB 腳本）解析：CREATE TABLE 的表名、欄位、主鍵、外鍵、唯一欄位、NOT NULL，以及 ALTER TABLE 的表名。
// 只做結構檢查需要的最小解析，不是完整 SQL 解析器；寫法解析不出來時寧可漏報也不亂報，由驗證師對照實際 DB 確認。

export interface SqlForeignKey {
  /** 子表的外鍵欄位（複合外鍵有多個）。 */
  columns: string[];
  parentTable: string;
  /** 父表欄位；SQL 沒寫（REFERENCES t）時為空陣列。 */
  parentColumns: string[];
}

export interface SqlTable {
  name: string;
  /** 全部欄位（依宣告順序）。 */
  columns: string[];
  primaryKey: string[];
  foreignKeys: SqlForeignKey[];
  /** 唯一欄位組：欄位層級 UNIQUE、表層級 UNIQUE（單欄或複合）、CREATE UNIQUE INDEX。 */
  uniques: string[][];
  notNull: string[];
  /** 只知道部分欄位（「既有資料表」一節宣告的表）：圖上與清單的其他欄位不判為「不存在」。 */
  columnsPartial?: boolean;
}

const NON_COLUMN_RE = /^(?:constraint|primary|foreign|unique|key|index|check|fulltext|spatial|exclude|like)\b/i;
const stripSqlComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
export const unquote = (id: string): string => id.replace(/^[`"[]+|[`"\]]+$/g, "");
const ID = "[`\"[\\]\\w.]+";
const idList = (s: string): string[] => s.split(",").map((x) => unquote(x.trim())).filter(Boolean);
const lastPart = (id: string): string => unquote(id.split(".").pop() ?? "");

/** 找出對應的右括號位置（text[open] 是左括號）；找不到回 -1。單引號字串內的括號不算。 */
function matchParen(text: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** 以最外層逗號切開欄位定義（括號與單引號字串內的逗號不算）。 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (const ch of body) {
    if (ch === "'") quoted = !quoted;
    else if (!quoted && ch === "(") depth++;
    else if (!quoted && ch === ")") depth--;
    if (ch === "," && depth === 0 && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  return [...parts, cur].map((p) => p.trim()).filter(Boolean);
}

const REFERENCES_RE = new RegExp(`REFERENCES\\s+(${ID})\\s*(?:\\(([^)]*)\\))?`, "i");
const TABLE_FK_RE = new RegExp(`^(?:CONSTRAINT\\s+${ID}\\s+)?FOREIGN\\s+KEY\\s*(?:${ID}\\s*)?\\(([^)]*)\\)\\s*REFERENCES\\s+(${ID})\\s*(?:\\(([^)]*)\\))?`, "i");

function foreignKeyOf(columns: string[], m: RegExpExecArray, parentIdx: number): SqlForeignKey {
  return { columns, parentTable: lastPart(m[parentIdx]), parentColumns: idList(m[parentIdx + 1] ?? "") };
}

function applyConstraint(item: string, t: SqlTable): boolean {
  const fk = TABLE_FK_RE.exec(item);
  if (fk) {
    t.foreignKeys.push(foreignKeyOf(idList(fk[1]), fk, 2));
    return true;
  }
  const pk = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(item);
  if (pk) t.primaryKey = idList(pk[1]);
  const uq = /^(?:CONSTRAINT\s+\S+\s+)?UNIQUE(?:\s+(?:KEY|INDEX))?\s*(?:\S+\s*)?\(([^)]*)\)/i.exec(item);
  if (uq) t.uniques.push(idList(uq[1]));
  return false;
}

function applyColumn(item: string, name: string, t: SqlTable): void {
  const rest = item.slice(item.indexOf(name) + name.length);
  if (/\bPRIMARY\s+KEY\b/i.test(rest)) t.primaryKey = [name];
  if (/\bUNIQUE\b/i.test(rest)) t.uniques.push([name]);
  if (/\bNOT\s+NULL\b/i.test(rest)) t.notNull.push(name);
  const ref = REFERENCES_RE.exec(rest);
  if (ref) t.foreignKeys.push(foreignKeyOf([name], ref, 1));
}

function parseTableBody(name: string, body: string): SqlTable {
  const t: SqlTable = { name, columns: [], primaryKey: [], foreignKeys: [], uniques: [], notNull: [] };
  for (const item of splitTopLevel(body)) {
    if (NON_COLUMN_RE.test(item)) {
      applyConstraint(item, t);
      continue;
    }
    const col = unquote(/^([`"[\]\w]+)/.exec(item)?.[1] ?? "");
    if (!col) continue;
    t.columns.push(col);
    applyColumn(item, col, t);
  }
  return t;
}

const ALTER_FK_RE = new RegExp(`ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${ID})\\s+ADD\\s+(?:CONSTRAINT\\s+${ID}\\s+)?FOREIGN\\s+KEY\\s*\\(([^)]*)\\)\\s*REFERENCES\\s+(${ID})\\s*(?:\\(([^)]*)\\))?`, "gi");
const UNIQUE_INDEX_RE = new RegExp(`CREATE\\s+UNIQUE\\s+INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}\\s+ON\\s+(${ID})\\s*\\(([^)]*)\\)`, "gi");

/** 解析 SQL 中所有 CREATE TABLE（表名去掉 schema 前綴與引號），並套用同一份 SQL 內的 ALTER TABLE ADD FOREIGN KEY 與 CREATE UNIQUE INDEX。 */
export function parseCreateTables(sql: string): SqlTable[] {
  const text = stripSqlComments(sql);
  const out: SqlTable[] = [];
  for (const m of text.matchAll(/CREATE\s+(?:(?:GLOBAL\s+|LOCAL\s+)?TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\]\w.]+)\s*\(/gi)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchParen(text, open);
    if (close >= 0) out.push(parseTableBody(lastPart(m[1]), text.slice(open + 1, close)));
  }
  for (const m of text.matchAll(ALTER_FK_RE)) out.find((t) => t.name === lastPart(m[1]))?.foreignKeys.push({ columns: idList(m[2]), parentTable: lastPart(m[3]), parentColumns: idList(m[4] ?? "") });
  for (const m of text.matchAll(UNIQUE_INDEX_RE)) out.find((t) => t.name === lastPart(m[1]))?.uniques.push(idList(m[2]));
  return out;
}

export type SqlKind = "blank" | "comment-only" | "statements";

/** 02-db.sql 的內容分類：完全空白、只有註解（無資料表異動）、有任何語句。 */
export function classifySql(sql: string): SqlKind {
  if (sql.trim() === "") return "blank";
  return stripSqlComments(sql).replace(/[;\s]/g, "") === "" ? "comment-only" : "statements";
}

/** SQL 內有 ALTER TABLE 的表名（去重）；brownfield 系統圖用來判斷「本次修改」。 */
export function parseAlteredTables(sql: string): string[] {
  const names = [...stripSqlComments(sql).matchAll(new RegExp(`ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${ID})`, "gi"))].map((m) => lastPart(m[1]));
  return [...new Set(names)];
}
