import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import { stat } from "node:fs/promises";
import { GATES_FILE_CANDIDATES } from "./project-rule-files.js";
import { callSvnTool } from "./mcp-clients.js";
import { isNoSaPlaceholder, requiresSvnConnection, verifySvnRoots } from "./sasd-path-check.js";
import { resolveGitRoots, registerGitRoots, type GitRootEntry } from "./git-roots-store.js";
import { resolveSvnWorkCopies, registerSvnWorkCopies, type SvnWorkCopyEntry } from "./svn-workcopy-store.js";
import { loadWorkCopyClient } from "./svn-workcopy-bridge.js";
import {
  resolveSasdConfig,
  registerSasdConfig,
  resolveDefaultProject,
  registerDefaultProject,
  resolveProjectDir,
  registerProjectDir,
  resolveLegacyTestProfile,
  registerLegacyTestProfile,
  resolveTestCapability,
  registerTestCapability,
} from "./project-registry.js";
import { textResult } from "./shared.js";
import { SETUP_DEFAULT_PROJECT, SETUP_GIT_ROOTS, SETUP_PROJECT_DIR, SETUP_SASD_CONFIG } from "./overview-prompts.js";

const GATES_HINT =
  "這個專案目錄還沒有 gates.json（沒有任何機械式關卡）。如果想強制工程師的 02-implementation.md 一定要有標題含「查重」的一節，可以把 dev-pipeline-mcp 的 templates/gates.example.json 複製到 <projectDir>/.pipeline/gates.json；這只是提示，要不要啟用請問使用者，不要自己複製。";

