import { STYLE_SOURCE_LABELS, TECH_SOURCE_LABELS } from "../work-item-sources.js";
import type { ArtifactDef, GateDef } from "./schema.js";
import type { GateRecord, WorkItemProgress } from "./work-item-progress.js";

/** 最終驗收整理報告（純函式，不做 IO）：把工作項目的紀錄與檔案現況彙整成繁體中文 markdown。只寫紀錄裡有的，沒有就寫「無紀錄」。 */

export const FINAL_SUMMARY_FILE = "final-summary.md";
const NO_RECORD = "無紀錄";
const HARD_STOP_FAIL_COUNT = 3;
const REQUIREMENT_LIMIT = 200;
const TAIWAN_OFFSET_MS = 8 * 3600 * 1000;

/** 一個檔案或資料夾的現況（由呼叫端量測）；資料夾的 size 是底下檔案總大小、fileCount 是檔案張數。 */
export interface FileFact {
  path: string;
  exists: boolean;
  isDir: boolean;
  size: number;
  fileCount: number;
}

export interface FinalSummaryInput {
  workItemId: string;
  title: string | null;
  requirement: string | undefined;
  baseline: string | undefined;
  scope: string | undefined;
  hasDb: boolean | undefined;
  /** 畫面風格來源、技術來源（舊工作項目沒有就不給，顯示「無紀錄」）。 */
  styleSource?: string | undefined;
  techSource?: string | undefined;
  createdAt: string | undefined;
  /** 目前範圍下啟用的關卡與產出定義（依流程順序）。 */
  gates: readonly GateDef[];
  artifacts: readonly ArtifactDef[];
  progress: WorkItemProgress | undefined;
  consecutiveFailCount: number;
  files: readonly FileFact[];
  dupReport: string | undefined;
  /** 正式交付物與內部過程檔路徑（有給才列出分組清單）。 */
  deliverablePaths?: readonly string[];
  internalPaths?: readonly string[];
  /** 工作項目目錄與專案目錄根殘留的 *.stackdump（Bash 當機遺留，有才列出警告節）。 */
  stackdumpPaths?: readonly string[];
}

export const GATE_LABELS: Readonly<Record<string, string>> = {
  "impact-content": "影響分析內容檢查",
  "tech-confirm": "技術確認",
  "mockup-confirm": "mockup 確認",
  "sa-content-check": "SA 內容檢查",
  "sa-confirm": "SA 確認",
  "db-flow-confirm": "DB 與流程圖確認",
  "sd-confirm": "SD 確認",
  "spec-check-verdict": "規格驗證判定",
  "implementation-content": "實作內容檢查",
  verdict: "驗證判定",
  "test-evidence": "測試證據檢查",
  "final-acceptance": "最終驗收",
};

const BASELINE_TEXT: Readonly<Record<string, string>> = { brownfield: "既有系統", greenfield: "全新系統" };
const SCOPE_TEXT: Readonly<Record<string, string>> = { frontend: "只有前端", backend: "只有後端", both: "前後端都有" };

export const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
export const gateLabel = (id: string): string => `${GATE_LABELS[id] ?? id}（${id}）`;

