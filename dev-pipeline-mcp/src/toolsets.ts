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

/**
 * 可關閉的工具群組：用環境變數 DEV_PIPELINE_DISABLE_TOOLSETS（逗號分隔）列出不要註冊的群組，
 * 目的是縮小 tools/list 送進 AI 上下文的量。預設全部註冊。
 */
export const TOOLSET_NAMES = ["worktree", "bridge"] as const;
export type ToolsetName = (typeof TOOLSET_NAMES)[number];

export interface DisabledToolsets {
  disabled: Set<ToolsetName>;
  unknown: string[];
}

export function parseDisabledToolsets(envValue: string | undefined): DisabledToolsets {
  const disabled = new Set<ToolsetName>();
  const unknown: string[] = [];
  for (const raw of (envValue ?? "").split(",")) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    if ((TOOLSET_NAMES as readonly string[]).includes(name)) disabled.add(name as ToolsetName);
    else if (!unknown.includes(name)) unknown.push(name);
  }
  return { disabled, unknown };
}

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
