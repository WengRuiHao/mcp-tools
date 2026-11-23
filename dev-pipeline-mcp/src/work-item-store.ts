import path from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { getTicketsIndexFile } from "./config-store.js";
import { updateJsonFile, writeJsonFileAtomic } from "./atomic-store.js";
import { createInitialStatus, updateStatus, type TicketStatus } from "./pipeline-store.js";
import { buildWorkflowSnapshot, getBuiltinWorkflow, getStageOrder } from "./workflow/stage-order.js";
import type { WhenContext } from "./workflow/validate.js";
import { applySourcePatch, resolveSources, type SourcePatch } from "./work-item-sources.js";

/** 手動來源（work item）的資料層：編號、目錄、狀態檔與範圍鎖定。不含任何 MCP 工具。 */

export type WorkItemBaseline = "greenfield" | "brownfield";
export type WorkItemScope = "frontend" | "backend" | "both";

export interface CreateWorkItemInput {
  projectDir: string;
  title: string;
  requirement: string;
  baseline: WorkItemBaseline;
  scope: WorkItemScope;
  hasDb: boolean;
  /** 高併發／高風險需求（選填，預設 false）；只在 true 時寫入狀態檔。 */
  highRisk?: boolean;
  workflow: "spec-first";
  /** 畫面風格來源與技術來源（選填）；沒給時依 resolveSources 的預設值規則決定。 */
  styleSource?: string;
  techSource?: string;
  /** 是否翻新案（預設 false）；只對既有系統有意義。 */
  renewal?: boolean;
  /** 專案設定檔（flow.json）有 styleGuide／techGuide，由呼叫端查好傳入（全新系統的預設值依此決定）。 */
  hasStyleGuide?: boolean;
  hasTechGuide?: boolean;
}

export interface CreatedWorkItem {
  id: string;
  dir: string;
  styleSource: string;
  techSource: string;
}

const BASELINES: readonly string[] = ["greenfield", "brownfield"];
const SCOPES: readonly string[] = ["frontend", "backend", "both"];
const SUPPORTED_WORKFLOWS: readonly string[] = ["spec-first"];
const TITLE_MAX_LEN = 40;
const WORK_ITEMS_DIR = path.join(".dev-pipeline", "work-items");
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** 決定 SA 是否已確認所依據的角色：該角色之後的階段代表 sa-confirm 已通過。 */
const SA_ROLE_ID = "sa-analyst";
const SA_CONFIRM_LOCKED_MESSAGE = "SA 已確認，範圍與 DB 設定已鎖定，不可再修改";

/** 標題淨化成合法目錄名：換掉 Windows 非法字元與控制字元、空白轉底線、限長、避開保留字與結尾句點。 */
export function sanitizeWorkItemTitle(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, TITLE_MAX_LEN)
    .replace(/[._]+$/, "");
  if (!cleaned) return "untitled";
  return WINDOWS_RESERVED.test(cleaned) ? `${cleaned}_` : cleaned;
}

function localDateStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/** 在索引中找出該日最大流水號並加 1（只看 wi-YYYYMMDD-NNN 格式的 key）。 */
function nextSerial(index: Record<string, string>, stamp: string): number {
  const re = new RegExp(`^wi-${stamp}-([0-9]+)$`);
  let max = 0;
  for (const key of Object.keys(index)) {
    const m = re.exec(key);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

async function assertDirectoryExists(dir: string): Promise<void> {
  try {
    if ((await stat(dir)).isDirectory()) return;
  } catch {
    /* 落到下方統一錯誤 */
  }
  throw new Error(`projectDir 不存在或不是資料夾：${dir}`);
}

function validateInput(input: CreateWorkItemInput): void {
  if (!input.title?.trim()) throw new Error("title 不可空白");
  if (!input.requirement?.trim()) throw new Error("requirement（需求原文）不可空白");
  if (!BASELINES.includes(input.baseline)) throw new Error(`baseline 只接受 greenfield／brownfield：${input.baseline}`);
  if (!SCOPES.includes(input.scope)) throw new Error(`scope 只接受 frontend／backend／both：${input.scope}`);
  if (typeof input.hasDb !== "boolean") throw new Error("hasDb 必須是布林值");
  if (input.highRisk !== undefined && typeof input.highRisk !== "boolean") throw new Error("highRisk 必須是布林值");
  if (!SUPPORTED_WORKFLOWS.includes(input.workflow)) throw new Error(`目前只支援 workflow：${SUPPORTED_WORKFLOWS.join("、")}（收到 ${input.workflow}）`);
}

/**
 * 建立手動來源工作項目：加鎖讀共用索引檔、取當天最大流水號加 1，建立目錄與 item.md／status.json／三個資料夾，
 * 最後才把 `編號 → 目錄絕對路徑` 登記進索引（沿用既有「taskGid → 目錄」格式，不動既有條目）。
 * 目錄建立失敗時不會留下索引條目。
 */
export async function createWorkItem(input: CreateWorkItemInput): Promise<CreatedWorkItem> {
  validateInput(input);
  const projectDir = path.resolve(input.projectDir);
  await assertDirectoryExists(projectDir);
  const sources = resolveSources(input);
  const definition = getBuiltinWorkflow(input.workflow);
  if (!definition) throw new Error(`找不到 workflow「${input.workflow}」的內建定義`);
  const snapshot = buildWorkflowSnapshot(definition);
  const title = input.title.trim();
  const stamp = localDateStamp(new Date());
  let created: CreatedWorkItem | null = null;

  await updateJsonFile<Record<string, string>>(getTicketsIndexFile(), {}, async (index) => {
    const id = `wi-${stamp}-${String(nextSerial(index, stamp)).padStart(3, "0")}`;
    if (index[id]) throw new Error(`編號 ${id} 已存在於索引，拒絕建立`);
    const dir = path.join(projectDir, WORK_ITEMS_DIR, `${id}_${sanitizeWorkItemTitle(title)}`);
    await mkdir(dir, { recursive: true });
    await Promise.all(["sa-mockup", "sa-images", "evidence"].map((sub) => mkdir(path.join(dir, sub), { recursive: true })));
    await writeFile(path.join(dir, "item.md"), input.requirement, "utf-8");
    const status = createInitialStatus({
      workflow_id: input.workflow,
      project_dir: projectDir,
      name: title,
      baseline: input.baseline,
      scope: input.scope,
      has_db: input.hasDb,
      ...(input.highRisk === true ? { high_risk: true } : {}),
      style_source: sources.styleSource,
      tech_source: sources.techSource,
      workflow_snapshot: snapshot,
    });
    await writeJsonFileAtomic(path.join(dir, "status.json"), status);
    created = { id, dir, styleSource: sources.styleSource, techSource: sources.techSource };
    return { ...index, [id]: dir };
  });

  if (!created) throw new Error("建立工作項目失敗：索引未更新");
  return created;
}

/** SA 是否已確認：優先看逐關卡紀錄 sa-confirm；沒有紀錄時沿用近似判斷（規格確認紀錄為 confirmed，或階段已走過 SA 分析師之後）。 */
export function isSaConfirmed(status: TicketStatus): boolean {
  const gate = status.work_item_progress?.gates["sa-confirm"];
  if (gate && (gate.decision === "confirmed" || gate.decision === "passed")) return true;
  if (status.spec_confirmation?.confirmed === true) return true;
  const order = getStageOrder(status.workflow_id, undefined, status.workflow_snapshot);
  const saAt = order.indexOf(SA_ROLE_ID);
  return saAt >= 0 && order.indexOf(status.stage) > saAt;
}

/**
 * 開關高風險的前置檢查：快照要有對應的架構角色（舊工作項目沒有就不能開）；該架構角色與依賴它的角色（SA、DB、SD）都還沒完成，
 * 否則架構會變成事後補的（例如全新系統的 arch-pre 必須在 SA 之前）。狀態沒變就不檢查。
 */
function assertHighRiskChangeAllowed(id: string, status: TicketStatus, next: boolean): void {
  if ((status.high_risk === true) === next) return;
  const roles = status.workflow_snapshot?.roles ?? [];
  const archId = (status.baseline ?? "brownfield") === "greenfield" ? "arch-pre" : "arch-post";
  if (!roles.some((r) => r.id === archId)) {
    if (next) throw new Error(`${id} 建立時的流程不含架構角色，不能改成高風險；請建立新的工作項目並在建立時就開 highRisk`);
    return;
  }
  const involved = [archId, ...roles.filter((r) => r.dependsOn.includes(archId)).map((r) => r.id)];
  const done = involved.find((r) => status.work_item_progress?.roles[r]?.done === true);
  if (done) throw new Error(`${done} 已完成，不能再改高風險設定（架構角色必須排在它之前）；要改請先打回 ${done}`);
}

/** 修改範圍、DB 設定與兩個來源。scope／hasDb 在 SA 確認後鎖定；styleSource 在 mockup 確認後鎖定；techSource 在技術確認後鎖定。任一欄位被拒絕就全部不寫入。 */
export async function updateWorkItemScope(id: string, patch: { scope?: WorkItemScope; hasDb?: boolean; highRisk?: boolean } & SourcePatch): Promise<TicketStatus> {
  if (patch.scope === undefined && patch.hasDb === undefined && patch.highRisk === undefined && patch.styleSource === undefined && patch.techSource === undefined) {
    throw new Error("scope、hasDb、highRisk、styleSource、techSource 至少要給一個");
  }
  if (patch.scope !== undefined && !SCOPES.includes(patch.scope)) throw new Error(`scope 只接受 frontend／backend／both：${patch.scope}`);
  if (patch.hasDb !== undefined && typeof patch.hasDb !== "boolean") throw new Error("hasDb 必須是布林值");
  if (patch.highRisk !== undefined && typeof patch.highRisk !== "boolean") throw new Error("highRisk 必須是布林值");
  return updateStatus(id, (status) => {
    if (!status.workflow_snapshot) throw new Error(`${id} 不是手動來源工作項目，不能修改範圍`);
    if ((patch.scope !== undefined || patch.hasDb !== undefined || patch.highRisk !== undefined) && isSaConfirmed(status)) throw new Error(SA_CONFIRM_LOCKED_MESSAGE);
    if (patch.highRisk !== undefined) assertHighRiskChangeAllowed(id, status, patch.highRisk);
    const sources = applySourcePatch(status, patch);
    // 關掉 highRisk 時整個 key 拿掉（不留 false），讓狀態檔回到沒開過的樣子
    const { high_risk: previousHighRisk, ...rest } = status;
    const highRisk = patch.highRisk === undefined ? previousHighRisk : patch.highRisk;
    return {
      ...rest,
      ...(highRisk === true ? { high_risk: true } : {}),
      ...sources,
      ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
      ...(patch.hasDb !== undefined ? { has_db: patch.hasDb } : {}),
    };
  });
}

/** 把狀態轉成 resolveWorkflow 用的 when context；值一律是字串 "true"／"false"。缺欄位時視為既有系統、前後端皆做、無 DB。 */
export function buildWhenContext(status: Pick<TicketStatus, "baseline" | "scope" | "has_db" | "high_risk">): WhenContext {
  const scope = status.scope ?? "both";
  return {
    baseline: status.baseline ?? "brownfield",
    hasFrontend: String(scope !== "backend"),
    hasBackend: String(scope !== "frontend"),
    hasDb: String(status.has_db === true),
    highRisk: String(status.high_risk === true),
  };
}
