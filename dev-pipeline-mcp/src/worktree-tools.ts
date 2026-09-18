import path from "node:path";
import { access, readFile, writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textResult } from "./shared.js";
import { resolveGitRoots } from "./git-roots-store.js";
import { readStatus, getAssignedDir } from "./pipeline-store.js";
import {
  getCurrentBranch,
  revParse,
  worktreeAdd,
  worktreeRemove,
  deleteBranch,
  getPorcelainStatus,
  getChangedFilesSince,
  rebaseOnto,
  mergeBranchInto,
  listGitWorktrees,
  skipWorktreeFile,
} from "./git-utils.js";
import {
  listWorktreeEntries,
  findWorktreeById,
  findWorktreeByTicket,
  createWorktreeEntry,
  updateWorktreeEntry,
  addTicketToWorktree,
  removeWorktreeEntry,
  type WorktreeEntry,
} from "./worktree-store.js";

/** 這張票的追蹤資料夾葉節點名稱（票號），沿用 pipeline-store 已驗證過的命名，不在這層重跑票號偵測邏輯。 */
async function resolveTicketLeafName(taskGid: string): Promise<string> {
  const dir = await getAssignedDir(taskGid);
  if (!dir) {
    throw new Error(`找不到票單 ${taskGid} 的追蹤目錄，請先呼叫 get_ticket_snapshot 建立。`);
  }
  return path.basename(dir);
}

async function resolveGitRootForTicket(taskGid: string, gitRootLabel?: string | null): Promise<string> {
  const status = await readStatus(taskGid);
  if (!status.project_dir) {
    throw new Error(`票單 ${taskGid} 還沒設定 project_dir，請先透過 advance_ticket_stage 設定。`);
  }
  const roots = await resolveGitRoots(status.project_dir);
  if (!roots || roots.length === 0) {
    throw new Error(`${status.project_dir} 還沒登記過 git 版控根目錄，請先呼叫 register_git_roots。`);
  }
  if (roots.length === 1) return roots[0].path;
  if (!gitRootLabel) {
    throw new Error(
      `${status.project_dir} 登記了多個 git 根目錄（${roots.map((r) => r.label).join("、")}），請帶 gitRootLabel 指定要用哪一個。`
    );
  }
  const match = roots.find((r) => r.label === gitRootLabel);
  if (!match) {
    throw new Error(`找不到 label 為 "${gitRootLabel}" 的 git 根目錄，可用的有：${roots.map((r) => r.label).join("、")}`);
  }
  return match.path;
}

/**
 * Eclipse 用舊式 maven-eclipse-plugin 產生的 `.project` 檔案，`<name>` 標籤通常跟 pom.xml artifactId 同名——
 * worktree 跟主目錄 checkout 同一個 pom.xml，`<name>` 一定撞名，匯入 Eclipse 時會衝突。改完之後用
 * `--skip-worktree` 蓋住這個純粹給 Eclipse 看的本機修改，不讓它出現在 git status、也不會被合併回主分支。
 * 沒有 `.project` 或格式不是預期的舊式寫法（例如根本沒有 `<name>` 標籤）就靜默略過，不算錯誤。
 */
async function renameEclipseProjectIfPresent(
  worktreePath: string,
  leaf: string
): Promise<{ renamed: boolean; note?: string }> {
  const projectFile = path.join(worktreePath, ".project");
  let content: string;
  try {
    content = await readFile(projectFile, "utf-8");
  } catch {
    return { renamed: false };
  }
  const match = content.match(/<name>([^<]*)<\/name>/);
  if (!match) return { renamed: false };
  const newName = `${match[1]}-${leaf}-worktree`;
  if (match[1] === newName) return { renamed: false };
  const updated = content.replace(/<name>[^<]*<\/name>/, `<name>${newName}</name>`);
  await writeFile(projectFile, updated, "utf-8");
  await skipWorktreeFile(worktreePath, ".project").catch(() => {
    // 不是 git 追蹤的檔案（理論上 .project 一定有追蹤，但防呆一下）就算了，不影響主流程
  });
  return {
    renamed: true,
    note: `已將 .project 的 <name> 改成 "${newName}"，避免匯入 Eclipse 時跟主目錄的專案撞名；這個修改已用 git update-index --skip-worktree 排除，不會出現在 git status、也不會被合併回主分支。`,
  };
}

async function resolveEntryOrThrow(worktreeId?: string | null, taskGid?: string | null): Promise<WorktreeEntry> {
  const entry = worktreeId ? await findWorktreeById(worktreeId) : taskGid ? await findWorktreeByTicket(taskGid) : null;
  if (!entry) {
    throw new Error(`找不到對應的 worktree（worktreeId="${worktreeId ?? ""}", taskGid="${taskGid ?? ""}"）。`);
  }
  return entry;
}

