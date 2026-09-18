import path from "node:path";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textResult } from "./shared.js";
import { getGitHooksDir } from "./config-store.js";
import { resolveGitRoots } from "./git-roots-store.js";
import { setCoreHooksPath } from "./git-utils.js";
import { resolveHttpBridgeHost, resolveHttpBridgePort } from "./http-bridge-config.js";

/**
 * 兩個 hook 檔名共用同一份內容——用 `$(basename "$0")` 自己判斷是被哪個 hook 呼叫。
 * 刻意最小化：只帶 gitRoot + event 打回本機 HTTP bridge，bridge 沒開（沒有 Claude Code session 連著）
 * 就直接失敗略過（curl -m 2 逾時＋ || true），不影響原本的 git commit/merge 動作本身。
 * 這份腳本內容由 install_git_hooks 寫入 getGitHooksDir()，刻意放在這個 MCP 自己的資料目錄，
 * 不進客戶專案版控——避免變成可以被惡意 commit 竄改的攻擊面。
 */
function buildHookScript(): string {
  const host = resolveHttpBridgeHost();
  const port = resolveHttpBridgePort();
  return `#!/bin/sh
# dev-pipeline-mcp 自動安裝的 git 原生 hook —— 由 install_git_hooks 產生，不要手動編輯，下次安裝會覆寫。
# 不管透過哪個 AI/CLI 或人手動 commit/merge 都躲不掉，用來讓跨 worktree 檔案重疊示警即時失效重算，
# 並留下稽核紀錄供事後比對是否繞過了 merge_ticket_worktree。見 project_dev_pipeline_worktree_design 記憶。
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
EVENT="$(basename "$0")"
curl -s -m 2 -X POST "http://${host}:${port}/git-hook-event" \\
  -H "Content-Type: application/json" \\
  -d "{\\"gitRoot\\":\\"$REPO_ROOT\\",\\"event\\":\\"$EVENT\\"}" \\
  >/dev/null 2>&1 || true
exit 0
`;
}

export function registerGitHookTools(server: McpServer): void {
  server.tool(
    "install_git_hooks",
    "把 git 原生 hook（post-commit/post-merge）安裝到 projectDir 已登記的每一個 git 根目錄，透過 `git config core.hooksPath` 指向這個 MCP 自己管理的共用 hooks 資料夾（絕不寫進客戶專案版控）。" +
      "**這是防止有人（或哪個 AI/CLI）直接改動受追蹤專案卻繞過 dev-pipeline-mcp 工具的核心防線**——不管透過什麼工具 commit/merge，git 自己一定會觸發這個 hook，通知本機 HTTP bridge 立刻讓跨 worktree 檔案重疊示警（activeWarnings）失效重算，並留下稽核紀錄（`data/git-hook-events.log`）供事後比對。" +
      "**每個受追蹤的 git 根目錄建議都安裝一次**，重複呼叫是安全的（會覆寫成最新版腳本、重設 core.hooksPath，冪等）。" +
      "沒開 Claude Code session（bridge 沒啟動）時，hook 會直接安靜失敗略過，不影響原本的 commit/merge 動作本身。",
    {
      projectDir: z.string().describe("要安裝 hook 的專案目錄（用它已登記的 git 根目錄，見 register_git_roots）"),
    },
    async ({ projectDir }) => {
      const roots = await resolveGitRoots(projectDir);
      if (!roots || roots.length === 0) {
        return textResult(
          { success: false, message: `${projectDir} 還沒登記過 git 版控根目錄，請先呼叫 register_git_roots。` },
          true
        );
      }

      const hooksDir = getGitHooksDir();
      await mkdir(hooksDir, { recursive: true });
      const script = buildHookScript();
      for (const name of ["post-commit", "post-merge"]) {
        const filePath = path.join(hooksDir, name);
        await writeFile(filePath, script, "utf-8");
        await chmod(filePath, 0o755).catch(() => {
          // Windows 上 chmod 通常是 no-op——git bash 執行 hook 靠 shebang，不靠檔案的執行位元
        });
      }

      const results = [];
      for (const root of roots) {
        const result = await setCoreHooksPath(root.path, hooksDir);
        results.push({
          label: root.label,
          path: root.path,
          ok: result.code === 0,
          message: result.code === 0 ? "已設定 core.hooksPath" : result.stderr || result.stdout,
        });
      }

      return textResult({ success: results.every((r) => r.ok), hooksDir, results });
    }
  );
}