/** 時間一律轉成台灣時間（UTC+8）並固定格式，避免受執行環境時區影響。 */
export function formatTime(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return NO_RECORD;
  return `${new Date(t + TAIWAN_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ")}（台灣時間）`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} 位元組`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const decisionText = (d: GateRecord["decision"]): string => (d === "rejected" || d === "failed" ? "退回" : d === "confirmed" ? "確認" : "通過");
export const deciderText = (r: GateRecord): string => (r.by === "human" ? "使用者本人" : (r.reason ?? "").startsWith("程式檢查") ? "程式檢查" : "AI 審查");

function summarizeRequirement(text: string | undefined): string {
  const t = oneLine(text ?? "");
  if (!t) return NO_RECORD;
  return t.length > REQUIREMENT_LIMIT ? `${t.slice(0, REQUIREMENT_LIMIT)}…（已截斷，全文見 item.md）` : t;
}

function sourceText(value: string | undefined, labels: Readonly<Record<string, string>>): string {
  return value && labels[value] ? `${labels[value]}（${value}）` : NO_RECORD;
}

function basicSection(i: FinalSummaryInput, completedAt: string | undefined): string[] {
  const yesNo = i.hasDb === undefined ? NO_RECORD : i.hasDb ? "是" : "否";
  return [
    "## 一、基本資料",
    "",
    `- 工作項目編號：${i.workItemId}`,
    `- 標題：${i.title ? oneLine(i.title) : NO_RECORD}`,
    `- 需求原文摘要：${summarizeRequirement(i.requirement)}`,
    `- 既有或全新：${(i.baseline && BASELINE_TEXT[i.baseline]) || NO_RECORD}`,
    `- 範圍：${(i.scope && SCOPE_TEXT[i.scope]) || NO_RECORD}`,
    `- 是否動資料庫：${yesNo}`,
    `- 畫面風格來源：${sourceText(i.styleSource, STYLE_SOURCE_LABELS)}`,
    `- 技術來源：${sourceText(i.techSource, TECH_SOURCE_LABELS)}`,
    `- 建立時間：${formatTime(i.createdAt)}`,
    `- 完成時間（最終驗收確認）：${formatTime(completedAt)}`,
    "",
  ];
}

function timelineLine(g: GateDef, r: GateRecord | undefined, n: number): string {
  if (!r) return `${n}. ${gateLabel(g.id)}：${NO_RECORD}`;
  const reasonLabel = r.by === "human" ? "使用者原話" : "理由";
  const parts = [decisionText(r.decision), deciderText(r), formatTime(r.at)];
  if (r.reason) parts.push(`${reasonLabel}：${oneLine(r.reason)}`);
  if (r.rootCause) parts.push(`原因：${oneLine(r.rootCause)}`);
  return `${n}. ${gateLabel(g.id)}：${parts.join("｜")}`;
}

function timelineSection(i: FinalSummaryInput): string[] {
  const gates = i.progress?.gates ?? {};
  return ["## 二、關卡時間線（每道關卡最後一次的決定）", "", ...i.gates.map((g, n) => timelineLine(g, gates[g.id], n + 1)), ""];
}

function rejectionLines(i: FinalSummaryInput): string[] {
  const gates = i.progress?.gates ?? {};
  return i.gates.flatMap((g) => {
    const r = gates[g.id];
    if (!r || (r.decision !== "rejected" && r.decision !== "failed")) return [];
    const route = r.rootCause && g.routeOnFail ? g.routeOnFail[r.rootCause] : undefined;
    const back = route ? `退回到角色「${route}」` : "退回關卡所屬的角色重做";
    return [`- ${gateLabel(g.id)}：${decisionText(r.decision)}（${deciderText(r)}、${formatTime(r.at)}）｜原因：${r.rootCause ? oneLine(r.rootCause) : NO_RECORD}｜${back}`];
  });
}

function hardStopSection(i: FinalSummaryInput): string[] {
  const failCount = Number.isFinite(i.consecutiveFailCount) ? i.consecutiveFailCount : 0;
  const rejected = rejectionLines(i);
  const hit = failCount >= HARD_STOP_FAIL_COUNT;
  return [
    "## 三、硬停點與退回紀錄",
    "",
    `- 目前連續失敗次數：${failCount}（判定通過後會歸零，歷次累計沒有另外記錄）`,
    `- 是否碰到硬停點：${hit ? `有，連續失敗達 ${HARD_STOP_FAIL_COUNT} 次，後續確認必須由使用者本人處理` : NO_RECORD}`,
    "- 退回紀錄（只保留各關卡最後一次決定，已被後來通過的決定取代的退回不會留下）：" + (rejected.length === 0 ? NO_RECORD : ""),
    ...rejected,
    "",
  ];
}

function artifactLine(f: FileFact | undefined, label: string): string {
  if (!f || !f.exists) return `- ${label}：不存在`;
  return f.isDir ? `- ${label}：存在，共 ${f.fileCount} 個檔案，${formatSize(f.size)}` : `- ${label}：存在，${formatSize(f.size)}`;
}

export function artifactPaths(artifacts: readonly ArtifactDef[]): string[] {
  return [...new Set(artifacts.flatMap((a) => [a.file, ...(a.attachments ?? []), ...(a.render ? [a.render] : [])]))];
}

function groupLines(title: string, paths: readonly string[] | undefined, by: ReadonlyMap<string, FileFact>): string[] {
  if (!paths) return [];
  return [`### ${title}`, "", ...paths.map((p) => `- ${p}：${by.get(p)?.exists ? "存在" : "不存在"}`), ""];
}

