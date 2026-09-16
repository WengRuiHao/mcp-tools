import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import { callSvnTool } from "./mcp-clients.js";
import { resolveGitRoots, registerGitRoots, type GitRootEntry } from "./git-roots-store.js";
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

export function registerProjectConfigTools(server: McpServer): void {
  server.tool(
    "resolve_project_dir",
    "查詢這個 Asana 專案是否已經登記過對應的本機/伺服器程式碼目錄。找到就直接回傳 projectDir，不用再問使用者；找不到則回傳 needsInput，呼叫端要自己想辦法取得目錄後呼叫 register_project_dir。",
    { projectGid: z.string().describe("Asana 專案 gid") },
    async ({ projectGid }) => {
      const projectDir = await resolveProjectDir(projectGid);
      if (projectDir) return textResult({ found: true, projectDir });
      return textResult({ found: false, needsInput: true });
    }
  );

  server.tool(
    "register_project_dir",
    "把使用者提供的專案目錄，登記為某個 Asana 專案的對應關係，之後同一個 Asana 專案的票都不用再問。",
    {
      projectGid: z.string().describe("Asana 專案 gid"),
      projectDir: z.string().describe("使用者提供的程式碼目錄（絕對路徑）"),
    },
    async ({ projectGid, projectDir }) => {
      const absDir = path.resolve(projectDir);
      await registerProjectDir(projectGid, absDir);
      return textResult({ success: true, projectGid, projectDir: absDir });
    }
  );

  server.tool(
    "resolve_sasd_config",
    "查詢這個 Asana 專案的 SA/SD 規格設定（SA 存放位置、SD 的模式與位置，sdMode 是 \"self-generated\" 時還會附上 specOrder：\"spec_first\" 或 \"code_first\"）。找到就直接用，不用再問使用者；找不到則回傳 needsInput，呼叫端要照 get_pipeline_overview 的說明問完整套問題後呼叫 register_sasd_config。這是每個 Asana 專案只需要設定一次的東西，不是每張票都要問——除非 sdMode 是 \"unregistered\"，那種情況才需要逐票詢問。",
    { projectGid: z.string().describe("Asana 專案 gid") },
    async ({ projectGid }) => {
      const config = await resolveSasdConfig(projectGid);
      if (config) return textResult({ found: true, ...config });
      return textResult({ found: false, needsInput: true });
    }
  );

  server.tool(
    "register_sasd_config",
    "登記某個 Asana 專案的 SA/SD 規格設定。sdMode 有四種：" +
      "\"external\"（SD 是別人/客戶產的，只能讀取當作依據，絕對不能建議修改 SD 本身，只能調整程式碼）、" +
      "\"self\"（SD 是我方產的，判斷需要調整時可以在驗證/實作報告裡明確建議修改段落，但因為 SVN 是唯讀的，不能直接寫回去，要交由人工事後更新）、" +
      "\"self-generated\"（沒有既有 SD，AI 自己維護一份 living document，之後可以用 read_project_sd_doc/write_project_sd_doc 真的讀寫這份文件——**這份文件會寫在 sdOutputPath 指定的真實本機路徑**，不是藏在這個 MCP 自己的安裝目錄裡，方便使用者事後直接把這個檔案傳到 SVN；還要多問一題決定 specOrder，見下方）、" +
      "\"unregistered\"（沒有登記 SD 位置也不自動產生，之後每一張票都要單獨詢問使用者這張票有沒有對應 SD，不會被這裡的設定省略掉）。" +
      "**\"external\"/\"self\" 一定要帶 svnConnectionId，而且這個工具會真的呼叫 svn_test_connection 驗證連得上才會登記成功**——saRoot/sdRoot 是 SVN 上的正式路徑，連不上 SVN 就沒辦法確認規格內容，不能假設之後會自己通。",
    {
      projectGid: z.string().describe("Asana 專案 gid"),
      saRoot: z.string().describe("SA 規格存放位置，SVN 上的正式路徑（例如 \"doc/sa\"，相對於 svnConnectionId 對應 repo 的根目錄）"),
      sdMode: z.enum(["external", "self", "self-generated", "unregistered"]).describe("SD 規格的模式"),
      sdRoot: z.string().nullable().optional().describe("SD 規格存放位置，只有 sdMode 是 external 或 self 時才需要"),
      svnConnectionId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "saRoot/sdRoot 所在的 SVN 連線（svn_list_connections 回傳的 id 或 name），只有 sdMode 是 \"external\" 或 \"self\" 時才需要。" +
            "這個工具會真的呼叫 svn_test_connection 驗證連得上，連不上會拒絕登記。"
        ),
      sdOutputPath: z
        .string()
        .nullable()
        .optional()
        .describe(
          "AI 產出的 SD 規格要寫入的本機檔案路徑（相對於 projectDir），只有 sdMode 是 \"self-generated\" 時才需要。" +
            "這是使用者準備之後要傳到 SVN 的真實檔案位置，一定要先問使用者，不要自己隨便挑一個路徑。"
        ),
      specOrder: z
        .enum(["spec_first", "code_first"])
        .nullable()
        .optional()
        .describe(
          "只有 sdMode 是 \"self-generated\" 時才需要，必填：\"spec_first\"（先由規格撰寫者產出/確認 SD 草稿，工程師才動手寫程式碼，這是原本唯一支援的順序）或 " +
            "\"code_first\"（工程師先依分析師的結論直接寫程式碼，規格撰寫者事後依實際改動反推補一份 SD 草稿，一樣要經過使用者 record_spec_confirmation 確認才能讓票單推進到 verified）。" +
            "一定要先問使用者要哪一種，不要自己預設，問過一次之後這個專案往後每一張票都會沿用同一個順序。"
        ),
    },
    async ({ projectGid, saRoot, sdMode, sdRoot, svnConnectionId, sdOutputPath, specOrder }) => {
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
      if ((sdMode === "external" || sdMode === "self") && !svnConnectionId) {
        return textResult(
          { success: false, message: "sdMode 是 external/self 時必須提供 svnConnectionId——請先呼叫 svn_list_connections 確認可用的連線，問清楚使用者要用哪一個，再重新呼叫。" },
          true
        );
      }
      if (svnConnectionId) {
        const testResult = await callSvnTool("svn_test_connection", { connectionId: svnConnectionId });
        if (!testResult?.success) {
          return textResult(
            {
              success: false,
              message: `SVN 連線驗證失敗，拒絕登記：${testResult?.message ?? "未知錯誤"}。請先跟使用者確認 SVN 連線設定（帳密、URL、網路/VPN），連得上再重新呼叫 register_sasd_config。`,
            },
            true
          );
        }
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
  );

  server.tool(
    "resolve_default_project",
    "查詢是否已經設定過「今天的問題單」預設要看哪個 Asana workspace/專案。找到就直接用，不用再問；找不到則回傳 needsInput，呼叫端要問使用者一次後呼叫 register_default_project。",
    {},
    async () => {
      const project = await resolveDefaultProject();
      if (project) return textResult({ found: true, ...project });
      return textResult({ found: false, needsInput: true });
    }
  );

  server.tool(
    "register_default_project",
    "登記「今天的問題單」預設要看的 Asana workspace/專案，之後使用者只要說類似「處理今天的問題單」，都不用再問要看哪個專案。",
    {
      workspaceGid: z.string().describe("Asana 工作區 gid"),
      projectGid: z.string().describe("Asana 專案 gid"),
      projectName: z.string().describe("Asana 專案名稱（用於顯示、也用於追蹤目錄命名）"),
    },
    async ({ workspaceGid, projectGid, projectName }) => {
      await registerDefaultProject({ workspaceGid, projectGid, projectName });
      return textResult({ success: true, workspaceGid, projectGid, projectName });
    }
  );

  server.tool(
    "resolve_legacy_test_profile",
    "查詢這個 Asana 專案是否屬於「老舊系統測試」情境（測試工程師說明書第三章：JDK6+舊IE 這類自動化測不到的環境）。" +
      "**預設 false，不需要每個專案都主動問這一題**——只有使用者明確告知過（例如「這個專案是舊系統，JDK6+舊IE」）才會是 true，找不到登記紀錄就直接當 false 使用，不用停下來問使用者。",
    { projectGid: z.string().describe("Asana 專案 gid") },
    async ({ projectGid }) => {
      const legacyTestProfile = await resolveLegacyTestProfile(projectGid);
      return textResult({ legacyTestProfile });
    }
  );

  server.tool(
    "register_legacy_test_profile",
    "登記這個 Asana 專案是否屬於「老舊系統測試」情境。**只有使用者主動告知才呼叫，不要自己依程式碼特徵猜測**——這是一個沒有客觀技術門檻的判斷，交由使用者親口確認，AI 不自行判定。多數專案永遠不需要呼叫這個工具（維持預設 false 即可）。",
    {
      projectGid: z.string().describe("Asana 專案 gid"),
      legacyTestProfile: z.boolean().describe("這個專案是否屬於老舊系統測試情境（JDK6+舊IE這類）"),
    },
    async ({ projectGid, legacyTestProfile }) => {
      await registerLegacyTestProfile(projectGid, legacyTestProfile);
      return textResult({ success: true, projectGid, legacyTestProfile });
    }
  );

  server.tool(
    "resolve_test_capability",
    "查詢這個 Asana 專案的自動化測試能力等級——決定工程師階段要不要順手寫 JUnit/Jest 這類自動化測試、寫哪種版本。" +
      "找不到登記記錄時回傳 found: false，工程師角色第一次在這個專案動手前要先問使用者一次（見 register_test_capability 的三個選項說明），問完之後就不用每張票都再問。" +
      "跟 resolve_legacy_test_profile 是兩件事：那個決定的是「測試工程師手動測試要不要套用第三章(JDK6+舊IE)」，這個決定的是「工程師能不能寫自動化測試、用哪套工具鏈」——一個專案可能兩者都是 true/legacy（老IE前端+舊JDK後端），也可能只有其中一個成立。",
    { projectGid: z.string().describe("Asana 專案 gid") },
    async ({ projectGid }) => {
      const config = await resolveTestCapability(projectGid);
      if (!config) return textResult({ found: false });
      return textResult({ found: true, ...config });
    }
  );

  server.tool(
    "register_test_capability",
    "登記這個 Asana 專案的自動化測試能力等級。只有使用者主動告知才呼叫，不要自己依程式碼特徵猜測——" +
      "三個選項：" +
      "\"modern\"：可以用現代版本的 JUnit5+Mockito(後端 Java)/Jest+React Testing Library(前端)寫測試，工程師階段照一般方式寫。" +
      "\"legacy_junit4\"：專案受限於較舊的 JDK 版本(例如 JDK6/7)，現代 JUnit5/新版 Mockito 語法或位元組碼版本在這個 JDK 上編不過，只能改用相容的舊版工具鏈(例如 JUnit 4.12 + Mockito 1.10.19，這是最後一批支援 JDK6 的版本)——note 欄位請寫清楚實際 JDK 版本跟建議用的工具鏈版本，工程師會照這個版本寫。" +
      "\"none\"：這個專案沒辦法跑任何自動化測試(不是 Java/JS 生態、沒有可用的 build test task、程式碼結構完全無法測試這類)，工程師階段維持原本純手動/情境測試流程，不用寫測試。",
    {
      projectGid: z.string().describe("Asana 專案 gid"),
      mode: z.enum(["modern", "legacy_junit4", "none"]).describe("這個專案的自動化測試能力等級"),
      note: z.string().nullable().optional().describe("補充說明，例如 legacy_junit4 時實際的 JDK 版本與建議工具鏈版本、或 none 時的原因"),
    },
    async ({ projectGid, mode, note }) => {
      await registerTestCapability(projectGid, { mode, note: note ?? null });
      return textResult({ success: true, projectGid, mode, note: note ?? null });
    }
  );

  server.tool(
    "resolve_git_roots",
    "查詢這個專案目錄底下有沒有登記過 git 版控根目錄。找到就直接用，不用再問使用者；找不到的話，執行 git 相關指令（run_project_shell 裡的 git 指令）前必須先問使用者「前後端原始碼各自的 git 版控根目錄在哪裡」（分開的 repo 分別提供，共用同一個就提供一個），再呼叫 register_git_roots 登記。",
    { projectDir: z.string().describe("專案目錄絕對路徑") },
    async ({ projectDir }) => {
      const gitRoots = await resolveGitRoots(projectDir);
      return textResult(gitRoots ? { found: true, gitRoots } : { found: false, needsInput: true });
    }
  );

  server.tool(
    "register_git_roots",
    "登記某個專案目錄底下實際的 git 版控根目錄（可以是一個共用的，也可以是前後端分開的多個）。登記之後，run_project_shell 執行 git 指令時才會通過驗證。",
    {
      projectDir: z.string().describe("專案目錄絕對路徑"),
      gitRoots: z
        .array(z.object({ label: z.string().describe("這個 git 根目錄的用途標籤，例如「後端」「前端」「共用」"), path: z.string().describe("這個 git repo 的絕對路徑") }))
        .min(1)
        .describe("這個專案目錄底下實際的 git 版控根目錄清單，至少一筆"),
    },
    async ({ projectDir, gitRoots }) => {
      await registerGitRoots(projectDir, gitRoots as GitRootEntry[]);
      return textResult({ success: true, projectDir, gitRoots });
    }
  );
}
