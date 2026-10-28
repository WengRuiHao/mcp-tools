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
    throw new Error(`${status.project_dir} 還沒登記過 git 版控根目錄，請先呼叫 project_config(kind='git_roots', action='register')。`);
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
    "為一張（或一組）票單建立獨立 git worktree，隔離多個 AI/session 併行處理時的互相干擾。" +
      "**一個 worktree 綁定一組票號**：要併入另一張已有 worktree 的票，改呼叫 join_ticket_worktree，不要重複建立。" +
      "以已登記 git 根目錄目前 checkout 的分支為來源切出新分支＋worktree，建在 git 根目錄上一層 `.worktrees/<票號>/`。" +
      "**只建立追蹤資料，不複製程式碼**，後續編輯回傳的 worktreePath。已有 worktree 涵蓋此票時回傳既有資訊（冪等）。",
    {
      taskGid: z.string().describe("任務 gid"),
      gitRootLabel: z
        .string()
        .nullable()
        .optional()
        .describe("project_dir 登記多個 git 根目錄時指定用哪一個（git_roots 的 label）"),
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
    "把另一張票併入既有 worktree 分組（同一次改動合併進同一個 commit）。之後該 worktree 的每輪合併、清除，都要等這些票全部確認結案。",
    {
      worktreeId: z.string().describe("既有 worktree id（create_ticket_worktree 回傳的 worktree.id）"),
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
    "查詢 worktree 目前真實狀態：實際改動的檔案、來源分支有沒有領先（決定要不要先 rebase）。" +
      "改動檔案清單是聯集：`git status --porcelain`（未 commit）＋與 `baseCommit` 的 diff（已 commit 未合併）。",
    {
      worktreeId: z.string().nullable().optional().describe("worktree id，與 taskGid 至少帶一個"),
      taskGid: z.string().nullable().optional().describe("票所屬的 worktree，與 worktreeId 至少帶一個"),
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
    "完成這一輪：視情況把 worktree 分支 rebase 到來源分支最新，再合併回來源分支（**只更新 git 根目錄的本機分支，絕不 push**）；worktree 不刪，下一輪沿用。" +
      "只有來源分支領先才 rebase，否則直接快轉合併。**衝突時不自動選邊或 abort**：回傳 conflict:true 並停在衝突狀態，需人工/AI 解決並 `git add`、`git rebase --continue` 或 `git commit`，下次呼叫前先確認已清乾淨。" +
      "呼叫前須先自行 commit worktree 內的異動。",
    {
      worktreeId: z.string().nullable().optional().describe("worktree id，與 taskGid 至少帶一個"),
      taskGid: z.string().nullable().optional().describe("票所屬的 worktree，與 worktreeId 至少帶一個"),
      mergeMessage: z.string().describe("合併 commit message，建議列出這輪所有票號"),
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
    "中斷一輪還沒合併的 worktree 工作（如做到一半發現方向錯了）。先把目前異動安全 commit，分支留作備份，**不會刪除 worktree 或分支**，只標記 abandoned，之後不再用來續下一輪。",
    {
      worktreeId: z.string().nullable().optional().describe("worktree id，與 taskGid 至少帶一個"),
      taskGid: z.string().nullable().optional().describe("票所屬的 worktree，與 worktreeId 至少帶一個"),
      note: z.string().describe("中斷原因（用於安全 commit 的訊息）"),
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
    "併入此 worktree 的票全部 record_confirmation({confirmed:true}) 之後，正式清除 worktree 資料夾＋分支。" +
      "**dryRun 預設 true**——只回報會做什麼、不動手；確認沒問題再帶 dryRun:false 執行。",
    {
      worktreeId: z.string().describe("要清除的 worktree id"),
      dryRun: z.boolean().optional().describe("預設 true 只模擬；false 才真的刪除資料夾與分支"),
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
    "列出所有登記的 worktree（active/abandoned），與 git `worktree list` 交叉比對，標出兩邊不一致的項目（如資料夾被手動刪但紀錄還在）。用於定期健檢/找閒置 worktree。",
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
