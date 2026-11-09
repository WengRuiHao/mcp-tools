import type { TicketStatus } from "./pipeline-store.js";
import { isGatePassed } from "./workflow/work-item-progress.js";

/** 畫面風格來源與技術來源：預設值規則、組合驗證與鎖定判斷（純函式，不做 IO）。 */

export const STYLE_SOURCES = ["existing", "redesign", "new-guided", "new-select"] as const;
export const TECH_SOURCES = ["existing", "change", "new-guided", "new-select"] as const;
export type StyleSource = (typeof STYLE_SOURCES)[number];
export type TechSource = (typeof TECH_SOURCES)[number];

export const STYLE_SOURCE_LABELS: Readonly<Record<StyleSource, string>> = { existing: "沿用現有", redesign: "換新", "new-guided": "全新有規範", "new-select": "全新待選" };
export const TECH_SOURCE_LABELS: Readonly<Record<TechSource, string>> = { existing: "沿用現有", change: "換技術", "new-guided": "全新有規範", "new-select": "全新待選" };

export const MOCKUP_CONFIRM_GATE = "mockup-confirm";
export const TECH_CONFIRM_GATE = "tech-confirm";
const MOCKUP_ROLE = "mockup-designer";
const TECH_ROLE = "tech-selector";

type Baseline = "greenfield" | "brownfield";

const STYLE_BY_BASELINE: Readonly<Record<Baseline, readonly StyleSource[]>> = { brownfield: ["existing", "redesign"], greenfield: ["new-guided", "new-select"] };
const TECH_BY_BASELINE: Readonly<Record<Baseline, readonly TechSource[]>> = { brownfield: ["existing", "change"], greenfield: ["new-guided", "new-select"] };
const BASELINE_TEXT: Readonly<Record<Baseline, string>> = { brownfield: "既有系統", greenfield: "全新系統" };

export interface SourceDefaultsInput {
  baseline: Baseline;
  /** 是否翻新案（預設 false）；只有既有系統有意義。 */
  renewal?: boolean;
  styleSource?: string;
  techSource?: string;
  /** 專案設定檔（flow.json）有 styleGuide／techGuide。 */
  hasStyleGuide?: boolean;
  hasTechGuide?: boolean;
}

export interface ResolvedSources {
  styleSource: StyleSource;
  techSource: TechSource;
}

const listLabels = <T extends string>(items: readonly T[], labels: Readonly<Record<T, string>>): string => items.map((i) => `${i}（${labels[i]}）`).join("、");

/** 驗證單一來源值與系統類型的組合；不合法時丟出清楚的錯誤。 */
export function assertSourceFits(kind: "style" | "tech", value: string | undefined, baseline: Baseline): void {
  if (value === undefined) return;
  const all: readonly string[] = kind === "style" ? STYLE_SOURCES : TECH_SOURCES;
  const field = kind === "style" ? "styleSource" : "techSource";
  if (!all.includes(value)) throw new Error(`${field} 只接受 ${all.join("／")}：${value}`);
  const allowed: readonly string[] = (kind === "style" ? STYLE_BY_BASELINE : TECH_BY_BASELINE)[baseline];
  if (allowed.includes(value)) return;
  const labels = (kind === "style" ? STYLE_SOURCE_LABELS : TECH_SOURCE_LABELS) as Readonly<Record<string, string>>;
  const opts = allowed.map((a) => `${a}（${labels[a]}）`).join("、");
  throw new Error(`${BASELINE_TEXT[baseline]}不可選 ${field}=${value}（${labels[value]}）；${BASELINE_TEXT[baseline]}可選：${opts}。`);
}

/**
 * 建立時決定兩個來源：
 * - 有明確給就驗證組合（既有系統只能 existing／換新或換技術；全新系統只能全新有規範／待選）。
 * - 沒給：既有且非翻新 → existing；既有且翻新 → 不替使用者猜，缺的一律回錯誤要求明確選；全新 → 有專案規範就 new-guided，沒有就 new-select。
 */
