import path from "node:path";
import { callAsanaTool } from "./mcp-clients.js";
import { resolveGitRoots } from "./git-roots-store.js";
import { runShell } from "./shell-tools.js";
import {
  peekStatus,
  needsHumanReview,
  listTicketsUnderProject,
  writePendingActionsReport,
  resolveTicketDisplayName,
} from "./pipeline-store.js";

/**
 * 從 manualActions 文字裡試著抽出「已完成但尚未 commit」點名的檔名清單（格式例：「...尚未 commit 到 hr git
 * repo（fix/ruihao 分支）：CIM01MasterPane.java、CIM01Program.java」——取最後一個冒號之後、逗號/、分隔的
 * 檔名列表）。這段文字是工程師/驗證師角色手寫的摘要，抽取結果只用來從真實 git status 結果裡「篩選範圍、
 * 標出跟哪張票有關」，判斷檔案現在是不是真的還沒 commit，仍然以 git status 為準，不是拿這段文字取代它。
 */
export function extractClaimedUncommittedFiles(action: string): string[] {
  if (!/commit/i.test(action)) return [];
  const lastColon = Math.max(action.lastIndexOf("："), action.lastIndexOf(":"));
  if (lastColon === -1) return [];
  return action
    .slice(lastColon + 1)
    .split(/[、,，]/)
    .map((s) => s.trim())
    .filter((s) => /\.[A-Za-z0-9]{1,10}$/.test(s));
}

/**
 * 把 manualActions 清單裡「純粹是提醒尚未 git commit、且點得出具體檔名」的項目濾掉，只留下報告的
 * 「需要你手動處理的事項」區塊該顯示的其他事項——這類「尚未 commit」的提醒已經有專屬的「Git 尚未
 * commit 的變更」區塊負責呈現（用真實 git status 核對過，比自由文字準確，且會隨著真的 commit 之後
 * 自動消失），重複出現在這個區塊只是雜訊。判斷依據跟 getUncommittedChangesSummary 用的是同一個
 * extractClaimedUncommittedFiles：只要抽得出具體檔名就視為「這項已經由 Git 區塊負責」而濾掉，不管
 * 現在 git status 是否還真的有異動——已經 commit 掉的話兩邊本來就都不該再顯示，這才是預期行為。
 * 只影響這份報告／回傳 JSON 的顯示範圍，不會動到 status.json 裡儲存的原始 manualActions 陣列，
 * `resolve_manual_action` 比對用的仍然是完整原文。
 */
export function filterOutGitCommitActions(
  manualActionsList: { taskGid: string; name: string; actions: string[] }[]
): { taskGid: string; name: string; actions: string[] }[] {
  return manualActionsList
    .map((t) => ({ ...t, actions: t.actions.filter((a) => extractClaimedUncommittedFiles(a).length === 0) }))
    .filter((t) => t.actions.length > 0);
}

/**
 * 對每個已登記的 git 版控根目錄跑一次 git status --porcelain 取得真實未 commit 狀態，再用每張票
 * manualActions 裡點名「尚未 commit」的檔名去篩選、依票單分組——只留下「git 真的還沒 commit、且有票單
 * 點名說是它改的」檔案，跟這次 pipeline 無關的其他未 commit 檔案整份省略（要查全部異動使用者自己跑
 * git status，不是這份報告的職責範圍）。
 */
export async function getUncommittedChangesSummary(
  projectDir: string,
  manualActionsList: { taskGid: string; name: string; actions: string[] }[]
): Promise<{
  registered: boolean;
  roots: {
    label: string;
    path: string;
    error?: string;
    ticketGroups: { taskGid: string; name: string; files: string[] }[];
  }[];
}> {
  const gitRoots = await resolveGitRoots(projectDir);
  if (!gitRoots || gitRoots.length === 0) return { registered: false, roots: [] };

  // 檔名（basename） -> 點名過這個檔名的票單清單（可能不只一張票改到同一個檔案，例如 CIQ04 三張票都動到同一批檔案）。
  const claimantsByBasename = new Map<string, { taskGid: string; name: string }[]>();
  for (const ticket of manualActionsList) {
    for (const action of ticket.actions) {
      for (const filename of extractClaimedUncommittedFiles(action)) {
        const existing = claimantsByBasename.get(filename) ?? [];
        if (!existing.some((t) => t.taskGid === ticket.taskGid)) {
          existing.push({ taskGid: ticket.taskGid, name: ticket.name });
        }
        claimantsByBasename.set(filename, existing);
      }
    }
  }

  const roots = await Promise.all(
    gitRoots.map(async (root) => {
      const result = await runShell(root.path, "git status --porcelain", [root]);
      if (!result.ok) {
        return {
          label: root.label,
          path: root.path,
          error: result.message || result.stderr || "未知錯誤",
          ticketGroups: [],
        };
      }
      const changedLines = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const groupsByTicket = new Map<string, { taskGid: string; name: string; files: string[] }>();
      for (const line of changedLines) {
        // porcelain 格式固定是「XY 路徑」，rename 會是「XY 舊路徑 -> 新路徑」，取箭頭後的新路徑來比對檔名。
        const rawPath = line.length > 3 ? line.slice(3) : line;
        const finalPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop()! : rawPath;
        const basename = path.basename(finalPath.replace(/[/\\]$/, ""));
        const claimants = claimantsByBasename.get(basename);
        if (!claimants) continue;
        for (const claimant of claimants) {
          const group = groupsByTicket.get(claimant.taskGid) ?? { taskGid: claimant.taskGid, name: claimant.name, files: [] };
          group.files.push(line);
          groupsByTicket.set(claimant.taskGid, group);
        }
      }
      return { label: root.label, path: root.path, ticketGroups: Array.from(groupsByTicket.values()) };
    })
  );
  return { registered: true, roots };
}

