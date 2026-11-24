// 高風險需求的 SD「上線與回滾」節檢查（批次 2M-a）。純文字檢查，回傳違規逐項說明（空陣列＝合格）。
// 只檢查有沒有寫、寫了內容、回滾判斷有門檻數字、不可逆有理由；寫得好不好由審查員判斷。
import { extractSection } from "./reuse-record-check.js";

export const ROLLOUT_SECTION = "上線與回滾";

export interface RolloutItem {
  name: string;
  /** 項目標籤的容許寫法（去掉空白後比對）。 */
  labels: readonly string[];
  hint: string;
}

export const ROLLOUT_ITEMS: readonly RolloutItem[] = [
  { name: "上線步驟", labels: ["上線步驟"], hint: "先 DB 還是先程式的順序、是否需要停機" },
  { name: "DB 變更回滾", labels: ["DB變更回滾", "DB回滾"], hint: "每個資料表異動的還原方式，或寫「不可逆」並寫理由" },
  { name: "功能開關", labels: ["功能開關"], hint: "新功能如何關閉，不適用要寫理由" },
  { name: "回滾判斷", labels: ["回滾判斷"], hint: "上線後觀察哪些指標、超過什麼門檻（要有數字）就回滾" },
  { name: "相容性", labels: ["相容性"], hint: "新舊版本同時運行（滾動部署）時，資料格式與 API 如何向下相容" },
];

const strip = (s: string): string => s.replace(/[`*_\s]/g, "");

/** 找項目內容：標籤行（可有項目符號、粗體、全形或半形冒號），回傳冒號之後的文字，沒有就回 null；標籤在冒號前面或粗體內都接受。 */
function itemContent(body: string, item: RolloutItem): string | null {
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "");
    const m = /^(.{1,30}?)\s*[:：]\s*(.*)$/.exec(line);
    if (!m) continue;
    // 粗體把冒號包在裡面（**上線步驟：** 內容）時，標籤是冒號前的部分，內容在後面
    if (!item.labels.includes(strip(m[1]))) continue;
    return m[2].replace(/^\*+\s*/, "").trim();
  }
  return null;
}

/** needsDbRollback：本工作項目有資料表異動（TableSchema 有結構文件）才要求「DB 變更回滾」。 */
export function checkSdRollout(text: string, opts: { needsDbRollback: boolean }): string[] {
  const body = extractSection(text, ROLLOUT_SECTION);
  if (body === null) {
    return [`缺少「## ${ROLLOUT_SECTION}」章節：高風險需求的 SD 必須寫上線與回滾，包含 ${ROLLOUT_ITEMS.filter((i) => opts.needsDbRollback || i.name !== "DB 變更回滾").map((i) => i.name).join("、")}（每項一行，格式「- 項目：內容」）`];
  }
  const out: string[] = [];
  for (const item of ROLLOUT_ITEMS) {
    if (item.name === "DB 變更回滾" && !opts.needsDbRollback) continue;
    const content = itemContent(body, item);
    if (content === null || content === "") {
      out.push(`「${ROLLOUT_SECTION}」缺少「${item.name}」或沒有寫內容（${item.hint}）；格式「- ${item.name}：內容」`);
      continue;
    }
    if (item.name === "回滾判斷" && !/\d/.test(content)) out.push(`「${ROLLOUT_SECTION}」的「回滾判斷」要寫門檻數字（例如錯誤率超過 1% 就回滾）：${content.slice(0, 40)}`);
    if (item.name === "DB 變更回滾" && /不可逆/.test(content) && strip(content).replace("不可逆", "").length < 8) {
      out.push(`「${ROLLOUT_SECTION}」的「DB 變更回滾」寫了不可逆，必須同時寫理由與上線前的備份或補救做法`);
    }
  }
  return out;
}

/** SD 的「上線與回滾」節裡，「DB 變更回滾」是否寫了不可逆（高風險時要使用者本人確認）。 */
export function hasIrreversibleDbChange(text: string): boolean {
  const body = extractSection(text, ROLLOUT_SECTION);
  if (body === null) return false;
  const item = ROLLOUT_ITEMS.find((i) => i.name === "DB 變更回滾");
  const content = item ? itemContent(body, item) : null;
  return content !== null && /不可逆/.test(content);
}
