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

/** 流程說明裡提到的 svn_*／get_ticket_activity 等橋接工具在 bridge 群組關閉時不存在，只有這時才附上替代指引，預設輸出不增加字數。 */
export function bridgeDisabledNote(envValue: string | undefined = process.env.DEV_PIPELINE_DISABLE_TOOLSETS): string | null {
  if (!parseDisabledToolsets(envValue).disabled.has("bridge")) return null;
  return (
    "（注意：本 MCP 的 bridge 工具群組已關閉。文中提到的 svn_list_connections／svn_test_connection／svn_browse／svn_cat／svn_doc_images／svn_log、" +
    "get_ticket_activity、download_ticket_attachment、get_recent_commits 在這裡不存在；請改用另外連線的 svn-mcp 的 svn_* 工具、" +
    "asana-mcp 的 asana_task_activity／asana_task_comments／asana_download_attachment，以及 git 指令。）"
  );
}
