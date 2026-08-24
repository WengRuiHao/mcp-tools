import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getTicketsIndexFile } from "./config-store.js";
import { readJsonFile, updateJsonFile, withFileLock, writeJsonFileAtomic } from "./atomic-store.js";

export interface TicketSummaries {
  analysis: string | null;
  implementation: string | null;
  verification: string | null;
}

/**
 * 結案前「使用者自己」的實測＋程式碼品質審視結果紀錄。
 * 跟 verdict（AI 驗證師自己判定的 PASS/FAIL）是不同軸向的東西，不能混為一談。
 */
export interface ConfirmationRecord {
  /** true：這一關通過。false：這一關發現問題，需要人工決定下一步（是否重開工程師階段）。 */
  confirmed: boolean;
  confirmedAt: string;
  note: string | null;
}

export interface TicketSyncState {
  /** 01-analysis.md 目前內容的雜湊。每次 write_ticket_artifact 寫 01 時更新。 */
  analysis_hash: string | null;
  /** 02-implementation.md 目前內容的雜湊。每次 write_ticket_artifact 寫 02 時更新。 */
  implementation_hash: string | null;
  /** 03-verification.md 目前內容的雜湊。每次 write_ticket_artifact 寫 03 時更新。 */
  verification_hash: string | null;
  /** 上次寫 02 時，01 的雜湊是多少（快照）——跟 analysis_hash 不一致代表 01 在那之後又被獨立改過，02 還沒對照過最新的 01。 */
  analysis_hash_at_impl_write: string | null;
  /** 上次寫 03 時，02 的雜湊是多少（快照）——跟 implementation_hash 不一致代表 02 在那之後又被獨立改過，03 還沒對照過最新的 02。 */
  implementation_hash_at_verify_write: string | null;
}

export interface TicketStatus {
  stage: "new" | "snapshot" | "project_dir_confirmed" | "analyzed" | "implemented" | "verified";
  project_dir: string | null;
  /** 這張票所屬的 Asana 專案「全名稱」（未消毒過的原始字串）。get_ticket_snapshot 時自動記錄，供任何單張票的狀態異動事後局部重建 PENDING_HUMAN_ACTIONS.md 用（見 syncPendingActionsReport/listTicketsUnderProject），不需要呼叫端每次額外傳遞或記得重新呼叫 list_pending_tickets。 */
  project_name: string | null;
  /** 這張票在 Asana 上的顯示名稱（task.name）。get_ticket_snapshot 時自動記錄，同上用途——讓局部重建 PENDING_HUMAN_ACTIONS.md 不需要重新查 Asana 就能顯示票名。 */
  name: string | null;
  /** 上次抓取時 Asana 這張票的指派人 gid（task.assignee?.gid），沒有指派人是 null。get_ticket_snapshot 時自動記錄。用途：判斷「Asana 內容已被異動，待重新確認」這個提醒該不該冒出來——只有指派人剛好是這個 pipeline 帳號本人時，才代表有人是刻意指派這張票要（重新）處理，用來過濾掉「內容雖然變了、但根本沒指派給這個帳號」這種不需要現在關注的雜訊。 */
  last_seen_assignee_gid: string | null;
  /** 上次抓取時 Asana 這張票的 task.completed。get_ticket_snapshot 時自動記錄。用途：syncPendingActionsReport 局部重建 PENDING_HUMAN_ACTIONS.md 時，只能看本機已追蹤票單、無法像 list_pending_tickets 那樣即時查 Asana board 排除已完成的任務——這個欄位是替代方案，true 的票單會整張從局部重建結果排除，避免專案裡歷年累積、Asana 上早就標記完成的舊票單無限期在報告裡復活。預設 false（還沒被新版程式碼碰過的舊票單，要等下次 get_ticket_snapshot 才會補上真實值）。 */
  last_seen_completed: boolean;
  verdict: "PASS" | "FAIL" | null;
  sasd_checked: boolean;
  sasd_info: string | null;
  history: { stage: string; at: string }[];
  /** 上次寫入 ticket.md 時，票單「描述+留言」內容的雜湊值。用來判斷 Asana 上的票單內容是否真的變了（跟 modified_at 不同，modified_at 連指派人、到期日變動都會跳，不夠精準）。 */
  content_hash: string | null;
  /** 上次寫入 ticket.md 時 Asana 回傳的 task.modified_at，給 list_pending_tickets 做便宜的初篩用（不用整份重抓比對 hash）。 */
  last_seen_modified_at: string | null;
  /** true 代表這張票已經有 analyzed/implemented/verified 之類的既有進度，但 Asana 上的內容後來又變了，需要重新走一次分析——即使 verdict 曾經是 PASS 也一樣。分析師重新寫入 01-analysis.md 後會自動清掉。 */
  needs_reanalysis: boolean;
  /** 分析師/工程師/驗證師各自產出的精簡摘要（2-4 條重點，非全文），供接手的 session/AI 用 get_ticket_status 就能低成本掌握進度，不必每次都整份讀 01/02/03 全文。 */
  summaries: TicketSummaries;
  /** 結案前唯一一關人類確認：使用者自己的實測＋程式碼品質審視結果。null = 尚未確認（不管 verdict 是不是 PASS，都還不算真正結案）。見 recordConfirmation。 */
  confirmation: ConfirmationRecord | null;
  /** 驗證師判 FAIL 時判斷的根因：分析方向本身錯了，還是單純實作沒做到位。PASS 或還沒判定時是 null。供下一輪處理這張票時決定要自動跳回工程師還是分析師（見 advanceStage 的自動維護邏輯）。 */
  verifier_root_cause: "analysis" | "implementation" | null;
  /** 連續 FAIL 次數的機械式安全閥——不是給 AI 自己心算的東西，由 advanceStage 在 verdict 有值時自動維護：FAIL +1，PASS 歸零。達到門檻（見 needsHumanReview）時不該再自動重跑，要停下來問使用者。 */
  consecutive_fail_count: number;
  /** 工程師階段宣告的「需要使用者手動處理」事項（例如產出的 SQL 只能交由使用者到 Database 工具手動執行、後台程式代號/選單需自行設定）。write_ticket_artifact 寫 02-implementation.md 時必填（可以是空陣列，代表明確確認這次沒有）——不能讓這種一次性提醒被埋在自由文字裡、換個 session 就找不到。 */
  implementation_manual_actions: string[];
  /** 驗證師階段宣告/補充的「需要使用者手動處理」事項，語意同上，write_ticket_artifact 寫 03-verification.md 時必填。跟 implementation_manual_actions 是分開累積、不互相覆蓋——工程師交代的事項不會因為驗證師沒有重複提到就消失。 */
  verification_manual_actions: string[];
  /** 01/02/03 三份文件彼此之間是否同步（跟 content_hash/needs_reanalysis 是不同軸向：那組管「票單原文 vs 追蹤系統」，這組管「追蹤系統內部三份文件互相」）。 */
  sync: TicketSyncState;
}

