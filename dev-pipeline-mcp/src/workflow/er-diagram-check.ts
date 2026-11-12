// ER 圖檢查：Mermaid erDiagram 必須與範圍內的表（SQL）與關聯清單一致。
// 程式負責：表集合、PK／FK 欄位標註完整、圖上欄位存在於 SQL、關聯線與關聯清單一一對應（方向與基數符號一致）、brownfield 的新增／修改標註。
// 不檢查：其他欄位有沒有列全（欄位完整性由各表的欄位清單負責）、邏輯關聯的真偽（由規格驗證師對照程式碼確認）。
import { checkMermaidText, MERMAID_FILE_NAME } from "./mermaid-check.js";
import { KIND_MANY, KIND_ONE, isRequired, type Relation } from "./relation-list-check.js";
import { parseErDiagram, type ErAttribute, type ErDiagram, type ErLine } from "./er-parse.js";
import type { SqlTable } from "./sql-schema-parse.js";

export const MARK_NEW = "本次新增";
export const MARK_MODIFIED = "本次修改";
/** 關係符號：父表側由「必選／可選」決定，子表側由「一對多／一對一」決定。 */
export const PARENT_SYMBOLS: Readonly<Record<"required" | "optional", string>> = { required: "||", optional: "|o" };
export const CHILD_SYMBOLS: Readonly<Record<string, string>> = { [KIND_MANY]: "o{", [KIND_ONE]: "o|" };

export interface ExpectedRelation {
  parent: string;
  child: string;
  kind: string;
  required: boolean;
}
export interface ErScope {
  tables: readonly SqlTable[];
  relations: readonly ExpectedRelation[];
  /** 需要標註的表：表名 → 「本次新增」或「本次修改」（只有 brownfield 系統圖傳入；其餘表不得有標註）。 */
  marks?: ReadonlyMap<string, string>;
  /** 本次 02-db.sql 無資料表異動（只有註解）：標註違規的訊息改成說明無異動。 */
  noChange?: boolean;
}

export const lineText = (e: ExpectedRelation): string => `${e.parent} ${PARENT_SYMBOLS[e.required ? "required" : "optional"]}--${CHILD_SYMBOLS[e.kind] ?? "o{"} ${e.child}`;
const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const inList = (list: readonly string[], x: string): boolean => list.some((y) => eq(x, y));

/** 把關聯清單的列轉成圖上應有的關聯（必選與否取自子表 NOT NULL）；兩端都在 inScope 內才畫。 */
export function expectedRelations(rels: readonly Relation[], tables: readonly SqlTable[], inScope: (name: string) => boolean): ExpectedRelation[] {
  return rels.filter((r) => inScope(r.child) && inScope(r.parent)).map((r) => {
    const child = tables.find((t) => t.name === r.child);
    return { parent: r.parent, child: r.child, kind: r.kind, required: child ? isRequired(child, r.childCols) : false };
  });
}

function checkAttributes(name: string, attrs: readonly ErAttribute[], t: SqlTable, where: string): string[] {
  const out: string[] = [];
  const fkCols = t.foreignKeys.flatMap((f) => f.columns);
  for (const a of attrs) {
    if (!t.columnsPartial && !inList(t.columns, a.name)) out.push(`${where} 的表 ${name} 列了 SQL 沒有的欄位 ${a.name}`);
    else if (t.columnsPartial && !inList(t.columns, a.name)) out.push(`${where} 的表 ${name} 是只知道部分欄位的既有表，圖上的欄位 ${a.name} 不在它的欄位清單內：請先把 ${a.name} 補進該表文件的「欄位清單」（或「既有資料表」一節的「欄位」欄），或從圖上移除`);
  }
  for (const [cols, key] of [[t.primaryKey, "PK"], [fkCols, "FK"]] as const) {
    for (const c of cols) {
      const a = attrs.find((x) => eq(x.name, c));
      if (!a) out.push(`${where} 的表 ${name} 缺少${key === "PK" ? "主鍵" : "外鍵"}欄位 ${c}（要列出並標註 ${key}）`);
      else if (!a.keys.includes(key)) out.push(`${where} 的表 ${name} 的欄位 ${c} 是${key === "PK" ? "主鍵" : "外鍵"}，要標註 ${key}`);
    }
    for (const a of attrs) if (a.keys.includes(key) && inList(t.columns, a.name) && !inList(cols, a.name)) out.push(`${where} 的表 ${name} 的欄位 ${a.name} 標註了 ${key}，但 SQL 裡它不是${key === "PK" ? "主鍵" : "外鍵"}`);
  }
  return out;
}

