/**
 * db_query（AI 用的 stdio 工具）專用的硬性唯讀把關。原則：寧可誤擋，不可誤放（fail closed）。
 *
 * 這一層刻意「只包在 AI 呼叫路徑」，不放進 db-client.ts 那個共用執行引擎——
 * HTTP bridge（claudeweb 網頁的 Database 工具，人手動點執行）要能跑 INSERT/UPDATE，
 * 這是使用者全域規則裡「寫入語句交給使用者手動執行」的那個手動執行管道本身，不該被這裡擋掉。
 */

const ALLOWED_PREFIXES = ["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"];

// \b 詞界避免誤判 update_count 這種欄位名；但字串常值裡剛好出現這些完整字仍會被擋——
// 是刻意的取捨，擋錯了大不了手動查，好過放過一句藏在 CTE 裡的 DELETE。
const DANGEROUS_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|CALL|INTO)\b/i;

function stripComments(sql: string): string {
  return sql.replace(/--[^\r\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 尊重引號內分號的多語句切割，跟 claudeweb 原本 Java 版 splitStatements 邏輯一致。 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (const ch of sql) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ";" && !inSingle && !inDouble) {
      const s = current.trim();
      if (s) statements.push(s);
      current = "";
      continue;
    }
    current += ch;
  }
  const last = current.trim();
  if (last) statements.push(last);
  return statements;
}

export interface ReadOnlyCheckResult {
  ok: boolean;
  reason?: string;
  statements: string[];
}

/** 任一句沒過關，整批拒絕——不要「跑掉合法的幾句、擋掉違規那句」。 */
export function checkReadOnly(sql: string): ReadOnlyCheckResult {
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    return { ok: false, reason: "沒有可執行的 SQL 語句", statements };
  }

  for (const raw of statements) {
    const stripped = stripComments(raw).trim();
    const upperFirstWord = stripped.split(/\s+/)[0]?.toUpperCase() ?? "";

    if (!ALLOWED_PREFIXES.includes(upperFirstWord)) {
      return {
        ok: false,
        reason: `語句「${raw.slice(0, 60)}...」開頭不是唯讀語句（只允許 ${ALLOWED_PREFIXES.join("/")}），這個工具不執行寫入/DDL——把 SQL 貼給使用者在 Database 工具手動執行`,
        statements,
      };
    }

    const dangerMatch = stripped.match(DANGEROUS_KEYWORDS);
    if (dangerMatch) {
      return {
        ok: false,
        reason: `語句裡出現非唯讀關鍵字「${dangerMatch[0]}」（可能包在 CTE 或子查詢裡），這個工具不執行寫入/DDL——把 SQL 貼給使用者在 Database 工具手動執行`,
        statements,
      };
    }
  }

  return { ok: true, statements };
}
