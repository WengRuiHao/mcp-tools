/**
 * PENDING_HUMAN_ACTIONS.html 的「SVN 變更」區塊背後的資料與操作。
 *
 * 實際的 svn 指令全部在 svn-mcp 的 `dist/workcopy-client.js`（帳密也只在 svn-mcp 那邊解析）；這裡用動態
 * import 載入那個模組——它**沒有**被註冊成任何 MCP 工具，所以 AI 這邊拿不到任何能修改 SVN 的工具，
 * 只有 HTTP bridge（使用者在網頁上按按鈕）這條路徑呼叫得到。
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSvnMcpEntrypoint, getSvnOperationLogFile } from "./config-store.js";
import { resolveSvnWorkCopies, type SvnWorkCopyEntry } from "./svn-workcopy-store.js";

export interface WcEntry {
  path: string;
  status: string;
  propsModified: boolean;
  treeConflict: boolean;
  copied: boolean;
  remoteStatus: string | null;
}

interface WorkCopyClient {
  wcStatus(opts: { workCopyPath: string; connectionId?: string }, options?: { checkRemote?: boolean }): Promise<{ remoteUrl: string; entries: WcEntry[] }>;
  wcDiff(opts: { workCopyPath: string; connectionId?: string }, relPath: string): Promise<unknown>;
  wcAddAndCommit(opts: { workCopyPath: string; connectionId?: string }, relPaths: string[], message: string): Promise<unknown>;
  wcUpdate(opts: { workCopyPath: string; connectionId?: string }): Promise<unknown>;
  wcDelete(opts: { workCopyPath: string; connectionId?: string }, relPaths: string[]): Promise<unknown>;
  wcRevert(opts: { workCopyPath: string; connectionId?: string }, relPath: string): Promise<unknown>;
  wcCleanup(opts: { workCopyPath: string; connectionId?: string }): Promise<unknown>;
}

let clientPromise: Promise<WorkCopyClient> | null = null;

/** 載入 svn-mcp 的工作副本模組（路徑跟著 SVN_MCP_PATH／預設的 svn-mcp 安裝位置走）；載入失敗不快取，下次可重試。 */
export function loadWorkCopyClient(): Promise<WorkCopyClient> {
  if (!clientPromise) {
    const modulePath = path.join(path.dirname(getSvnMcpEntrypoint()), "workcopy-client.js");
    clientPromise = import(pathToFileURL(modulePath).href).then(
      (mod) => mod as WorkCopyClient,
      (err) => {
        clientPromise = null;
        throw new Error(`載入 svn-mcp 的工作副本模組失敗（${modulePath}）：${err?.message ?? err}。請確認 svn-mcp 已 build（npm run build）。`);
      }
    );
  }
  return clientPromise;
}

export interface SvnWorkCopySummary {
  label: string;
  workCopyPath: string;
  remoteUrl?: string;
  entries: WcEntry[];
  error?: string;
}

export interface SvnReportData {
  /** false＝這個專案目錄還沒登記過任何 SVN 工作副本。 */
  registered: boolean;
  workCopies: SvnWorkCopySummary[];
}

/** 報告每次重建都會查一次（純本機 `svn status`，不連遠端）；單一工作副本最多等這麼久，避免卡住整份報告。 */
const REPORT_STATUS_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function summarizeOne(entry: SvnWorkCopyEntry): Promise<SvnWorkCopySummary> {
  try {
    const client = await loadWorkCopyClient();
    const status = await withTimeout(
      client.wcStatus({ workCopyPath: entry.workCopyPath, connectionId: entry.connectionId }),
      REPORT_STATUS_TIMEOUT_MS,
      `檢查狀態逾時（超過 ${REPORT_STATUS_TIMEOUT_MS / 1000} 秒），可以按「重新整理狀態」再試一次`
    );
    return { label: entry.label, workCopyPath: entry.workCopyPath, remoteUrl: status.remoteUrl, entries: status.entries };
  } catch (err: any) {
    return { label: entry.label, workCopyPath: entry.workCopyPath, entries: [], error: err?.message ?? String(err) };
  }
}

export async function getSvnReportData(projectDir: string): Promise<SvnReportData> {
  const registered = await resolveSvnWorkCopies(projectDir);
  if (!registered || registered.length === 0) return { registered: false, workCopies: [] };
  return { registered: true, workCopies: await Promise.all(registered.map(summarizeOne)) };
}

export type SvnOperation = "status" | "diff" | "commit" | "update" | "delete" | "revert" | "cleanup";

export interface SvnOperationRequest {
  projectDir: string;
  label: string;
  op: SvnOperation;
  files?: string[];
  message?: string;
}

async function writeAuditLog(record: Record<string, unknown>): Promise<void> {
  try {
    const file = getSvnOperationLogFile();
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf-8");
  } catch (err: any) {
    console.error(`[dev-pipeline-mcp] writeAuditLog failed: ${err?.message ?? err}`);
  }
}

/**
 * 網頁按鈕觸發的 SVN 操作。操作對象只能是「這個 projectDir 已登記過的工作副本（用 label 指定）」——
 * 工作副本路徑、連線一律從登記資料取，不接受呼叫端傳入，所以網頁送什麼都動不到沒登記的目錄。
 * 每次操作（成功或失敗）都寫一行稽核紀錄；commit message 只記長度與前 80 字。
 */
export async function performSvnOperation(req: SvnOperationRequest): Promise<unknown> {
  const registered = await resolveSvnWorkCopies(req.projectDir);
  const target = registered?.find((e) => e.label === req.label);
  if (!target) throw new Error(`這個專案沒有登記過名為「${req.label}」的 SVN 工作副本`);
  const opts = { workCopyPath: target.workCopyPath, connectionId: target.connectionId };
  const files = Array.isArray(req.files) ? req.files : [];
  const audit = { op: req.op, label: req.label, workCopyPath: target.workCopyPath, files: files.slice(0, 20), fileCount: files.length };

  try {
    const client = await loadWorkCopyClient();
    let result: unknown;
    switch (req.op) {
      case "status":
        result = await client.wcStatus(opts);
        break;
      case "diff":
        if (files.length !== 1) throw new Error("diff 一次只能看一個檔案");
        result = await client.wcDiff(opts, files[0]);
        break;
      case "commit":
        result = await client.wcAddAndCommit(opts, files, req.message ?? "");
        break;
      case "update":
        result = await client.wcUpdate(opts);
        break;
      case "delete":
        result = await client.wcDelete(opts, files);
        break;
      case "revert":
        if (files.length !== 1) throw new Error("revert 一次只能還原一個項目");
        result = await client.wcRevert(opts, files[0]);
        break;
      case "cleanup":
        result = await client.wcCleanup(opts);
        break;
      default:
        throw new Error(`不支援的操作：${String(req.op)}`);
    }
    if (req.op !== "status" && req.op !== "diff") {
      await writeAuditLog({ ...audit, ok: true, messagePreview: req.message?.slice(0, 80), messageLength: req.message?.length, result });
    }
    return result;
  } catch (err: any) {
    if (req.op !== "status" && req.op !== "diff") {
      await writeAuditLog({ ...audit, ok: false, messagePreview: req.message?.slice(0, 80), messageLength: req.message?.length, error: err?.message ?? String(err) });
    }
    throw err;
  }
}