function checkMarks(name: string, attrs: readonly ErAttribute[], want: string | undefined, where: string, noChange = false): string[] {
  const found = [MARK_NEW, MARK_MODIFIED].filter((m) => attrs.some((a) => a.comment.includes(m)));
  if (want === undefined) return found.length > 0 ? [`${where} 的表 ${name} 不是${found[0]}的表，不可標「${found[0]}」${noChange ? "（本次 02-db.sql 沒有任何 CREATE／ALTER，無資料表異動，不可標「本次新增」「本次修改」）" : ""}`] : [];
  if (found.length === 0) return [`${where} 的表 ${name} 要標「${want}」（在該表任一欄位的註解 "…" 寫「${want}」）`];
  return found.length === 1 && found[0] === want ? [] : [`${where} 的表 ${name} 標了「${found.join("、")}」，應為「${want}」`];
}

function matchLine(e: ExpectedRelation, lines: readonly ErLine[], used: Set<ErLine>, where: string): string[] {
  const want = lineText(e);
  const hit = lines.find((l) => !used.has(l) && eq(l.left, e.parent) && eq(l.right, e.child));
  if (hit) {
    used.add(hit);
    const [p, c] = [PARENT_SYMBOLS[e.required ? "required" : "optional"], CHILD_SYMBOLS[e.kind] ?? "o{"];
    return hit.leftSym === p && hit.rightSym === c ? [] : [`${where} 第 ${hit.line} 行的關聯線 ${hit.left} ${hit.leftSym}--${hit.rightSym} ${hit.right} 符號與關聯清單不一致，應為：${want}（${e.required ? "必選" : "可選"}、${e.kind}）`];
  }
  const rev = lines.find((l) => !used.has(l) && eq(l.left, e.child) && eq(l.right, e.parent));
  if (rev) {
    used.add(rev);
    return [`${where} 第 ${rev.line} 行的關聯線方向相反，父表在左、子表在右，應為：${want}`];
  }
  return [`${where} 缺少關聯線 ${e.parent}→${e.child}（關聯清單有這筆關聯，圖上要畫：${want}）`];
}

/** 檢查一張 ER 圖（src 為 Mermaid 全文）。where 例如「TableSchema/orders.md 的模組 ER 圖」。 */
export function checkErDiagram(src: string, where: string, scope: ErScope): string[] {
  const out = checkMermaidText(src).map((v) => `${where} 的圖內容不合格：${v.split(MERMAID_FILE_NAME).join("ER 圖")}`);
  const d: ErDiagram = parseErDiagram(src);
  d.unknown.forEach((u) => out.push(`${where} 第 ${u.line} 行無法辨識：${u.text.slice(0, 40)}`));
  const names = scope.tables.map((t) => t.name);
  const missing = names.filter((n) => ![...d.entities.keys()].some((e) => eq(e, n)));
  const extra = [...d.entities.keys()].filter((e) => !inList(names, e));
  if (missing.length > 0) out.push(`${where} 缺少資料表：${missing.join("、")}（圖上的表必須等於範圍內的全部表）`);
  if (extra.length > 0) out.push(`${where} 多了範圍外的資料表：${extra.join("、")}`);
  for (const t of scope.tables) {
    const key = [...d.entities.keys()].find((e) => eq(e, t.name));
    if (key === undefined) continue;
    const attrs = d.entities.get(key) ?? [];
    out.push(...checkAttributes(t.name, attrs, t, where));
    if (scope.marks) out.push(...checkMarks(t.name, attrs, scope.marks.get(t.name), where, scope.noChange));
  }
  const used = new Set<ErLine>();
  scope.relations.forEach((e) => out.push(...matchLine(e, d.lines, used, where)));
  d.lines.filter((l) => !used.has(l)).forEach((l) => out.push(`${where} 第 ${l.line} 行的關聯線 ${l.left}--${l.right} 沒有對應的關聯清單項目（每條線都要在關聯清單有一筆）`));
  return out;
}
