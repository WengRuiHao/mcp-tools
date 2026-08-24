/**
 * `:paramName` 具名參數解析，跟 claudeweb 原本 Java 版的 PARAM_PATTERN 邏輯一致——
 * 用負向後顧排除 PostgreSQL 的 `::` cast 運算子（`col::text` 不該被當成參數 `:text`）。
 *
 * 各資料庫的原生參數語法不一樣，所以轉換規則放在這裡共用，實際套用哪一種由各 driver 自己決定：
 * postgres/mysql 用位置參數（$1.../?），mssql 用 @name（driver 端要另外呼叫 request.input），
 * oracle 原生就吃 :name，driver 端完全不需要呼叫這裡的轉換函式。
 */
const NAMED_PARAM_PATTERN = /(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g;

export function findNamedParams(sql: string): string[] {
  const names: string[] = [];
  for (const m of sql.matchAll(NAMED_PARAM_PATTERN)) names.push(m[1]);
  return names;
}

/** 轉成位置參數（`$1,$2,...` 或 `?`），回傳轉換後的 SQL 跟每個位置對應的參數名（同名參數重複出現會各自佔一個位置）。 */
export function toPositionalPlaceholders(
  sql: string,
  placeholderFor: (index: number) => string
): { sql: string; paramOrder: string[] } {
  const paramOrder: string[] = [];
  let i = 0;
  const result = sql.replace(NAMED_PARAM_PATTERN, (_match, name: string) => {
    i += 1;
    paramOrder.push(name);
    return placeholderFor(i);
  });
  return { sql: result, paramOrder };
}

/** 轉成 mssql 的 `@name` 具名參數語法。 */
export function toAtNamedPlaceholders(sql: string): { sql: string; paramNames: string[] } {
  const seen = new Set<string>();
  const result = sql.replace(NAMED_PARAM_PATTERN, (_match, name: string) => {
    seen.add(name);
    return `@${name}`;
  });
  return { sql: result, paramNames: [...seen] };
}