/** Formats the current local time as "yyyy-MM-dd HH:mm:ss" (24-hour), used for history timestamps. */
function nowIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const STAGE_ORDER: TicketStatus["stage"][] = ["new", "snapshot", "project_dir_confirmed", "analyzed", "implemented", "verified"];

function sanitizeSegment(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, "_")
    .slice(0, 60);
  return cleaned || "unknown";
}

const CLAUDE_MD_MARKER_START = "<!-- asana-pipeline-mcp:tracking-note:start -->";
const CLAUDE_MD_MARKER_END = "<!-- asana-pipeline-mcp:tracking-note:end -->";

const CLAUDE_MD_NOTE = `${CLAUDE_MD_MARKER_START}
## Asana pipeline 追蹤紀錄

這個專案底下的 \`.asana-pipeline/\` 目錄，是 asana-pipeline-mcp 自動處理 Asana 票單時建立的追蹤紀錄，跟這個專案本身的程式碼無關，純粹是紀錄檔案。

結構：\`.asana-pipeline/<Asana 專案全名稱>/<票號>/\`（子任務會巢狀掛在父票號底下，層數不限）。每張票的目錄裡有：
- \`ticket.md\` — 從 Asana 抓下來的票單原文（描述 + 留言）
- \`01-analysis.md\` / \`02-implementation.md\` / \`03-verification.md\` — 分析師/工程師/驗證師三個階段各自的產出
- \`status.json\` — 這張票目前處理到哪個階段、驗證結果、SA/SD 規格確認狀態等

如果你是要接手維護這個專案的 AI 或工程師，想知道「某個功能之前是不是被 AI 處理過、當初怎麼分析跟修改的」，可以直接來這裡查，不用重新問使用者一次。
${CLAUDE_MD_MARKER_END}
`;

