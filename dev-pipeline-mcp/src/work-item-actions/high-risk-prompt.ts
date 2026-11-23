/**
 * 高風險（highRisk）需求才附加的角色說明段落。動態附加、不動靜態說明書，所以一般需求的說明書逐字不變；
 * 每個角色的段落長度上限 MAX_SECTION_CHARS，由測試鎖定。
 */

export const MAX_SECTION_CHARS = 1200;

const SECTIONS: Readonly<Record<string, string>> = {
  "tech-selector": [
    "## 高風險需求：技術選型只選語言與框架",
    "這個工作項目已標為高風險。資料庫種類與版本、是否使用 MQ、是否使用快取，都要用 SA 的真實數字取捨，所以改由 SA 之後的架構角色決定，不在這一步決定。",
    "- tech-stack.md 的「技術棧」表格只要列：前端語言、前端框架、前端元件庫、後端語言、後端框架、建置與測試工具、主要版本；不用寫「資料庫種類」與「資料庫版本」。",
    "- 既有系統的資料庫種類沿用現況盤點（baseline.md）寫的內容，不另外選。",
    "- 選語言與框架時，順手標出它們的執行緒模型與記憶體特性（例如單執行緒事件迴圈、垃圾回收暫停），讓架構角色能檢查與非功能需求有沒有衝突。",
  ].join("\n"),
};

/** 角色在高風險需求下的附加說明段落；沒有就回 undefined。 */
export function highRiskPromptSection(roleId: string): string | undefined {
  return SECTIONS[roleId];
}

export const HIGH_RISK_ROLE_IDS: readonly string[] = Object.freeze(Object.keys(SECTIONS));