async function hasGatesFile(projectDir: string): Promise<boolean> {
  for (const relPath of GATES_FILE_CANDIDATES) {
    try {
      await stat(path.join(projectDir, relPath));
      return true;
    } catch (err: any) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 各 kind 的欄位定義（resolve / register 各一份）。以 kind 為索引逐一驗證，
// 缺欄位時錯誤訊息會指出是哪個 kind 的哪個 action 缺什麼。
// ---------------------------------------------------------------------------

const projectGidField = z.string();
const projectDirField = z.string();

const resolveSchemas = {
  default_project: z.object({ cwd: z.string().nullable().optional() }),
  project_dir: z.object({ projectGid: projectGidField }),
  sasd_config: z.object({ projectGid: projectGidField }),
  legacy_test_profile: z.object({ projectGid: projectGidField }),
  test_capability: z.object({ projectGid: projectGidField }),
  git_roots: z.object({ projectDir: projectDirField }),
  svn_workcopies: z.object({ projectDir: projectDirField }),
} as const;

const registerSchemas = {
  default_project: z.object({
    workspaceGid: z.string(),
    projectGid: projectGidField,
    projectName: z.string(),
    cwd: z.string().nullable().optional(),
  }),
  project_dir: z.object({ projectGid: projectGidField, projectDir: z.string() }),
  sasd_config: z.object({
    projectGid: projectGidField,
    saRoot: z.string(),
    sdMode: z.enum(["external", "self", "self-generated", "unregistered"]),
    sdRoot: z.string().nullable().optional(),
    svnConnectionId: z.string().nullable().optional(),
    sdOutputPath: z.string().nullable().optional(),
    specOrder: z.enum(["spec_first", "code_first"]).nullable().optional(),
  }),
  legacy_test_profile: z.object({ projectGid: projectGidField, legacyTestProfile: z.boolean() }),
  test_capability: z.object({
    projectGid: projectGidField,
    mode: z.enum(["modern", "legacy_junit4", "none"]),
    note: z.string().nullable().optional(),
  }),
  git_roots: z.object({
    projectDir: projectDirField,
    gitRoots: z.array(z.object({ label: z.string(), path: z.string() })).min(1),
  }),
  svn_workcopies: z.object({
    projectDir: projectDirField,
    workCopies: z.array(z.object({ label: z.string(), workCopyPath: z.string(), connectionId: z.string() })).min(1),
  }),
} as const;

export const PROJECT_CONFIG_KINDS = [
  "default_project",
  "project_dir",
  "sasd_config",
  "legacy_test_profile",
  "test_capability",
  "git_roots",
  "svn_workcopies",
] as const;
export type ProjectConfigKind = (typeof PROJECT_CONFIG_KINDS)[number];

const PROJECT_CONFIG_DESCRIPTION =
  "專案層級設定單一入口：action=resolve 查詢／register 登記；依 kind 帶欄位（見參數說明）。default_project register 一律帶 cwd。" +
  "sasd_config 的 sdMode：external（SD 由別人產，不可建議修改 SD）｜self｜self-generated（AI 維護 sdOutputPath 的文件，用 read/write_project_sd_doc；sdOutputPath 與 specOrder 必填，**一定要先問使用者、不要預設**）｜unregistered（逐票詢問）；**external/self 或 saRoot 為 SVN 真實路徑（非 N/A 占位）時必帶 svnConnectionId，會真的驗證連線並用 svn_browse 確認 saRoot／sdRoot（正斜線、相對 repo 根）存在，失敗就拒絕登記**。" +
  "legacy_test_profile 預設 false 不用問；test_capability 找不到（found:false）時工程師第一次動手前問使用者一次；**這兩者只有使用者主動告知才 register，不要依程式碼猜**。" +
  "git_roots：run_project_shell 執行 git 前必須已登記。" +
  "svn_workcopies：**上傳/更新/刪除只能由使用者在網頁按按鈕，AI 沒有任何工具能修改 SVN**，此 kind 只存設定；只有使用者主動告知才 register、不要猜路徑；登記前對每份 svn status 驗證，不過整批不登記，且整份覆寫原登記。" +
  "resolve 找不到時多數 kind 回傳 needsInput 與 instructions，照做後呼叫 register。";

/** 把 zod 驗證錯誤整理成「哪個 kind 的哪個 action 缺什麼／錯什麼」。 */
function formatConfigError(kind: string, action: string, error: z.ZodError): string {
  const problems = error.issues.map((issue) => {
    const field = issue.path.join(".") || "(參數)";
    if (issue.code === "invalid_type" && issue.received === "undefined") return `缺少欄位 ${field}`;
    return `欄位 ${field} 不合法：${issue.message}`;
  });
  return `project_config(kind="${kind}", action="${action}") 參數錯誤：${problems.join("；")}。各 kind 需要的欄位請見工具說明。`;
}

async function resolveConfig<K extends ProjectConfigKind>(kind: K, a: z.infer<(typeof resolveSchemas)[K]>) {
  const args = a as any;
  switch (kind) {
    case "project_dir": {
      const projectDir = await resolveProjectDir(args.projectGid);
      if (projectDir) return textResult({ found: true, projectDir });
      return textResult({ found: false, needsInput: true, instructions: SETUP_PROJECT_DIR });
    }
    case "sasd_config": {
      const config = await resolveSasdConfig(args.projectGid);
      if (config) return textResult({ found: true, ...config });
      return textResult({ found: false, needsInput: true, instructions: SETUP_SASD_CONFIG });
    }
    case "default_project": {
      const project = await resolveDefaultProject(args.cwd);
      if (project) return textResult({ found: true, ...project });
      return textResult({ found: false, needsInput: true, instructions: SETUP_DEFAULT_PROJECT });
    }
    case "legacy_test_profile":
      return textResult({ legacyTestProfile: await resolveLegacyTestProfile(args.projectGid) });
    case "test_capability": {
      const config = await resolveTestCapability(args.projectGid);
      if (!config) return textResult({ found: false });
      return textResult({ found: true, ...config });
    }
    case "git_roots": {
      const gitRoots = await resolveGitRoots(args.projectDir);
      return textResult(gitRoots ? { found: true, gitRoots } : { found: false, needsInput: true, instructions: SETUP_GIT_ROOTS });
    }
    case "svn_workcopies": {
      const workCopies = await resolveSvnWorkCopies(args.projectDir);
      return textResult(workCopies ? { found: true, workCopies } : { found: false });
    }
  }
}

const SASD_RETRY_HINT = 'project_config({ kind: "sasd_config", action: "register", ... })';

async function registerSasd(a: z.infer<(typeof registerSchemas)["sasd_config"]>) {
  const { projectGid, saRoot, sdMode, sdRoot, svnConnectionId, sdOutputPath, specOrder } = a;
  if (sdMode === "self-generated" && !sdOutputPath) {
    return textResult(
      { success: false, message: "sdMode 是 self-generated 時必須提供 sdOutputPath——請先問使用者「AI 產出的 SD 規格要放在本機哪個目錄/檔案」，再重新呼叫。" },
      true
    );
  }
  if (sdMode === "self-generated" && !specOrder) {
    return textResult(
      {
        success: false,
        message:
          "sdMode 是 self-generated 時必須提供 specOrder——請先問使用者「這個專案要先產規格再產 code，還是先產 code 再補規格」，得到 \"spec_first\" 或 \"code_first\" 之後再重新呼叫。",
      },
      true
    );
  }
  if (requiresSvnConnection(sdMode, saRoot) && !svnConnectionId) {
    return textResult(
      {
        success: false,
        message:
          "必須提供 svnConnectionId：sdMode 是 external/self，或 saRoot 是 SVN 上的真實路徑（分析師一定要到 SVN 讀 SA，沒連線就讀不到）時都要——請先用 svn_find_repo（用使用者說的專案名稱搜尋）或 svn_list_connections 確認可用的連線，問清楚使用者要用哪一個，再重新呼叫。若這個專案真的沒有 SA 文件，saRoot 請填 N/A 開頭的占位（例如 \"N/A-無SA文件\"）。",
      },
      true
    );
  }
  if (svnConnectionId) {
    const testResult = await callSvnTool("svn_test_connection", { connectionId: svnConnectionId });
    if (!testResult?.success) {
      return textResult(
        {
          success: false,
          message: `SVN 連線驗證失敗，拒絕登記：${testResult?.message ?? "未知錯誤"}。請先跟使用者確認 SVN 連線設定（帳密、URL、網路/VPN），連得上再重新呼叫 ${SASD_RETRY_HINT}。`,
        },
        true
      );
    }
    const roots = [
      ...(isNoSaPlaceholder(saRoot) ? [] : [{ field: "saRoot" as const, value: saRoot }]),
      ...(sdRoot ? [{ field: "sdRoot" as const, value: sdRoot }] : []),
    ];
    const rootProblem = await verifySvnRoots(svnConnectionId, roots, (args) => callSvnTool("svn_browse", args));
    if (rootProblem) return textResult({ success: false, message: `拒絕登記：${rootProblem}` }, true);
  }
  const resolvedSpecOrder = sdMode === "self-generated" ? specOrder ?? null : null;
  await registerSasdConfig(projectGid, {
    saRoot,
    sdMode,
    sdRoot: sdRoot ?? null,
    sdOutputPath: sdOutputPath ?? null,
    svnConnectionId: svnConnectionId ?? null,
    specOrder: resolvedSpecOrder,
  });
  return textResult({
    success: true,
    projectGid,
    saRoot,
    sdMode,
    sdRoot: sdRoot ?? null,
    sdOutputPath: sdOutputPath ?? null,
    svnConnectionId: svnConnectionId ?? null,
    specOrder: resolvedSpecOrder,
  });
}

async function registerSvnWorkcopies(a: z.infer<(typeof registerSchemas)["svn_workcopies"]>) {
  const { projectDir, workCopies } = a;
  try {
    const client = await loadWorkCopyClient();
    for (const wc of workCopies) {
      await client.wcStatus({ workCopyPath: wc.workCopyPath, connectionId: wc.connectionId });
    }
    await registerSvnWorkCopies(projectDir, workCopies as SvnWorkCopyEntry[]);
  } catch (err: any) {
    return textResult({ success: false, message: `沒有登記：${err?.message ?? String(err)}` }, true);
  }
  return textResult({ success: true, projectDir, workCopies });
}

async function registerConfig<K extends ProjectConfigKind>(kind: K, a: z.infer<(typeof registerSchemas)[K]>) {
  const args = a as any;
  switch (kind) {
    case "project_dir": {
      const absDir = path.resolve(args.projectDir);
      await registerProjectDir(args.projectGid, absDir);
      const gatesHint = (await hasGatesFile(absDir)) ? undefined : GATES_HINT;
      return textResult({ success: true, projectGid: args.projectGid, projectDir: absDir, ...(gatesHint ? { gatesHint } : {}) });
    }
    case "sasd_config":
      return registerSasd(args);
    case "default_project": {
      const { workspaceGid, projectGid, projectName, cwd } = args;
      await registerDefaultProject({ workspaceGid, projectGid, projectName }, cwd);
      return textResult({ success: true, workspaceGid, projectGid, projectName, cwd: cwd ?? null });
    }
    case "legacy_test_profile":
      await registerLegacyTestProfile(args.projectGid, args.legacyTestProfile);
      return textResult({ success: true, projectGid: args.projectGid, legacyTestProfile: args.legacyTestProfile });
    case "test_capability":
      await registerTestCapability(args.projectGid, { mode: args.mode, note: args.note ?? null });
      return textResult({ success: true, projectGid: args.projectGid, mode: args.mode, note: args.note ?? null });
    case "git_roots":
      await registerGitRoots(args.projectDir, args.gitRoots as GitRootEntry[]);
      return textResult({ success: true, projectDir: args.projectDir, gitRoots: args.gitRoots });
    case "svn_workcopies":
      return registerSvnWorkcopies(args);
  }
}

/** 依 kind/action 驗證並分派。 */
export async function handleProjectConfig(args: { kind: ProjectConfigKind; action: "resolve" | "register" } & Record<string, unknown>) {
  const { kind, action } = args;
  const schema = action === "resolve" ? resolveSchemas[kind] : registerSchemas[kind];
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return textResult({ success: false, message: formatConfigError(kind, action, parsed.error) }, true);
  }
  return action === "resolve" ? resolveConfig(kind, parsed.data as any) : registerConfig(kind, parsed.data as any);
}

export function registerProjectConfigTools(server: McpServer): void {
  server.tool(
    "project_config",
    PROJECT_CONFIG_DESCRIPTION,
    {
      kind: z.enum(PROJECT_CONFIG_KINDS).describe("設定種類"),
      action: z.enum(["resolve", "register"]).describe("resolve=查詢、register=登記"),
      projectGid: z.string().optional().describe("Asana 專案 gid（git_roots／svn_workcopies 以外都要）"),
      projectDir: z.string().optional().describe("專案目錄絕對路徑（project_dir register、git_roots、svn_workcopies）"),
      cwd: z.string().nullable().optional().describe("default_project：工作目錄絕對路徑（一律帶）"),
      workspaceGid: z.string().optional().describe("default_project register 必填：工作區 gid"),
      projectName: z.string().optional().describe("default_project register 必填：專案名稱"),
      saRoot: z.string().optional().describe("sasd_config register 必填：SA 位置（SVN 相對 repo 根，或 N/A 開頭占位）"),
      sdMode: z.enum(["external", "self", "self-generated", "unregistered"]).optional().describe("sasd_config register 必填：SD 模式"),
      sdRoot: z.string().nullable().optional().describe("SD 位置，僅 external/self 需要"),
      svnConnectionId: z.string().nullable().optional().describe("saRoot/sdRoot 的 SVN 連線 id"),
      sdOutputPath: z.string().nullable().optional().describe("self-generated 的 SD 本機路徑（相對 projectDir），先問使用者"),
      specOrder: z.enum(["spec_first", "code_first"]).nullable().optional().describe("self-generated 必填：spec_first｜code_first"),
      legacyTestProfile: z.boolean().optional().describe("legacy_test_profile register 必填"),
      mode: z.enum(["modern", "legacy_junit4", "none"]).optional().describe("test_capability register 必填：modern｜legacy_junit4｜none"),
      note: z.string().nullable().optional().describe("test_capability：legacy_junit4 時寫 JDK 與工具鏈版本"),
      gitRoots: z
        .array(z.object({ label: z.string(), path: z.string() }))
        .optional()
        .describe("git_roots register：[{label, path}]，至少一筆"),
      workCopies: z
        .array(z.object({ label: z.string(), workCopyPath: z.string(), connectionId: z.string() }))
        .optional()
        .describe("svn_workcopies register：[{label, workCopyPath, connectionId}]，至少一筆"),
    },
    async (args) => handleProjectConfig(args)
  );
}