export function registerWorktreeTools(server: McpServer): void {
  server.tool(
    "create_ticket_worktree",
    "為一張（或一組）票單建立獨立的 git worktree 工作目錄，隔離多個 AI/session 併行處理不同票單時互相干擾的問題（見記憶 project_dev_pipeline_worktree_design）。" +
      "**一個 worktree 綁定一組票號，不是單張票**——這張票如果要跟另一張已經有 worktree 的票合併進同一次改動，改呼叫 join_ticket_worktree，不要重複建立。" +
      "會從這張票 project_dir 目前登記的 git 根目錄裡，抓「目前 checkout 的分支」當作來源分支切出新分支＋worktree，worktree 資料夾建在 git 根目錄的上一層 `.worktrees/<票號>/`。" +
      "**只建立追蹤資料，不會自動幫你把程式碼複製過去**——後續的檔案編輯要自己對著回傳的 worktreePath 操作。" +
      "已經有 worktree 涵蓋這張票時，直接回傳既有的 worktree 資訊（冪等，不會重複建立）。",
    {
      taskGid: z.string().describe("Asana 任務 gid"),
      gitRootLabel: z
        .string()
        .nullable()
        .optional()
        .describe("這張票的 project_dir 登記了多個 git 根目錄時，指定要用哪一個（見 register_git_roots 的 label）"),
    },
    async ({ taskGid, gitRootLabel }) => {
      const existing = await findWorktreeByTicket(taskGid);
      if (existing) {
        return textResult({ success: true, alreadyExists: true, worktree: existing });
      }

      const gitRoot = await resolveGitRootForTicket(taskGid, gitRootLabel).catch((err) => {
        throw err;
      });
      const leaf = await resolveTicketLeafName(taskGid);
      const sourceBranch = await getCurrentBranch(gitRoot);
      const branch = `ticket/${leaf}`;
      const worktreePath = path.join(path.dirname(gitRoot), ".worktrees", leaf);

      const alreadyThere = await access(worktreePath).then(
        () => true,
        () => false
      );
      if (alreadyThere) {
        return textResult(
          {
            success: false,
            message: `${worktreePath} 已經存在，但不在這個 MCP 的追蹤紀錄裡——可能是先前手動建立或清除失敗留下的殘留，請人工檢查後再試（git worktree list 可以確認）。`,
          },
          true
        );
      }

      await worktreeAdd(gitRoot, worktreePath, branch, sourceBranch);
      const baseCommit = await revParse(gitRoot, sourceBranch);
      const eclipseProject = await renameEclipseProjectIfPresent(worktreePath, leaf);

      const now = new Date().toISOString();
      const entry = await createWorktreeEntry({
        id: leaf,
        gitRoot,
        worktreePath,
        branch,
        sourceBranch,
        baseCommit,
        ticketGids: [taskGid],
        status: "active",
        createdAt: now,
        updatedAt: now,
        lastMergeCommit: null,
      });

      return textResult({ success: true, alreadyExists: false, worktree: entry, eclipseProject });
    }
  );

  server.tool(
    "join_ticket_worktree",
    "把另一張票單併入既有的 worktree 分組（同一次改動要合併進同一個 commit 的情境）。之後這個 worktree 的每輪合併、清除，都要等這些票單全部確認結案。",
    {
      worktreeId: z.string().describe("既有 worktree 的 id（create_ticket_worktree 回傳的 worktree.id）"),
      taskGid: z.string().describe("要併入的 Asana 任務 gid"),
    },
    async ({ worktreeId, taskGid }) => {
      const already = await findWorktreeByTicket(taskGid);
      if (already && already.id !== worktreeId) {
        return textResult(
          { success: false, message: `票單 ${taskGid} 已經屬於另一個 worktree（${already.id}），不能同時併入兩個。` },
          true
        );
      }
      const entry = await addTicketToWorktree(worktreeId, taskGid);
      return textResult({ success: true, worktree: entry });
    }
  );

  server.tool(
    "get_worktree_status",
    "查詢一個 worktree 目前的真實狀態：實際改動了哪些檔案、來源分支有沒有領先（決定要不要先 rebase）。" +
      "**改動檔案清單是兩個來源的聯集**：`git status --porcelain`（還沒 commit 的異動）＋跟 `baseCommit` 的 diff（已經 commit 但還沒呼叫 merge_ticket_worktree 合併回去的異動）——只看前者的話，這輪一旦 commit 起來但還沒合併，工作目錄會變乾淨，會誤以為這個 worktree 什麼都沒動過。",
    {
      worktreeId: z.string().nullable().optional().describe("worktree id，跟 taskGid 至少帶一個"),
      taskGid: z.string().nullable().optional().describe("這張票所屬的 worktree，跟 worktreeId 至少帶一個"),
    },
    async ({ worktreeId, taskGid }) => {
      const entry = await resolveEntryOrThrow(worktreeId, taskGid);
      const touchedFiles = await getPorcelainStatus(entry.worktreePath);
      const committedSinceBase = await getChangedFilesSince(entry.worktreePath, entry.baseCommit);
      const sourceHead = await revParse(entry.gitRoot, entry.sourceBranch);
      const diverged = sourceHead !== entry.baseCommit;
      return textResult({
        success: true,
        worktree: entry,
        touchedFiles,
        committedSinceBase,
        sourceBranchHead: sourceHead,
        diverged,
        needsRebase: diverged,
      });
    }
  );

  server.tool(
    "merge_ticket_worktree",
    "完成這一輪：視情況把 worktree 分支 rebase 到來源分支最新狀態，再合併回來源分支（**只更新 git 根目錄的本機分支，絕不自動 push**）。worktree 資料夾本身不會被刪除，下一輪直接沿用。" +
      "**只有來源分支比 worktree 上次同步時領先才會觸發 rebase**（另一張共用來源分支的票先合併回去、或使用者自己在主目錄手動 commit/pull，都會造成領先）；沒有領先就直接快轉合併。" +
      "**rebase 或 merge 途中如果真的衝突，這個工具不會自動選邊、也不會自動 abort**——回傳 conflict:true，worktree（或主目錄）會停在衝突中間的狀態，需要人工/AI 進去解決衝突、`git add`、`git rebase --continue` 或 `git commit` 之後才能算完成，下次呼叫這個工具前要先確認衝突已經清乾淨。" +
      "呼叫前 worktree 裡的異動要先自己 commit 好——這裡不會幫你決定 commit message。",
    {
      worktreeId: z.string().nullable().optional().describe("worktree id，跟 taskGid 至少帶一個"),
      taskGid: z.string().nullable().optional().describe("這張票所屬的 worktree，跟 worktreeId 至少帶一個"),
      mergeMessage: z.string().describe("合併回來源分支時的 commit message，建議列出這輪併入的所有票號"),
    },
    async ({ worktreeId, taskGid, mergeMessage }) => {
      const entry = await resolveEntryOrThrow(worktreeId, taskGid);

      const dirty = await getPorcelainStatus(entry.worktreePath);
      if (dirty.length > 0) {
        return textResult(
          {
            success: false,
            message: `${entry.worktreePath} 還有 ${dirty.length} 個尚未 commit 的異動，請先在 worktree 裡自行 commit 完再呼叫這個工具。`,
            touchedFiles: dirty,
          },
          true
        );
      }

      const sourceHead = await revParse(entry.gitRoot, entry.sourceBranch);
      if (sourceHead !== entry.baseCommit) {
        const rebaseResult = await rebaseOnto(entry.worktreePath, entry.sourceBranch);
        if (!rebaseResult.ok) {
          return textResult(
            {
              success: false,
              conflict: rebaseResult.conflict,
              message: `rebase 到 ${entry.sourceBranch} 時${rebaseResult.conflict ? "發生衝突" : "失敗"}，worktree 已停在中間狀態，需要先手動解決：\n${rebaseResult.message}`,
            },
            true
          );
        }
      }

      const mergeResult = await mergeBranchInto(entry.gitRoot, entry.branch, mergeMessage);
      if (!mergeResult.ok) {
        return textResult(
          {
            success: false,
            conflict: mergeResult.conflict,
            message: `合併回 ${entry.sourceBranch}（${entry.gitRoot}）時${mergeResult.conflict ? "發生衝突" : "失敗"}，主目錄已停在中間狀態，需要先手動解決：\n${mergeResult.message}`,
          },
          true
        );
      }

      const newHead = await revParse(entry.gitRoot, entry.sourceBranch);
      const updated = await updateWorktreeEntry(entry.id, { baseCommit: newHead, lastMergeCommit: newHead });
      return textResult({ success: true, worktree: updated, mergeCommit: newHead });
    }
  );

  server.tool(
    "abandon_ticket_round",
    "中斷一輪還沒合併回去的 worktree 工作（例如這輪做到一半發現方向錯了）。會先把 worktree 裡目前的異動安全 commit 起來，分支留著當備份，**不會刪除 worktree 或分支**，只把這個 worktree 標記成 abandoned，之後不會再被拿來繼續下一輪。",
    {
      worktreeId: z.string().nullable().optional().describe("worktree id，跟 taskGid 至少帶一個"),
      taskGid: z.string().nullable().optional().describe("這張票所屬的 worktree，跟 worktreeId 至少帶一個"),
      note: z.string().describe("中斷原因，會用在安全 commit 的 commit message 裡"),
    },
    async ({ worktreeId, taskGid, note }) => {
      const entry = await resolveEntryOrThrow(worktreeId, taskGid);
      const dirty = await getPorcelainStatus(entry.worktreePath);
      if (dirty.length > 0) {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        await execFileAsync("git", ["add", "-A"], { cwd: entry.worktreePath });
        await execFileAsync("git", ["commit", "-m", `[abandon_ticket_round 安全備份] ${note}`], { cwd: entry.worktreePath });
      }
      const updated = await updateWorktreeEntry(entry.id, { status: "abandoned" });
      return textResult({ success: true, worktree: updated, safetyCommitted: dirty.length > 0 });
    }
  );

  server.tool(
    "finalize_ticket_worktree",
    "所有併入這個 worktree 的票單都已經 record_confirmation({confirmed:true}) 之後，正式清除這個 worktree 資料夾＋分支。" +
      "**dryRun 預設 true**（設計上線初期的安全網）——只回報「如果真的執行會做什麼」，不會真的動手；確認沒問題後再帶 dryRun:false 執行。",
    {
      worktreeId: z.string().describe("要清除的 worktree id"),
      dryRun: z.boolean().optional().describe("預設 true，只模擬不執行；帶 false 才會真的刪除 worktree 資料夾與分支"),
    },
    async ({ worktreeId, dryRun }) => {
      const entry = await findWorktreeById(worktreeId);
      if (!entry) {
        return textResult({ success: false, message: `找不到 worktree id "${worktreeId}"。` }, true);
      }
      const unconfirmed: string[] = [];
      for (const gid of entry.ticketGids) {
        const status = await readStatus(gid);
        if (status.confirmation?.confirmed !== true) unconfirmed.push(gid);
      }
      if (unconfirmed.length > 0) {
        return textResult(
          {
            success: false,
            message: `還有票單沒有 record_confirmation({confirmed:true})，不能清除這個 worktree：${unconfirmed.join("、")}`,
            unconfirmedTicketGids: unconfirmed,
          },
          true
        );
      }

      const willDryRun = dryRun !== false;
      if (willDryRun) {
        return textResult({
          success: true,
          dryRun: true,
          message: `模擬結果：會刪除 worktree 資料夾 ${entry.worktreePath}、刪除分支 ${entry.branch}，並從追蹤紀錄移除。確認沒問題後帶 dryRun:false 重新呼叫。`,
          worktree: entry,
        });
      }

      const removeResult = await worktreeRemove(entry.gitRoot, entry.worktreePath, false);
      if (removeResult.code !== 0) {
        return textResult(
          {
            success: false,
            message: `git worktree remove 失敗（常見原因：IDE 還開著這個資料夾造成檔案鎖定，Windows 下尤其常見）：\n${removeResult.stderr || removeResult.stdout}`,
          },
          true
        );
      }
      const deleteResult = await deleteBranch(entry.gitRoot, entry.branch, false);
      if (deleteResult.code !== 0) {
        return textResult(
          {
            success: false,
            message: `worktree 資料夾已刪除，但刪分支 ${entry.branch} 失敗（worktree 資料夾已經刪了，不會重試 worktree remove，請人工確認分支狀態）：\n${deleteResult.stderr || deleteResult.stdout}`,
          },
          true
        );
      }
      await removeWorktreeEntry(entry.id);
      return textResult({ success: true, dryRun: false, removed: entry });
    }
  );

  server.tool(
    "list_worktrees",
    "列出目前所有登記在案的 worktree（不論 active/abandoned），並跟 git 自己的 `worktree list` 交叉比對，標出兩邊對不起來的項目（例如資料夾被人手動刪掉但紀錄還在，或反過來）。用來做定期健檢/找閒置 worktree。",
    {},
    async () => {
      const entries = await listWorktreeEntries();
      const byGitRoot = new Map<string, WorktreeEntry[]>();
      for (const e of entries) {
        byGitRoot.set(e.gitRoot, [...(byGitRoot.get(e.gitRoot) ?? []), e]);
      }
      const driftNotes: string[] = [];
      for (const [gitRoot, list] of byGitRoot) {
        const real = await listGitWorktrees(gitRoot).catch(() => []);
        const realPaths = new Set(real.map((r) => path.resolve(r.path)));
        for (const e of list) {
          if (!realPaths.has(path.resolve(e.worktreePath))) {
            driftNotes.push(`${e.id}：追蹤紀錄裡有，但 ${gitRoot} 底下 git worktree list 找不到對應資料夾——可能被人手動刪除，需要人工核對。`);
          }
        }
      }
      return textResult({ success: true, count: entries.length, worktrees: entries, driftNotes });
    }
  );
}
