import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPipelineInfoTools } from "./pipeline-info-tools.js";
import { registerTicketSnapshotTools } from "./ticket-snapshot-tools.js";
import { registerProjectConfigTools } from "./project-config-tools.js";
import { registerSdDocTools } from "./sd-doc-tools.js";
import { registerTestGuideTools } from "./test-guide-tools.js";
import { registerBridgeTools } from "./bridge-tools.js";
import { registerProjectFsTools } from "./project-fs-tools.js";
import { registerTicketLifecycleTools } from "./ticket-lifecycle-tools.js";
import { registerTicketArtifactTools } from "./ticket-artifact-tools.js";
import { registerWorktreeTools } from "./worktree-tools.js";
import { registerGitHookTools } from "./git-hooks-tools.js";
import { registerRuleHistoryTools } from "./rule-history-tools.js";
import { installActiveWarnings } from "./active-warnings.js";
import type { ToolsetName } from "./toolset-config.js";

export { TOOLSET_NAMES, parseDisabledToolsets, bridgeDisabledNote } from "./toolset-config.js";
export type { ToolsetName, DisabledToolsets } from "./toolset-config.js";

/**
 * 註冊所有工具；disabledToolsets 內的群組整組不註冊。
 * 其他模組（pending-actions-sync、ticket-*）是直接呼叫 mcp-clients 的函式，不依賴這些工具是否已註冊，所以關閉不影響內部流程。
 */
export function registerAllTools(server: McpServer, disabledToolsets: ReadonlySet<ToolsetName> = new Set()): void {
  // 必須在任何 registerXxxTools 之前安裝——它攔截 server.tool 本身，讓之後註冊的每一個工具回應都自動
  // 附加 activeWarnings（跨 worktree 檔案重疊示警），見 active-warnings.ts 開頭說明。
  // worktree 群組關閉時不會有人建立 worktree，示警沒有意義，連同每次呼叫的 git 檢查一起省掉。
  if (!disabledToolsets.has("worktree")) installActiveWarnings(server);

  registerPipelineInfoTools(server);
  registerTicketSnapshotTools(server);
  registerProjectConfigTools(server);
  registerSdDocTools(server);
  registerTestGuideTools(server);
  if (!disabledToolsets.has("bridge")) registerBridgeTools(server);
  registerProjectFsTools(server);
  registerTicketLifecycleTools(server);
  registerTicketArtifactTools(server);
  if (!disabledToolsets.has("worktree")) {
    registerWorktreeTools(server);
    registerGitHookTools(server);
  }
  registerRuleHistoryTools(server);
}