/** 這組共用 token 對應的 Asana 使用者 gid，行程存活期間只查一次（不會變動，沒必要每次都打 API）。查詢失敗回傳 null 且不快取失敗結果，讓下次呼叫可以重試——只在真的查到值之後才快取。 */
let cachedPipelineAsanaUserGid: string | null | undefined;
export async function getPipelineAsanaUserGid(): Promise<string | null> {
  if (cachedPipelineAsanaUserGid !== undefined) return cachedPipelineAsanaUserGid;
  try {
    const me = await callAsanaTool("asana_me", {});
    const gid = me?.success && me?.data?.gid ? String(me.data.gid) : null;
    if (gid) cachedPipelineAsanaUserGid = gid;
    return gid;
  } catch (err: any) {
    console.error(`[asana-pipeline-mcp] getPipelineAsanaUserGid failed: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * 任何單張票的狀態異動（advance_ticket_stage/write_ticket_artifact/resolve_manual_action/
 * record_confirmation/resync_ticket_artifact）呼叫完之後都會呼叫這個函式，局部重建這張票所屬
 * Asana 專案的 PENDING_HUMAN_ACTIONS.md——不依賴呼叫端記得額外呼叫 list_pending_tickets，這樣
 * 不管誰在用這個 MCP、用什麼話術觸發 pipeline，這份報告都不會因為漏了一步而變成舊資料。
 *
 * 純本機運算（不查 Asana 看板），根據每張已追蹤票單本地已知的狀態欄位重建——換的是「不用為了同步
 * 一份報告就對 Asana 重新拉一次整個看板」；代價是還沒被 get_ticket_snapshot 摸過的全新票單不會
 * 出現在這裡，那一類的發現仍然只能靠 list_pending_tickets 對 Asana 的完整查詢，兩者互補、不互相
 * 取代。
 *
 * 「Asana 內容已被異動，待重新確認」這個分類額外要求 `last_seen_assignee_gid` 剛好是這個 pipeline
 * 帳號本人——單純內容變了但沒指派給這個帳號的票單不會冒出來打擾使用者，跟 list_pending_tickets 那邊
 * 即時查 Asana 版本的同一個過濾條件一致（見那邊的 contentChangedList 組裝邏輯）。
 *
 * 失敗（例如檔案系統暫時性錯誤）只記錄到 stderr、不拋出——這是主要工具呼叫的附帶效果，不該讓它的
 * 失敗連帶讓 advance_ticket_stage 這類主要操作本身回報失敗。
 */
export async function syncPendingActionsReport(ticketGid: string): Promise<void> {
  try {
    const status = await peekStatus(ticketGid);
    if (!status.project_dir || !status.project_name) return;
    const projectDir = status.project_dir;
    const projectName = status.project_name;

    const pipelineUserGid = await getPipelineAsanaUserGid();

    const ticketGids = await listTicketsUnderProject(projectDir, projectName);
    const awaitingConfirmation: { taskGid: string; name: string }[] = [];
    const needsHumanReviewList: { taskGid: string; name: string; consecutiveFailCount: number }[] = [];
    const contentChangedList: { taskGid: string; name: string; stage: string }[] = [];
    const manualActionsList: { taskGid: string; name: string; actions: string[] }[] = [];

    for (const gid of ticketGids) {
      const s = await peekStatus(gid);
      // 這裡看不到即時的 Asana board（純本機運算，不查 Asana），只能靠上次 get_ticket_snapshot 記錄的
      // last_seen_completed 排除「Asana 上已經標記完成」的舊票單——否則專案裡歷年累積、早就結案的票單會
      // 無限期在這份局部重建的報告裡復活。還沒被新版程式碼碰過的舊票單這個欄位預設 false（未知），要等
      // 下次 get_ticket_snapshot 才會補上真實值，是這個純本機做法無法避免的暫時性落差。
      if (s.last_seen_completed) continue;
      const name = await resolveTicketDisplayName(gid, s);

      const manualActions = [...s.implementation_manual_actions, ...s.verification_manual_actions];
      if (manualActions.length > 0) manualActionsList.push({ taskGid: gid, name, actions: manualActions });

      if (s.stage === "verified" && s.verdict === "FAIL" && needsHumanReview(s)) {
        needsHumanReviewList.push({ taskGid: gid, name, consecutiveFailCount: s.consecutive_fail_count });
      }

      const isVerifiedPass = s.stage === "verified" && s.verdict === "PASS";
      if (isVerifiedPass && !s.needs_reanalysis) {
        if (s.confirmation?.confirmed === true) continue;
        awaitingConfirmation.push({ taskGid: gid, name });
        continue;
      }
      if (s.needs_reanalysis && pipelineUserGid !== null && s.last_seen_assignee_gid === pipelineUserGid) {
        contentChangedList.push({ taskGid: gid, name, stage: s.stage });
      }
    }

    const uncommittedChanges = await getUncommittedChangesSummary(projectDir, manualActionsList);
    await writePendingActionsReport(projectDir, projectName, {
      awaitingConfirmation,
      needsHumanReview: needsHumanReviewList,
      contentChanged: contentChangedList,
      manualActions: filterOutGitCommitActions(manualActionsList),
      uncommittedChanges,
    });
  } catch (err: any) {
    console.error(`[asana-pipeline-mcp] syncPendingActionsReport(${ticketGid}) failed: ${err?.message ?? err}`);
  }
}
