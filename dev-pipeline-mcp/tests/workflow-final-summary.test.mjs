// 最終驗收整理報告（純函式）：各節內容、缺資料寫「無紀錄」、不洩漏原始 JSON。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFinalSummary, buildFinalSummaryBrief, formatTime } from "../dist/workflow/final-summary.js";

const gates = [
  { id: "sa-confirm", after: "sa-analyst", type: "confirmation" },
  { id: "sa-content-check", after: "sa-analyst", type: "content" },
  { id: "verdict", after: "verifier", type: "verdict", routeOnFail: { sa: "sa-analyst", be: "backend-engineer" } },
  { id: "final-acceptance", after: "tester", type: "confirmation", locked: true },
];
const artifacts = [
  { id: "sa", file: "01-sa.md", kind: "markdown", attachments: ["sa-images/"] },
  { id: "flow", file: "flow.mmd", kind: "mermaid", render: "flow.png" },
  { id: "test", file: "test.md", kind: "report", attachments: ["evidence/"] },
];
const fact = (path, o = {}) => ({ path, exists: true, isDir: path.endsWith("/"), size: 2048, fileCount: 1, ...o });
const base = () => ({
  workItemId: "wi-20260101-001", title: "匯出報表", requirement: "需要\n匯出   Excel", baseline: "brownfield", scope: "both", hasDb: true,
  createdAt: "2026-01-01T00:00:00.000Z", gates, artifacts, consecutiveFailCount: 0, dupReport: undefined,
  progress: { roles: {}, gates: {
    "sa-confirm": { decision: "confirmed", by: "agent", at: "2026-01-01T01:00:00.000Z", reason: "審查通過" },
    "sa-content-check": { decision: "passed", by: "agent", at: "2026-01-01T00:30:00.000Z", reason: "程式檢查（checkSaImages）通過" },
    verdict: { decision: "passed", by: "agent", at: "2026-01-01T02:00:00.000Z" },
    "final-acceptance": { decision: "confirmed", by: "human", at: "2026-01-01T03:00:00.000Z", reason: "使用者說驗收通過" },
  } },
  files: [fact("01-sa.md"), fact("sa-images/", { fileCount: 3, size: 9000 }), fact("flow.mmd", { size: 10 }), fact("flow.png"), fact("test.md"), fact("evidence/", { fileCount: 2 })],
});

test("基本資料與時間（台灣時間）", () => {
  const t = buildFinalSummary(base());
  assert.match(t, /工作項目編號：wi-20260101-001/);
  assert.match(t, /需求原文摘要：需要 匯出 Excel/);
  assert.match(t, /既有系統/);
  assert.match(t, /前後端都有/);
  assert.match(t, /是否動資料庫：是/);
  assert.match(t, /建立時間：2026-01-01 08:00:00（台灣時間）/);
  assert.match(t, /完成時間（最終驗收確認）：2026-01-01 11:00:00/);
  assert.equal(formatTime("壞掉"), "無紀錄");
});

test("時間線：決定者分三類、人類附原話、沒紀錄寫無紀錄", () => {
  const t = buildFinalSummary(base());
  assert.match(t, /SA 確認（sa-confirm）：確認｜AI 審查｜.*理由：審查通過/);
  assert.match(t, /SA 內容檢查（sa-content-check）：通過｜程式檢查/);
  assert.match(t, /最終驗收（final-acceptance）：確認｜使用者本人｜.*使用者原話：使用者說驗收通過/);
  const i = base();
  delete i.progress.gates["sa-confirm"];
  assert.match(buildFinalSummary(i), /SA 確認（sa-confirm）：無紀錄/);
});