function countLine(label: string, f: FileFact | undefined, unit: string): string {
  return `- ${label}：${f?.exists ? `${f.fileCount} ${unit}` : f ? `0 ${unit}` : NO_RECORD}`;
}

function artifactSection(i: FinalSummaryInput): string[] {
  const by = new Map(i.files.map((f) => [f.path, f]));
  const flowPng = by.get("flow.png");
  return [
    "## 四、產出物清單",
    "",
    ...artifactPaths(i.artifacts).map((p) => artifactLine(by.get(p), p)),
    countLine("sa-images 張數", by.get("sa-images/"), "張"),
    countLine("evidence 張數", by.get("evidence/"), "張"),
    `- flow.png：${flowPng ? (flowPng.exists ? "存在" : "不存在") : NO_RECORD}`,
    "",
    ...groupLines("正式交付物（交給客戶／使用者）", i.deliverablePaths, by),
    ...groupLines("內部過程檔（不交付）", i.internalPaths, by),
  ];
}

function dupCount(text: string, label: string): string {
  const m = new RegExp(`${label}：(\\d+) 筆`).exec(text);
  return m ? `${m[1]} 筆` : "無法判讀";
}

function dupSection(report: string | undefined): string[] {
  if (report === undefined) return [];
  return ["## 五、重複程式碼偵測", "", `- 未豁免的重複區塊：${dupCount(report, "未豁免的重複區塊")}`, `- 已豁免的重複區塊：${dupCount(report, "已豁免的重複區塊")}`, "- 詳細內容見同目錄的 dup-report.md", ""];
}

function stackdumpSection(paths: readonly string[] | undefined): string[] {
  if (!paths || paths.length === 0) return [];
  return ["## 六、殘留的 stackdump 檔（警告）", "", "以下是 Bash 當機遺留的 *.stackdump，不是交付物，請確認後刪除，並留意當時的指令是否真的執行完成：", "", ...paths.map((p) => `- ${p}`), ""];
}

/** 完整報告字串。第五節只有工作項目目錄內有 dup-report.md 才會出現。 */
export function buildFinalSummary(i: FinalSummaryInput): string {
  const completedAt = i.progress?.gates["final-acceptance"]?.at;
  return [
    `# 最終驗收整理報告：${i.title ? oneLine(i.title) : i.workItemId}`,
    "",
    ...basicSection(i, completedAt),
    ...timelineSection(i),
    ...hardStopSection(i),
    ...artifactSection(i),
    ...dupSection(i.dupReport),
    ...stackdumpSection(i.stackdumpPaths),
    "---",
    "",
    "這份報告由程式依紀錄彙整，不含 AI 的主觀評論。",
    "",
  ].join("\n");
}

/** 給 confirm 回傳用的一行簡短摘要。 */
export function buildFinalSummaryBrief(i: FinalSummaryInput): string {
  const recorded = i.gates.filter((g) => i.progress?.gates[g.id]).length;
  const paths = artifactPaths(i.artifacts);
  const present = paths.filter((p) => i.files.some((f) => f.path === p && f.exists)).length;
  return `共 ${i.gates.length} 道關卡、${recorded} 道有紀錄；連續失敗 ${Number.isFinite(i.consecutiveFailCount) ? i.consecutiveFailCount : 0} 次；產出物 ${paths.length} 項中 ${present} 項存在。`;
}