/** Ensures <projectDir>/CLAUDE.md documents what the .asana-pipeline/ folder is, so any future AI/engineer opening this project understands it at a glance. Idempotent — won't duplicate the note on repeated calls. */
async function ensureClaudeMdNote(projectDir: string): Promise<void> {
  const claudeMdPath = path.join(projectDir, "CLAUDE.md");
  let existing = "";
  try {
    existing = await readFile(claudeMdPath, "utf-8");
  } catch {
    existing = "";
  }
  if (existing.includes(CLAUDE_MD_MARKER_START)) return;
  const updated = existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${CLAUDE_MD_NOTE}` : CLAUDE_MD_NOTE;
  await writeFile(claudeMdPath, updated, "utf-8");
}

/** Returns this ticket's already-assigned tracking directory, or null if get_ticket_snapshot hasn't run for it yet. Lets callers check before deciding whether an ancestor needs to be snapshotted first. */
export async function getAssignedDir(taskGid: string): Promise<string | null> {
  const index = await readJsonFile<Record<string, string>>(getTicketsIndexFile(), {});
  return index[taskGid] ?? null;
}

/**
 * Assigns (or reuses) a human-readable tracking directory for a ticket, laid
 * out INSIDE the target code project's own directory (not this MCP's install
 * folder) as `<projectDir>/.asana-pipeline/<AsanaProjectFullName>/<ticketNumber>/`,
 * or nested under its parent's directory (`.../<parentTicketNumber>/<ticketNumber>/`)
 * when `parentTaskGid` is given — mirrors Asana's own task/subtask hierarchy, to
 * arbitrary depth. Callers are responsible for ensuring the parent's own directory
 * already exists first (see get_ticket_snapshot's ancestor-chain walk in index.ts).
 *
 * The read-check-mutate-write against tickets-index.json happens as one locked
 * transaction (via updateJsonFile) so two tickets being snapshotted back-to-back
 * can't race and drop one another's index entry.
 *
 * Ticket *content* (descriptions, analysis, code-change notes) lives entirely
 * inside the project — so sharing this MCP's own codebase/install with someone
 * else never leaks any client's ticket history. Only a lightweight lookup index
 * (taskGid -> absolute folder path) stays in this MCP's own data dir; delete
 * `data/tickets-index.json` too if you want zero trace before sharing the tool.
 */
export async function assignTicketDir(
  projectDir: string,
  taskGid: string,
  projectName: string,
  ticketNumber?: string | null,
  parentTaskGid?: string | null
): Promise<string> {
  let resultDir = "";
  await updateJsonFile<Record<string, string>>(getTicketsIndexFile(), {}, (index) => {
    const existing = index[taskGid];
    if (existing) {
      resultDir = existing;
      return index;
    }

    const leafName = sanitizeSegment(ticketNumber || taskGid);
    let dir: string;
    if (parentTaskGid) {
      const parentDir = index[parentTaskGid];
      if (!parentDir) {
        throw new Error(
          `找不到父票單 ${parentTaskGid} 的追蹤目錄——請先對父票單呼叫過 get_ticket_snapshot（建立好它的目錄），子任務才能掛在它底下。`
        );
      }
      dir = path.join(parentDir, leafName);
    } else {
      const projectRoot = path.join(projectDir, ".asana-pipeline");
      dir = path.join(projectRoot, sanitizeSegment(projectName), leafName);
    }

    resultDir = dir;
    return { ...index, [taskGid]: dir };
  });

  await mkdir(resultDir, { recursive: true });
  await ensureClaudeMdNote(projectDir);
  return resultDir;
}

/**
 * 記錄這張票所屬的 Asana 專案脈絡（project_dir/project_name）、顯示名稱、跟目前指派人 gid——
 * 供之後任何單張票的狀態異動（advance_ticket_stage/write_ticket_artifact/resolve_manual_action/
 * record_confirmation）在不知道 projectGid、不重新查 Asana 的情況下，也能局部重建這個專案的
 * PENDING_HUMAN_ACTIONS.md（見 index.ts 的 syncPendingActionsReport），不依賴呼叫端記得在每次
 * 異動後額外呼叫 list_pending_tickets 才能讓這份報告保持最新。
 * get_ticket_snapshot 每次都會呼叫（即使內容沒變），讓子任務、還沒走到 project_dir_confirmed
 * 階段的票單也能盡早補上這些欄位；project_dir 只在還沒被 advance_ticket_stage 明確設定過時才會
 * 由這裡補上預設值，不會覆蓋掉呼叫端已經明確確認過的值。
 */
export async function recordProjectContext(
  ticketGid: string,
  projectDir: string,
  projectName: string,
  name: string,
  assigneeGid: string | null,
  completed: boolean
): Promise<void> {
  await updateStatus(ticketGid, (status) => ({
    ...status,
    project_dir: status.project_dir ?? projectDir,
    project_name: projectName,
    name,
    last_seen_assignee_gid: assigneeGid,
    last_seen_completed: completed,
  }));
}

/**
 * 列出某個 Asana 專案底下，目前為止已經呼叫過 get_ticket_snapshot 的所有票單 taskGid
 * （不管是頂層票單還是巢狀子任務）。純粹比對本機 tickets-index.json 的目錄路徑前綴，不呼叫
 * Asana——這是讓單張票狀態異動後，也能低成本局部重建 PENDING_HUMAN_ACTIONS.md 的關鍵：不需要
 * 為了同步一份報告，就對 Asana 重新拉一次整個看板。
 * 代價：全新、還沒被任何一次 get_ticket_snapshot 摸過的票單不會出現在這裡——這類票單的發現仍然
 * 只能靠 list_pending_tickets 對 Asana 的完整查詢，兩者互補、不互相取代。
 */
export async function listTicketsUnderProject(projectDir: string, projectName: string): Promise<string[]> {
  const index = await readJsonFile<Record<string, string>>(getTicketsIndexFile(), {});
  const root = path.join(projectDir, ".asana-pipeline", sanitizeSegment(projectName)) + path.sep;
  return Object.entries(index)
    .filter(([, dir]) => (dir + path.sep).startsWith(root))
    .map(([taskGid]) => taskGid);
}

/** Resolves a ticket's tracking directory via the index. Throws a clear error if this ticket hasn't gone through assignTicketDir yet (get_ticket_snapshot must always be called first). */
async function resolveTicketDir(taskGid: string): Promise<string> {
  const index = await readJsonFile<Record<string, string>>(getTicketsIndexFile(), {});
  const dir = index[taskGid];
  if (!dir) {
    throw new Error(`找不到票單 ${taskGid} 的追蹤目錄，請先呼叫 get_ticket_snapshot 建立。`);
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

const NEW_STATUS: TicketStatus = {
  stage: "new",
  project_dir: null,
  project_name: null,
  name: null,
  last_seen_assignee_gid: null,
  last_seen_completed: false,
  verdict: null,
  sasd_checked: false,
  sasd_info: null,
  history: [],
  content_hash: null,
  last_seen_modified_at: null,
  needs_reanalysis: false,
  summaries: { analysis: null, implementation: null, verification: null },
  confirmation: null,
  verifier_root_cause: null,
  consecutive_fail_count: 0,
  implementation_manual_actions: [],
  verification_manual_actions: [],
  sync: {
    analysis_hash: null,
    implementation_hash: null,
    verification_hash: null,
    analysis_hash_at_impl_write: null,
    implementation_hash_at_verify_write: null,
  },
};

/** 短雜湊（前 16 碼 sha256 hex），只用來比對票單內容有沒有真的變過，不需要密碼學強度。 */
export function hashTicketContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}

/** 舊版 status.json（改版前寫入的）可能沒有 content_hash/summaries/sync 等新欄位，讀回來時補上預設值，避免下游對 undefined 欄位動作出錯。 */
function withDefaults(parsed: Partial<TicketStatus>): TicketStatus {
  return {
    ...NEW_STATUS,
    ...parsed,
    summaries: { ...NEW_STATUS.summaries, ...parsed.summaries },
    sync: { ...NEW_STATUS.sync, ...parsed.sync },
  };
}

/**
 * Reads status.json at `filePath`, returning a fresh NEW_STATUS if it doesn't exist yet (a brand-new
 * ticket — this is the normal, expected case). If the file DOES exist but fails to parse as JSON (e.g.
 * the process was killed mid-write before atomic writes were introduced, or the disk/filesystem
 * corrupted it), this throws instead of silently treating it as a new ticket — a corrupted tracking
 * file must never be mistaken for "no progress yet", or a ticket's real analysis/implementation/
 * verification history can vanish with no warning.
 */
async function readStatusFileRaw(filePath: string): Promise<TicketStatus> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return { ...NEW_STATUS };
    throw new Error(`讀取票單追蹤狀態失敗（${filePath}）：${err.message}`);
  }
  try {
    return withDefaults(JSON.parse(raw));
  } catch (err: any) {
    throw new Error(
      `票單追蹤檔案損毀，無法解析為 JSON：${filePath} —— 不會當作新票單處理，請人工檢查這個檔案（可能是寫入中途被中斷），必要時從備份或 git 歷史還原。原始錯誤：${err.message}`
    );
  }
}

export async function readStatus(ticketGid: string): Promise<TicketStatus> {
  const dir = await resolveTicketDir(ticketGid);
  return readStatusFileRaw(path.join(dir, "status.json"));
}

/**
 * Like readStatus, but never throws/creates a tracking directory for tickets that haven't been
 * snapshotted yet — returns the "new" default instead. Use this for read-only scans over many tickets
 * (e.g. list_pending_tickets) where most tickets won't have a directory yet.
 *
 * Unlike readStatus, a corrupted status.json here does NOT throw — one bad ticket shouldn't break
 * listing every other ticket in the project. It's logged to stderr instead so the corruption is at
 * least visible, and the ticket falls back to looking "new" for this listing (the real error still
 * surfaces the moment something calls readStatus/get_ticket_status on that specific ticket).
 */
export async function peekStatus(ticketGid: string): Promise<TicketStatus> {
  const index = await readJsonFile<Record<string, string>>(getTicketsIndexFile(), {});
  const dir = index[ticketGid];
  if (!dir) return { ...NEW_STATUS };
  const filePath = path.join(dir, "status.json");
  try {
    return await readStatusFileRaw(filePath);
  } catch (err: any) {
    console.error(`[asana-pipeline-mcp] peekStatus: ${err.message}`);
    return { ...NEW_STATUS };
  }
}

/** Applies a forward-only stage transition to `status`: if `stage` isn't further along than the current one, only `patch` is applied (stage/history untouched); otherwise stage advances and a history entry is appended. Pure — used inside locked read-modify-write transactions below. */
function applyStageIfForward(status: TicketStatus, stage: TicketStatus["stage"], patch: Partial<TicketStatus>): TicketStatus {
  if (STAGE_ORDER.indexOf(stage) <= STAGE_ORDER.indexOf(status.stage)) {
    return { ...status, ...patch };
  }
  return { ...status, ...patch, stage, history: [...status.history, { stage, at: nowIso() }] };
}

/**
 * Reads, mutates, and atomically writes back a ticket's status.json as one locked transaction (keyed by
 * that ticket's status.json path), so two nearly-simultaneous updates to the same ticket (e.g. a stray
 * duplicate tool call) can't race and silently drop one side's change. `mutator` must be pure — do not
 * call updateStatus/readStatus/peekStatus for the SAME ticketGid from inside it, that would deadlock
 * against the lock this function is already holding.
 */
async function updateStatus(
  ticketGid: string,
  mutator: (status: TicketStatus) => TicketStatus | Promise<TicketStatus>
): Promise<TicketStatus> {
  const dir = await resolveTicketDir(ticketGid);
  const filePath = path.join(dir, "status.json");
  return withFileLock(filePath, async () => {
    const current = await readStatusFileRaw(filePath);
    const updated = await mutator(current);
    await writeJsonFileAtomic(filePath, updated);
    return updated;
  });
}

/**
 * 呼叫端（index.ts 的 advance_ticket_stage 工具）每次帶 verdict 更新時，這裡機械式維護兩件跟 verdict 綁在一起的事：
 * - `consecutive_fail_count`：FAIL 累加、PASS（或其他非 FAIL 值）歸零——這是安全閥，不依賴 AI 自己心算連續 FAIL 了幾輪，
 *   即使换一个完全没有上下文记忆的新 session，`needsHumanReview` 也能拿到正確答案。
 * - 清空 `confirmation`：這個人類確認是針對「上一輪程式碼/結論」表態的，新 verdict 出爐代表程式碼或結論已經
 *   更新，舊確認不能被誤認成也適用於這一輪，必須作廢逼使用者重新表態。
 * `verifier_root_cause` 本身的值仍然完全來自呼叫端傳入的 `patch`（這裡不生成，只在 verdict 不是 FAIL 時強制清空，
 * 避免殘留上一輪 FAIL 的根因標記）。
 */
export async function advanceStage(ticketGid: string, stage: TicketStatus["stage"], patch: Partial<TicketStatus> = {}): Promise<TicketStatus> {
  return updateStatus(ticketGid, (status) => {
    const finalPatch: Partial<TicketStatus> = { ...patch };
    if (patch.verdict !== undefined) {
      finalPatch.confirmation = null;
      finalPatch.consecutive_fail_count = patch.verdict === "FAIL" ? status.consecutive_fail_count + 1 : 0;
      if (patch.verdict !== "FAIL") finalPatch.verifier_root_cause = null;
    }
    return {
      ...status,
      ...finalPatch,
      stage,
      history: [...status.history, { stage, at: nowIso() }],
    };
  });
}

/**
 * Like advanceStage, but never lets `stage` regress in STAGE_ORDER (any `patch` fields
 * still apply either way). Use this for stage transitions that can legitimately be
 * re-triggered on an already-further-along ticket (e.g. re-snapshotting a ticket just to
 * refresh ticket.md) — a plain advanceStage there would wipe out "verified"/PASS and make
 * the ticket look pending forever in list_pending_tickets.
 */
export async function advanceStageIfForward(ticketGid: string, stage: TicketStatus["stage"], patch: Partial<TicketStatus> = {}): Promise<TicketStatus> {
  return updateStatus(ticketGid, (status) => applyStageIfForward(status, stage, patch));
}

export interface SnapshotContentResult {
  changed: boolean;
  needsReanalysis: boolean;
  status: TicketStatus;
}

/**
 * 每次 get_ticket_snapshot 抓到票單內容時呼叫。用內容雜湊（而非 Asana 的 modified_at——那個連指派人/到期日變動都會跳，不夠精準）判斷「描述+留言」是否真的變了。
 * - 內容沒變：只更新 last_seen_modified_at（跟 list_pending_tickets 的便宜初篩同步），不動 stage/verdict/needs_reanalysis，呼叫端可以省下重寫 ticket.md、把全文塞回對話的成本。
 * - 內容變了、且這張票先前已經有 analyzed/implemented/verified 的進度：標記 needs_reanalysis=true、verdict 清空——即使原本是 PASS，也要當作還沒驗證過，逼下一次處理重新從分析師走一遍。stage 本身不變（history/舊 artifact 仍保留，方便對照修改前後差異）。
 * 整個判斷 + 寫入是單一鎖定的交易（見 updateStatus），避免跟同一張票的其他更新交錯。
 */
export async function recordSnapshotContent(
  ticketGid: string,
  content: string,
  modifiedAt: string | null
): Promise<SnapshotContentResult> {
  let changed = false;
  const updated = await updateStatus(ticketGid, (status) => {
    const newHash = hashTicketContent(content);

    if (status.content_hash === newHash) {
      changed = false;
      return applyStageIfForward(status, "snapshot", { last_seen_modified_at: modifiedAt });
    }

    changed = true;
    const hadPriorProgress = STAGE_ORDER.indexOf(status.stage) > STAGE_ORDER.indexOf("snapshot");
    return applyStageIfForward(status, "snapshot", {
      content_hash: newHash,
      last_seen_modified_at: modifiedAt,
      needs_reanalysis: hadPriorProgress ? true : status.needs_reanalysis,
      verdict: hadPriorProgress ? null : status.verdict,
      // 票單內容真的變了、且之前有進度：舊的人類確認一併作廢，不能讓「測過的是舊版內容」被誤認成這一版也測過。
      confirmation: hadPriorProgress ? null : status.confirmation,
      // 根因標記/安全閥計數也是針對「上一版內容」算出來的，內容真的變了就沒有意義，一併歸零，不能讓舊版的連續 FAIL 次數影響新內容的判斷。
      verifier_root_cause: hadPriorProgress ? null : status.verifier_root_cause,
      consecutive_fail_count: hadPriorProgress ? 0 : status.consecutive_fail_count,
      // 舊的人工待辦事項是針對「上一版程式碼」宣告的，內容真的變了、要重新走一次實作，舊的宣告一併清空，等新一輪工程師/驗證師重新宣告。
      implementation_manual_actions: hadPriorProgress ? [] : status.implementation_manual_actions,
      verification_manual_actions: hadPriorProgress ? [] : status.verification_manual_actions,
    });
  });
  return { changed, needsReanalysis: updated.needs_reanalysis, status: updated };
}

const ARTIFACT_SUMMARY_KEY: Record<string, keyof TicketSummaries> = {
  "01-analysis.md": "analysis",
  "02-implementation.md": "implementation",
  "03-verification.md": "verification",
};

/** write_ticket_artifact 寫入 01/02/03 全文時，順便把精簡摘要存進 status.summaries，讓之後接手的 session/AI 用 get_ticket_status 就能低成本掌握進度，不必每次都整份讀全文。寫入 01-analysis.md 時會自動清掉 needs_reanalysis（代表分析師已經針對變更後的內容重新分析過了）。 */
export async function recordArtifactSummary(ticketGid: string, filename: string, summary: string | null | undefined): Promise<void> {
  const key = ARTIFACT_SUMMARY_KEY[filename];
  if (!key || !summary) return;
  await updateStatus(ticketGid, (status) => {
    const patch: Partial<TicketStatus> = { summaries: { ...status.summaries, [key]: summary } };
    if (filename === "01-analysis.md") {
      patch.needs_reanalysis = false;
      // 分析師已經針對最新情況重新分析過，上一輪驗證師判斷的根因標記（如果有）已經處理掉了，不用再帶著跑。
      patch.verifier_root_cause = null;
      // 刻意不在這裡清空 implementation_manual_actions/verification_manual_actions：
      // 曾經清空過（假設 01 改完engineer/verifier 一定會緊接著重跑、屆時 write_ticket_artifact 寫 02/03 的必填 manualActions
      // 會自然覆蓋掉舊清單），但實際上 01 被重寫、stage 卻還停在 verified（例如只是針對 needs_reanalysis 誤觸發做複查、
      // 沒有真的重跑工程師/驗證師）的情況很常見——那樣清空只會讓真正還沒處理完的手動待辦（SQL/I18N之類）從
      // PENDING_HUMAN_ACTIONS.md 憑空消失、沒有任何機制會補回來。02/03 各自的 manualActions 本來就是各自獨立累積、
      // 下次真的重寫 02/03 時必填欄位自然會整份覆蓋成最新版，不需要靠這裡預先清空。
    }
    return { ...status, ...patch };
  });
}

const MANUAL_ACTIONS_KEY: Record<string, keyof Pick<TicketStatus, "implementation_manual_actions" | "verification_manual_actions">> = {
  "02-implementation.md": "implementation_manual_actions",
  "03-verification.md": "verification_manual_actions",
};

export interface SensitiveManualActionHit {
  action: string;
  reasons: string[];
}

/**
 * 掃 manualActions 陣列裡有沒有夾帶完整 SQL 語句全文、憑證/連線字串——這些追蹤摘要（會被整理進
 * PENDING_HUMAN_ACTIONS.md 這種「給人快速掃過」的地方）只該留技術性描述，例如「已產出 INSERT SQL，
 * 新增 3 語系 OPTIONS_SOURCE 選項資料，待手動執行」，不該把真正的 SQL 全文、真實資料值、密碼/連線字串
 * 整段複製進去（即使這些追蹤檔案只存在本機、沒進任何 git repo，涉及銀行等客戶的人資/薪資資料還是要比照
 * 敏感資料處理原則）。只負責擋在寫入之前提醒改寫，不負責判斷「技術性描述夠不夠精簡」這種主觀問題——
 * 這是 settings.json 的 hook 管不到的地方（hook 只認得 Bash/PowerShell/Edit/Write，MCP 工具呼叫本身
 * 不會觸發任何 hook），所以直接做在寫入路徑裡，不管呼叫端是不是走 write_ticket_artifact 都躲不掉。
 */
export function detectSensitiveManualActions(actions: string[]): SensitiveManualActionHit[] {
  const sqlPattern =
    /\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|SELECT\s+[\s\S]*?\bFROM\b)\b[\s\S]*?(\bVALUES\s*\(|\bSET\b|\bWHERE\b)/i;
  const credentialPattern =
    /(jdbc:|mongodb:\/\/|postgres(?:ql)?:\/\/|mysql:\/\/|password\s*=\s*\S+|pwd\s*=\s*\S+|api[_-]?key\s*[=:]\s*\S+|secret\s*[=:]\s*\S+|Server\s*=[^;]*;\s*.*Password\s*=)/i;
  const hits: SensitiveManualActionHit[] = [];
  for (const action of actions) {
    const reasons: string[] = [];
    if (sqlPattern.test(action)) reasons.push("看起來包含完整 SQL 語句全文");
    if (credentialPattern.test(action)) reasons.push("看起來包含憑證/連線字串");
    if (reasons.length > 0) hits.push({ action, reasons });
  }
  return hits;
}

/**
 * write_ticket_artifact 寫 02/03 時必填的「需要使用者手動處理」事項清單（可以是空陣列，代表明確確認這次沒有）。
 * 兩份文件各自獨立累積、互相不覆蓋——工程師交代的事項不會因為驗證師這次沒有重複提到就消失，兩邊都要看才算完整。
 * 這是刻意做成機械式必填欄位，不是選填提醒：這類一次性的人工待辦（典型例子是「已產出 SQL，僅能由使用者到
 * Database 工具手動執行」）過去只寫在 02/03 全文或聊天視窗裡，換個 session、或使用者沒仔細重讀全文就會被漏掉。
 */
export async function recordManualActions(
  ticketGid: string,
  filename: "02-implementation.md" | "03-verification.md",
  actions: string[]
): Promise<void> {
  const key = MANUAL_ACTIONS_KEY[filename];
  await updateStatus(ticketGid, (status) => ({ ...status, [key]: actions }));
}

export interface ResolveManualActionResult {
  removed: boolean;
  remaining: string[];
}

/**
 * 把 implementation_manual_actions／verification_manual_actions 裡「使用者確認已經處理完」的一項移除，
 * 其餘保留——這樣使用者只要用一句話講出哪一項做完了，呼叫端就能精準拿掉那一項，不用整份陣列重新宣告一次。
 * 用文字精確比對（前後空白會忽略），找不到完全對應的項目就不動任何東西、回傳目前完整清單，讓呼叫端核對
 * 正確文字後再試一次，不要在對不上的情況下憑印象猜測要刪哪一項。
 */
export async function resolveManualAction(
  ticketGid: string,
  filename: "02-implementation.md" | "03-verification.md",
  action: string
): Promise<ResolveManualActionResult> {
  const key = MANUAL_ACTIONS_KEY[filename];
  let removed = false;
  let remaining: string[] = [];
  await updateStatus(ticketGid, (status) => {
    const current = status[key];
    const idx = current.findIndex((a) => a.trim() === action.trim());
    if (idx === -1) {
      remaining = current;
      return status;
    }
    removed = true;
    remaining = [...current.slice(0, idx), ...current.slice(idx + 1)];
    return { ...status, [key]: remaining };
  });
  return { removed, remaining };
}

/** write_ticket_artifact 寫 02/03 時，syncNote 帶這個 sentinel 代表「明確判斷過這次不需要同步回上一階段文件」——不是省略不填，而是主動選了「沒有」這個答案。 */
export const NO_SYNC_NEEDED = "NO_SYNC_NEEDED";

export interface SyncFlags {
  /** true 代表 01-analysis.md 在上次寫 02 之後又被獨立改過，02 目前的內容還沒對照過最新的 01——換 session/AI 接手前該檢查這個。 */
  analysis_stale: boolean;
  /** true 代表 02-implementation.md 在上次寫 03 之後又被獨立改過，03 目前的結論還沒對照過最新的 02。 */
  implementation_stale: boolean;
}

/** 只在下游階段已經至少寫過一次（有快照可比對）時才可能是 true——下游階段還沒開始寫之前，上游文件不管怎麼變都談不上「不同步」。 */
export function computeSyncFlags(status: TicketStatus): SyncFlags {
  const s = status.sync;
  return {
    analysis_stale: s.analysis_hash_at_impl_write !== null && s.analysis_hash_at_impl_write !== s.analysis_hash,
    implementation_stale:
      s.implementation_hash_at_verify_write !== null && s.implementation_hash_at_verify_write !== s.implementation_hash,
  };
}

/** true 代表對應那份檔案，跟 status.json 記錄的雜湊對不上——內容在這個 MCP 不知情的狀況下被改過（直接手動編輯、別的 AI 繞過 write_ticket_artifact）。跟 computeSyncFlags 是不同軸向：那組比的是「兩個都是舊記錄」彼此對不對得起來，這組比的是「舊記錄」跟「磁碟上現在真正的內容」對不對得起來，才抓得到繞過 MCP 的修改。 */
export interface ExternalChangeFlags {
  analysis_externally_modified: boolean;
  implementation_externally_modified: boolean;
  verification_externally_modified: boolean;
}

/**
 * 讀一次 01/02/03-*.md 現在磁碟上的實際內容、重新算雜湊，跟 status.json 裡 sync.*_hash 記錄的值比對。
 * 只有在「記錄過雜湊、也讀得到檔案」的情況下才可能判定為 true——檔案還沒被 write_ticket_artifact 寫過（sync.xxx_hash
 * 還是 null）或根本不存在（尚未走到那個階段）都不算「被外部改過」，只是還沒開始。
 * 呼叫端（get_ticket_status）發現任一個是 true，代表對應的 summaries.* 快取摘要跟 sync_flags 都可能已經過期，
 * 應該提醒使用者重新讀全文，不要只信快取——不需要也不應該自動做任何修正，那是 resync_ticket_artifact 的責任。
 */
export async function detectExternalChanges(ticketGid: string, status: TicketStatus): Promise<ExternalChangeFlags> {
  const [analysis, implementation, verification] = await Promise.all([
    readArtifact(ticketGid, "01-analysis.md"),
    readArtifact(ticketGid, "02-implementation.md"),
    readArtifact(ticketGid, "03-verification.md"),
  ]);
  const isModified = (content: string | null, recordedHash: string | null) =>
    recordedHash !== null && content !== null && hashTicketContent(content) !== recordedHash;
  return {
    analysis_externally_modified: isModified(analysis, status.sync.analysis_hash),
    implementation_externally_modified: isModified(implementation, status.sync.implementation_hash),
    verification_externally_modified: isModified(verification, status.sync.verification_hash),
  };
}

const ARTIFACT_HASH_KEY: Record<string, keyof TicketSyncState> = {
  "01-analysis.md": "analysis_hash",
  "02-implementation.md": "implementation_hash",
  "03-verification.md": "verification_hash",
};

/** write_ticket_artifact 每次寫 01/02/03 之後呼叫，把「這份文件現在長怎樣」的雜湊記下來，供 computeSyncFlags 比對用。 */
export async function recordArtifactHash(ticketGid: string, filename: string, content: string): Promise<void> {
  const key = ARTIFACT_HASH_KEY[filename];
  if (!key) return;
  await updateStatus(ticketGid, (status) => ({ ...status, sync: { ...status.sync, [key]: hashTicketContent(content) } }));
}

/** 每次 appendSyncNote 寫完都會在檔案尾端留這一行不可見的 sentinel，當作「今天/這個階段是否已經同步過」的判斷依據——
 * 用固定格式的字串比對（trimmed.endsWith(cursor)），不解析 markdown 結構，不會被 syncNote 本文裡的 `#` 開頭行、
 * 巢狀子標題（### ...）或程式碼片段（shebang／#define／註解）誤判。HTML 註解在大多數 markdown 渲染器裡不會顯示，
 * 不會干擾人類閱讀時的體感。 */
function buildSyncCursor(dateStr: string, stageLabel: string): string {
  return `<!-- sync-cursor: ${dateStr} ${stageLabel} -->`;
}

/**
 * 把 syncNote 附加到上一階段的文件尾端，回傳附加後的完整內容（呼叫端要用這個重新算雜湊，不要用原本的 content 變數）。
 * 同一天、同一階段（例如同一輪反覆修正 02 好幾次）的多次呼叫，會合併進同一個標題底下、用 `---` 分隔線隔開，
 * 不會每次都開一個新標題——不然像某次實測情況（一天內對 02 寫入十幾次），01-analysis.md 尾端會疊出
 * 十幾個標題幾乎相同的區塊，等於把「忘記同步」換成「同步了但零碎、難讀」，沒有真正解決問題。
 * 用分隔線而不是條列符號 `- `：syncNote 常常是多段落甚至帶子項目的長文字，硬塞進單行條列符號會破壞 markdown 排版。
 * 「是不是同一個區塊」用檔尾的 sync-cursor sentinel 判斷（見 buildSyncCursor），不是掃描內容裡有沒有 `#` 開頭的行——
 * 後者會被 syncNote 本文的子標題/程式碼片段誤判，見 DESIGN-sync.md 的複查記錄。
 */
async function appendSyncNote(ticketGid: string, targetFilename: string, note: string, stageLabel: string): Promise<string> {
  const existing = (await readArtifact(ticketGid, targetFilename)) ?? "";
  const trimmed = existing.trimEnd();
  const today = nowIso().slice(0, 10);
  const heading = `## ${today} 同步更新（${stageLabel}自動追加）`;
  const cursor = buildSyncCursor(today, stageLabel);

  const isContinuation = trimmed.endsWith(cursor);

  const updated = isContinuation
    ? `${trimmed.slice(0, trimmed.length - cursor.length).trimEnd()}\n\n---\n\n${note}\n\n${cursor}\n`
    : `${trimmed}\n\n${heading}\n\n${note}\n\n${cursor}\n`;

  await writeArtifact(ticketGid, targetFilename, updated);
  return updated;
}

/**
 * 強制二選一同步機制：write_ticket_artifact 寫 02-implementation.md／03-verification.md 時，呼叫端這兩個檔名一定要帶 syncNote（見 index.ts 的必填檢查），這個函式處理實際的同步動作。
 * - syncNote === NO_SYNC_NEEDED：代表呼叫端已經明確判斷「這次沒有東西需要同步」，不會動上一階段文件的內容，只把它現在的雜湊記下來當作「已核對過」的快照。
 * - 其他任何文字：當成真正的同步內容，附加到上一階段文件尾端，並用附加後的新內容重新算雜湊。
 * 兩種情況都會讓 computeSyncFlags 對應的欄位變回 false——因為兩種情況都代表「這個時間點，下游已經跟上游核對過了」，差別只在核對的結果是「有更新」還是「確認無需更新」。
 */
export async function recordStageSync(
  ticketGid: string,
  target: "02-implementation.md" | "03-verification.md",
  syncNote: string
): Promise<void> {
  const upstream = target === "02-implementation.md" ? "01-analysis.md" : "02-implementation.md";
  const stageLabel = target === "02-implementation.md" ? "工程階段" : "驗證階段";
  const hashKey: keyof TicketSyncState = target === "02-implementation.md" ? "analysis_hash" : "implementation_hash";
  const snapshotKey: keyof TicketSyncState =
    target === "02-implementation.md" ? "analysis_hash_at_impl_write" : "implementation_hash_at_verify_write";

  let upstreamHash: string;
  if (syncNote === NO_SYNC_NEEDED) {
    const current = (await readArtifact(ticketGid, upstream)) ?? "";
    upstreamHash = hashTicketContent(current);
  } else {
    const updated = await appendSyncNote(ticketGid, upstream, syncNote, stageLabel);
    upstreamHash = hashTicketContent(updated);
  }

  await updateStatus(ticketGid, (status) => ({
    ...status,
    sync: { ...status.sync, [hashKey]: upstreamHash, [snapshotKey]: upstreamHash },
  }));
}

/**
 * 記錄結案前唯一一關人類確認——使用者自己的實測＋程式碼品質審視結果。跟 advanceStage 的 verdict（AI 驗證師自己
 * 判定的 PASS/FAIL）是完全不同的欄位，呼叫端（index.ts 的 record_confirmation 工具）自行決定要不要限制只能在
 * stage === "verified" 時呼叫。
 * confirmed: false 時，除了記錄 note，也會把 verdict 重設回 null——讓這張票重新落入 list_pending_tickets 的
 * `pending`（標記 humanRejected: true），套用跟 AI 驗證師自己判 FAIL 完全一樣的根因分流機制去處理，而不是
 * 另外發明一條「人工打回」的獨立流程。注意這裡刻意不呼叫 advanceStage／不清空這個 confirmation 本身——
 * 那個函式會把 confirmation 一起清空，會連這則剛寫入的 note 都一起抹掉。
 */
export async function recordConfirmation(
  ticketGid: string,
  confirmed: boolean,
  note?: string | null
): Promise<TicketStatus> {
  return updateStatus(ticketGid, (status) => ({
    ...status,
    confirmation: { confirmed, confirmedAt: nowIso(), note: note ?? null },
    ...(confirmed === false ? { verdict: null } : {}),
  }));
}

/** 連續 FAIL 次數是否已經到達需要停下來問人的門檻——由 advanceStage 機械式維護 consecutive_fail_count，這裡只是算出布林值，邏輯比照 computeSyncFlags。 */
export function needsHumanReview(status: TicketStatus): boolean {
  return status.consecutive_fail_count >= 3;
}

export async function writeArtifact(ticketGid: string, filename: string, content: string): Promise<void> {
  const dir = await resolveTicketDir(ticketGid);
  await writeFile(path.join(dir, filename), content, "utf-8");
}

export async function readArtifact(ticketGid: string, filename: string): Promise<string | null> {
  const dir = await resolveTicketDir(ticketGid);
  try {
    return await readFile(path.join(dir, filename), "utf-8");
  } catch {
    return null;
  }
}

/**
 * 局部重建報告時，這張票在本機的顯示名稱——`status.name` 是 2026-08-24 才新增的欄位，這個
 * 日期之前就已經追蹤過的票單還沒被任何一次 get_ticket_snapshot 摸過，這個欄位是 null。與其讓
 * 使用者在報告裡看到一串看不懂的 taskGid，改讀這張票追蹤目錄裡本來就存在的 `ticket.md`（任何
 * 呼叫過 get_ticket_snapshot 的票單都一定有這份檔案，不管是新版還是舊版程式碼寫入的），取它第一行
 * `# 票名` 當顯示名稱——純讀本機檔案，不用額外呼叫 Asana。真的連 ticket.md 都讀不到（理論上不會
 * 發生，除非追蹤目錄被手動清過）才退回顯示 taskGid。
 */
export async function resolveTicketDisplayName(gid: string, status: TicketStatus): Promise<string> {
  if (status.name) return status.name;
  try {
    const ticketMd = await readArtifact(gid, "ticket.md");
    const firstLine = ticketMd?.split("\n")[0]?.trim();
    if (firstLine?.startsWith("# ") && firstLine.length > 2) return firstLine.slice(2).trim();
  } catch (err: any) {
    console.error(`[asana-pipeline-mcp] resolveTicketDisplayName(${gid}) failed: ${err?.message ?? err}`);
  }
  return gid;
}

export interface PendingActionsReportInput {
  awaitingConfirmation: { taskGid: string; name: string }[];
  needsHumanReview: { taskGid: string; name: string; consecutiveFailCount: number }[];
  /** 已經判過 PASS（或先前分析過）的票單，Asana 上的內容後來又被改過——不能因為之前處理過就跳過，需要重新看內容決定要不要重新分析。 */
  contentChanged: { taskGid: string; name: string; stage: string }[];
  manualActions: { taskGid: string; name: string; actions: string[] }[];
  /**
   * 每個已登記 git 版控根目錄的未 commit 檔案，已依票單分組、且只保留「git status 真的還沒 commit、
   * 又有某張票的 manualActions 點名說是它改的」檔案——跟這次 pipeline 無關的其他未 commit 檔案整份省略，
   * 不在這份報告的職責範圍內（要查全部異動請自己跑 git status）。`registered: false` 代表這個 projectDir
   * 還沒呼叫過 register_git_roots。
   */
  uncommittedChanges: {
    registered: boolean;
    roots: {
      label: string;
      path: string;
      error?: string;
      ticketGroups: { taskGid: string; name: string; files: string[] }[];
    }[];
  };
}

/**
 * 把「這條 pipeline 跑完之後需要人工處理」的四類項目寫成一份持久化的 Markdown 檔案，取代原本只在聊天視窗
 * 提醒一次、換個 session 就找不到的做法。呼叫端（index.ts 的 list_pending_tickets）每次執行都會用當下
 * 重新算出來的資料整份覆寫這個檔案，不需要任何人記得手動維護，也不會因為聊天記錄被清掉/壓縮就遺失。
 * 檔案位置跟每張票自己的追蹤目錄同一層（<projectDir>/.asana-pipeline/<projectName>/），不是散落在各票單
 * 資料夾裡，方便使用者一次打開就看到這個 Asana 專案底下全部待處理項目。
 */
/**
 * 這張票給人看的「單號」——`assignTicketDir` 建追蹤目錄時，資料夾葉節點名稱本來就是
 * `sanitizeSegment(ticketNumber || taskGid)`（見上方 assignTicketDir），所以不需要另外存一份
 * ticketNumber 欄位，直接讀 tickets-index.json 記錄的目錄路徑、取最後一段當單號即可。偵測失敗
 * （或這張票還沒建過追蹤目錄）時，資料夾名稱本來就是退回 taskGid，這裡自然也是顯示 taskGid，
 * 跟現有行為一致，不會因為看不懂而顯示空白。
 */
async function resolveTicketNumberForDisplay(taskGid: string): Promise<string> {
  const dir = await getAssignedDir(taskGid);
  return dir ? path.basename(dir) : taskGid;
}

/** 批次把一批 taskGid 解析成單號，去重後平行查，供渲染報告時用（避免同一張票在多個區塊各自重複查一次）。 */
async function buildTicketNumberMap(taskGids: string[]): Promise<Map<string, string>> {
  const uniqueGids = Array.from(new Set(taskGids));
  const entries = await Promise.all(
    uniqueGids.map(async (gid) => [gid, await resolveTicketNumberForDisplay(gid)] as const)
  );
  return new Map(entries);
}

/**
 * 把「跟票單有關的未 commit 檔案」排成「## Git 尚未 commit 的變更」這個區塊，依票單分組——沒登記過 git
 * 根目錄、git status 執行失敗、或有根目錄但沒有任何票單點名的檔案還沒 commit，都各自給一句清楚的說明，
 * 不要讓使用者猜「是沒登記、真的沒異動、還是只是沒票單認領」。
 */
function renderUncommittedSection(
  uncommitted: PendingActionsReportInput["uncommittedChanges"],
  numberMap: Map<string, string>
): string {
  const title = "Git 尚未 commit 的變更";
  if (!uncommitted.registered) {
    return `## ${title}\n\n（這個專案還沒登記 git 版控根目錄，呼叫 register_git_roots 之後才能檢查）\n`;
  }
  const lines = uncommitted.roots.flatMap((r) => {
    if (r.error) return [`${r.label}（${r.path}）— git status 執行失敗：${r.error}`];
    if (r.ticketGroups.length === 0) return [`${r.label}（${r.path}）— 沒有票單點名的檔案還沒 commit`];
    return r.ticketGroups.map((g) => {
      const fileList = g.files.map((f) => `  - ${f}`).join("\n");
      const number = numberMap.get(g.taskGid) ?? g.taskGid;
      return `${r.label}（${r.path}）— ${g.name}（\`${number}\`）${g.files.length} 個檔案有異動未 commit\n${fileList}`;
    });
  });
  return `## ${title}\n\n${lines.length > 0 ? lines.map((l) => `- [ ] ${l}`).join("\n") : "（無）"}\n`;
}

export async function writePendingActionsReport(
  projectDir: string,
  projectName: string,
  input: PendingActionsReportInput
): Promise<string> {
  const dir = path.join(projectDir, ".asana-pipeline", sanitizeSegment(projectName));
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "PENDING_HUMAN_ACTIONS.md");

  const allGids = [
    ...input.awaitingConfirmation.map((t) => t.taskGid),
    ...input.needsHumanReview.map((t) => t.taskGid),
    ...input.contentChanged.map((t) => t.taskGid),
    ...input.manualActions.map((t) => t.taskGid),
    ...input.uncommittedChanges.roots.flatMap((r) => r.ticketGroups.map((g) => g.taskGid)),
  ];
  const numberMap = await buildTicketNumberMap(allGids);
  const number = (taskGid: string) => numberMap.get(taskGid) ?? taskGid;

  const section = (title: string, lines: string[]): string =>
    `## ${title}\n\n${lines.length > 0 ? lines.map((l) => `- [ ] ${l}`).join("\n") : "（無）"}\n`;

  const content = [
    `# 待人工處理清單 — ${projectName}`,
    "",
    `> 由 \`asana-pipeline-mcp\` 的 \`list_pending_tickets\` 自動產生/覆寫，最後更新：${nowIso()}`,
    `> 每次執行 pipeline 都會用當下最新狀態整份重寫這個檔案——不要手動編輯，改動不會被保留。`,
    `> 括號裡是票號（對照 Asana 上的單號用），偵測不到票號的極少數情況會退回顯示內部 taskGid。`,
    "",
    section(
      "待你確認（AI 驗證師判 PASS，等你自己實測＋審視程式碼品質）",
      input.awaitingConfirmation.map((t) => `${t.name}（\`${number(t.taskGid)}\`）`)
    ),
    section(
      "卡住需要你介入（連續 FAIL 已達門檻，AI 不會再自動重跑）",
      input.needsHumanReview.map((t) => `${t.name}（\`${number(t.taskGid)}\`，已連續 FAIL ${t.consecutiveFailCount} 次）`)
    ),
    section(
      "Asana 內容已被異動，待重新確認（先前已處理過，但票單內容後來又被改了）",
      input.contentChanged.map((t) => `${t.name}（\`${number(t.taskGid)}\`，目前階段：${t.stage}）`)
    ),
    section(
      "需要你手動處理的事項（例如 SQL 只能由你到 Database 工具執行）",
      input.manualActions.flatMap((t) => t.actions.map((a) => `${t.name}（\`${number(t.taskGid)}\`）— ${a}`))
    ),
    renderUncommittedSection(input.uncommittedChanges, numberMap),
  ].join("\n");

  await writeFile(filePath, content, "utf-8");
  return filePath;
}