test("硬停點與退回：rootCause 與退回角色、連續失敗達 3 次、得不出寫無紀錄", () => {
  const clean = buildFinalSummary(base());
  assert.match(clean, /是否碰到硬停點：無紀錄/);
  assert.match(clean, /退回紀錄.*：無紀錄/);
  const i = base();
  i.consecutiveFailCount = 3;
  i.progress.gates.verdict = { decision: "failed", by: "agent", at: "2026-01-01T02:00:00.000Z", rootCause: "be" };
  const t = buildFinalSummary(i);
  assert.match(t, /目前連續失敗次數：3/);
  assert.match(t, /有，連續失敗達 3 次/);
  assert.match(t, /驗證判定（verdict）：退回.*原因：be.*退回到角色「backend-engineer」/);
});

test("產出物：存在與大小、sa-images／evidence 張數、flow.png；缺的標不存在或無紀錄", () => {
  const t = buildFinalSummary(base());
  assert.match(t, /- 01-sa\.md：存在，2\.0 KB/);
  assert.match(t, /sa-images 張數：3 張/);
  assert.match(t, /evidence 張數：2 張/);
  assert.match(t, /flow\.png：存在/);
  const i = base();
  i.files = [fact("flow.png", { exists: false, size: 0, fileCount: 0 })];
  const m = buildFinalSummary(i);
  assert.match(m, /- 01-sa\.md：不存在/);
  assert.match(m, /sa-images 張數：無紀錄/);
  assert.match(m, /flow\.png：不存在/);
});

test("重複偵測節：有 dup-report 才出現並摘要筆數；沒有就略過；無法判讀不編造", () => {
  assert.doesNotMatch(buildFinalSummary(base()), /重複程式碼偵測/);
  const i = base();
  i.dupReport = "- 未豁免的重複區塊：0 筆\n- 已豁免的重複區塊：2 筆\n";
  const t = buildFinalSummary(i);
  assert.match(t, /## 五、重複程式碼偵測/);
  assert.match(t, /未豁免的重複區塊：0 筆/);
  assert.match(t, /已豁免的重複區塊：2 筆/);
  i.dupReport = "亂寫";
  assert.match(buildFinalSummary(i), /已豁免的重複區塊：無法判讀/);
});

test("結尾聲明、不含原始 JSON 或亂碼、全空資料不丟錯", () => {
  const t = buildFinalSummary(base());
  assert.ok(t.trimEnd().endsWith("這份報告由程式依紀錄彙整，不含 AI 的主觀評論。"));
  assert.doesNotMatch(t, /[{}]|"decision"|"by"|�|undefined|\[object/);
  const empty = buildFinalSummary({ workItemId: "x", title: null, requirement: undefined, baseline: undefined, scope: undefined, hasDb: undefined, createdAt: undefined, gates: [], artifacts: [], progress: undefined, consecutiveFailCount: NaN, files: [], dupReport: undefined });
  assert.match(empty, /需求原文摘要：無紀錄/);
  assert.doesNotMatch(empty, /undefined|NaN/);
});

test("需求原文過長會截斷；簡短摘要計數正確", () => {
  const i = base();
  i.requirement = "字".repeat(500);
  assert.match(buildFinalSummary(i), /…（已截斷/);
  assert.equal(buildFinalSummaryBrief(i), "共 4 道關卡、4 道有紀錄；連續失敗 0 次；產出物 6 項中 6 項存在。");
});

test("基本資料多兩行：畫面風格來源與技術來源；沒有紀錄時顯示無紀錄，既有行不受影響", () => {
  const t = buildFinalSummary({ ...base(), styleSource: "new-select", techSource: "existing" });
  assert.match(t, /- 畫面風格來源：全新待選（new-select）/);
  assert.match(t, /- 技術來源：沿用現有（existing）/);
  const old = buildFinalSummary(base());
  assert.match(old, /- 畫面風格來源：無紀錄/);
  assert.match(old, /- 技術來源：無紀錄/);
  assert.match(old, /是否動資料庫：是\n- 畫面風格來源/);
  const tech = buildFinalSummary({ ...base(), gates: [...gates, { id: "tech-confirm", after: "tech-selector", type: "confirmation" }] });
  assert.match(tech, /技術確認（tech-confirm）：無紀錄/);
});
