// 標題比對的共用函式：所有「以標題文字找章節」的檢查都用這裡，標題前面的編號一律忽略。
// 編號前綴例：「3.」「3.1」「3、」「3)」「五、」「（一）」「(2)」「第五節」「第 3 章」「一、」。
// 只有編號後面還有文字時才剝除，且編號後必須有分隔符號或空白，避免「一覽表」「2026 年度」這類標題被誤剝。

const CN_NUM = "[一二三四五六七八九十百零〇]+";
const NUMBER_PREFIX_RES: readonly RegExp[] = [
  new RegExp(`^第\\s*(?:${CN_NUM}|\\d+)\\s*[章節條項點]\\s*[、.．:：]?\\s*`),
  new RegExp(`^[（(]\\s*(?:${CN_NUM}|\\d+)\\s*[）)]\\s*`),
  new RegExp(`^${CN_NUM}\\s*[、.．]\\s*`),
  /^\d+(?:\.\d+)+\s*[.、．)）:：]?\s+/,
  /^\d+(?:\.\d+)*\s*[.、．)）:：]\s*/,
  /^\d+(?:\.\d+)*\s+/,
];

/** 去掉標題最前面的編號前綴（只剝一層）；剝完沒有文字就原樣回傳。 */
export function stripHeadingNumber(title: string): string {
  const t = title.trim();
  for (const re of NUMBER_PREFIX_RES) {
    const rest = t.replace(re, "");
    if (rest !== t && rest.trim() !== "") return rest.trim();
  }
  return t;
}

/** 標題（忽略編號前綴後）是否以 name 開頭。 */
export function headingMatches(title: string, name: string): boolean {
  return stripHeadingNumber(title).startsWith(name);
}

/** 標題（忽略編號前綴後）是否與 name 完全相同。 */
export function headingEquals(title: string, name: string): boolean {
  return stripHeadingNumber(title) === name;
}