export function resolveSources(input: SourceDefaultsInput): ResolvedSources {
  const { baseline, styleSource, techSource } = input;
  const renewal = input.renewal === true;
  if (renewal && baseline === "greenfield") throw new Error("renewal=true 只適用既有系統（brownfield）；全新系統不是翻新案，請移除 renewal。");
  assertSourceFits("style", styleSource, baseline);
  assertSourceFits("tech", techSource, baseline);
  if (baseline === "greenfield") {
    return {
      styleSource: (styleSource as StyleSource | undefined) ?? (input.hasStyleGuide ? "new-guided" : "new-select"),
      techSource: (techSource as TechSource | undefined) ?? (input.hasTechGuide ? "new-guided" : "new-select"),
    };
  }
  if (renewal && (styleSource === undefined || techSource === undefined)) {
    const missing = [
      ...(styleSource === undefined ? [`styleSource：${listLabels(STYLE_BY_BASELINE.brownfield, STYLE_SOURCE_LABELS)}`] : []),
      ...(techSource === undefined ? [`techSource：${listLabels(TECH_BY_BASELINE.brownfield, TECH_SOURCE_LABELS)}`] : []),
    ];
    throw new Error(`這是翻新案（renewal=true），系統不替你猜畫面風格或技術，請先問使用者再明確指定。缺少：${missing.join("；")}。`);
  }
  return { styleSource: (styleSource as StyleSource | undefined) ?? "existing", techSource: (techSource as TechSource | undefined) ?? "existing" };
}

const roleDone = (s: Pick<TicketStatus, "work_item_progress">, id: string): boolean => s.work_item_progress?.roles[id]?.done === true;

/** 畫面風格來源是否已鎖定：mockup 確認已通過之後不可改。 */
export const isStyleSourceLocked = (s: Pick<TicketStatus, "work_item_progress">): boolean => isGatePassed(s.work_item_progress, MOCKUP_CONFIRM_GATE);
/** 技術來源是否已鎖定：技術確認已通過（含沿用現有時程式自動記錄）之後不可改。 */
export const isTechSourceLocked = (s: Pick<TicketStatus, "work_item_progress">): boolean => isGatePassed(s.work_item_progress, TECH_CONFIRM_GATE);

export interface SourcePatch {
  styleSource?: string;
  techSource?: string;
}

/** 套用來源修改：驗證組合與鎖定；已交件但尚未確認時要求先打回（否則已寫的內容與新來源不一致）。回傳要寫回的欄位。 */
export function applySourcePatch(status: TicketStatus, patch: SourcePatch): Pick<TicketStatus, "style_source" | "tech_source"> {
  const baseline = status.baseline ?? "brownfield";
  assertSourceFits("style", patch.styleSource, baseline);
  assertSourceFits("tech", patch.techSource, baseline);
  if (patch.styleSource !== undefined && patch.styleSource !== status.style_source) {
    if (isStyleSourceLocked(status)) throw new Error("mockup 已確認，畫面風格來源已鎖定，不可再修改");
    if (roleDone(status, MOCKUP_ROLE)) throw new Error(`mockup 設計師已交件，要改畫面風格來源請先用 confirm（gateId="${MOCKUP_CONFIRM_GATE}"、decision="rejected"）打回 mockup 再改。`);
  }
  if (patch.techSource !== undefined && patch.techSource !== status.tech_source) {
    if (isTechSourceLocked(status)) throw new Error("技術確認已通過，技術來源已鎖定，不可再修改");
    if (roleDone(status, TECH_ROLE)) throw new Error(`技術選型師已交件，要改技術來源請先用 confirm（gateId="${TECH_CONFIRM_GATE}"、decision="rejected"）打回技術選型再改。`);
  }
  return {
    ...(patch.styleSource !== undefined ? { style_source: patch.styleSource as StyleSource } : {}),
    ...(patch.techSource !== undefined ? { tech_source: patch.techSource as TechSource } : {}),
  };
}
