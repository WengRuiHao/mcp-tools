import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findRepos, listConnections, testConnection } from "./svn-client.js";
import { toolResult, connectionIdParam } from "./shared.js";

export function registerConnectionTools(server: McpServer): void {
  server.tool(
    "svn_list_connections",
    "【唯讀】列出所有可用的 SVN 連線（每個 repo 一筆，只回傳 id/name/url/aliases，不含帳密）。連線設定檔只存「帳號」，底下的 repo 由伺服器自動帶出；aliases 是舊版取的名稱（例如「專案甲」），nickname 是使用者替專案取的簡稱；用 name、id、任一個 alias 或 nickname 當 connectionId 都找得到。呼叫其他 svn_* 工具前，如果不確定要用哪個連線，先呼叫這個確認。",
    {},
    async () => toolResult(await listConnections())
  );

  server.tool(
    "svn_find_repo",
    "【唯讀】依關鍵字找專案庫（repo），回答「使用者說的這個專案在哪個連線、檔案大概在哪個目錄」。" +
      "會同時比對 repo 名稱、舊版取的名稱（例如「專案甲」）、使用者自己取的簡稱（例如「丙銀」），以及常用目錄的暱稱與路徑（例如「後端規格」）；" +
      "多個關鍵字用空白隔開，要全部符合。關鍵字留空＝列出常用專案（星星專案在最前面、其次是最近開過的）。" +
      "回傳每個專案的 connectionId（填給 svn_browse、svn_cat 等工具）與它的常用目錄（path 可以直接用）。" +
      "**使用者提到專案名稱、或要找規格存放位置時，先呼叫這個，不要自己猜 connectionId 或路徑。**",
    {
      query: z.string().describe("關鍵字：repo 名稱、簡稱、舊名稱、常用目錄暱稱的全部或一部分；空白隔開多個關鍵字；留空列出常用專案"),
      limit: z.number().int().min(1).max(50).default(10).describe("最多回傳幾個專案，預設 10"),
    },
    async ({ query, limit }) => toolResult(await findRepos(query, limit))
  );

  server.tool(
    "svn_test_connection",
    "【唯讀】實際測試某個 SVN 連線能不能連上（真的執行一次 `svn info`，不是只檢查設定檔有沒有這筆資料）。" +
      "**這是一個硬性把關工具**：在把某個 Asana 專案的 SA/SD 規格登記成 SVN 路徑之前，一定要先呼叫這個確認連得上，連不上就要停下來跟使用者確認 SVN 連線設定，不要假設之後會自己通。",
    { connectionId: connectionIdParam },
    async ({ connectionId }) => toolResult(await testConnection(connectionId ?? undefined))
  );
}
