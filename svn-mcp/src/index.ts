#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { svnBrowse, svnCat, svnLog, svnDiff, svnDocImages, listConnections, testConnection, type SvnResult } from "./svn-client.js";

const server = new McpServer({
  name: "svn-mcp",
  version: "0.2.0",
});

function toolResult(result: SvnResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    isError: result.success !== true,
  };
}

const connectionIdParam = z
  .string()
  .nullable()
  .optional()
  .describe("要用哪個 SVN 連線（svn_list_connections 回傳的 id 或 name 皆可）。不給的話用 SVN_CONNECTION_ID 環境變數當預設值。");

server.tool(
  "svn_list_connections",
  "【唯讀】列出這個 MCP 自己 info/svn-connections.json 裡登記的所有 SVN 連線（只回傳 id/name/url，不含帳密）。呼叫其他 svn_* 工具前，如果不確定要用哪個連線，先呼叫這個確認。",
  {},
  async () => toolResult(await listConnections())
);

server.tool(
  "svn_test_connection",
  "【唯讀】實際測試某個 SVN 連線能不能連上（真的執行一次 `svn info`，不是只檢查設定檔有沒有這筆資料）。" +
    "**這是一個硬性把關工具**：在把某個 Asana 專案的 SA/SD 規格登記成 SVN 路徑之前，一定要先呼叫這個確認連得上，連不上就要停下來跟使用者確認 SVN 連線設定，不要假設之後會自己通。",
  { connectionId: connectionIdParam },
  async ({ connectionId }) => toolResult(await testConnection(connectionId ?? undefined))
);

server.tool(
  "svn_browse",
  "【唯讀】瀏覽 SVN 上某個路徑底下的檔案/子目錄清單（直接執行本機 svn CLI，不依賴任何網站服務）。path 用空字串可以列出 repo 根目錄。",
  {
    path: z.string().default("").describe("要瀏覽的路徑（相對於這個連線的 repo 根目錄），例如 \"doc/sa\"，空字串代表列出根目錄"),
    connectionId: connectionIdParam,
  },
  async ({ path, connectionId }) => toolResult(await svnBrowse(path, connectionId ?? undefined))
);

server.tool(
  "svn_cat",
  "【唯讀】讀取 SVN 上某個檔案的內容。純文字檔直接回傳內容；Word/Excel/PDF 等二進位格式會寫入本機暫存檔，回傳 tempFilePath，請改用專案既有的檔案讀取流程（例如 docx 用 python-docx）處理，讀完記得清掉暫存目錄。",
  {
    path: z.string().describe("檔案路徑（相對於這個連線的 repo 根目錄），例如 \"doc/spec/OC01.docx\""),
    rev: z.string().default("HEAD").describe("版本號，預設 HEAD（最新版）"),
    connectionId: connectionIdParam,
  },
  async ({ path, rev, connectionId }) => toolResult(await svnCat(path, rev, connectionId ?? undefined))
);

server.tool(
  "svn_log",
  "【唯讀】查詢某個 SVN 路徑的修訂記錄（commit log）。",
  {
    path: z.string().describe("要查詢的路徑（相對於這個連線的 repo 根目錄）"),
    limit: z.number().int().positive().max(200).default(30).describe("最多回傳幾筆，預設 30"),
    connectionId: connectionIdParam,
  },
  async ({ path, limit, connectionId }) => toolResult(await svnLog(path, limit, connectionId ?? undefined))
);

server.tool(
  "svn_diff",
  "【唯讀】比較某個 SVN 路徑兩個版本之間的差異。",
  {
    path: z.string().describe("要比較的路徑（相對於這個連線的 repo 根目錄）"),
    r1: z.string().describe("舊版本號"),
    r2: z.string().describe("新版本號"),
    connectionId: connectionIdParam,
  },
  async ({ path, r1, r2, connectionId }) => toolResult(await svnDiff(path, r1, r2, connectionId ?? undefined))
);

server.tool(
  "svn_doc_images",
  "【唯讀】把 SVN 上的 Word/Excel 等文件寫入本機暫存檔（實際圖片抽取請用專案既有的 python-docx 流程處理這個暫存檔，不是這個工具自己做 OCR）。規格書的流程圖/畫面設計常常在圖片裡，讀 docx 規格務必連這個一起呼叫，不要只讀文字。",
  {
    path: z.string().describe("docx/xlsx 檔案路徑（相對於這個連線的 repo 根目錄）"),
    rev: z.string().default("HEAD").describe("版本號，預設 HEAD"),
    connectionId: connectionIdParam,
  },
  async ({ path, rev, connectionId }) => toolResult(await svnDocImages(path, rev, connectionId ?? undefined))
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("svn-mcp failed to start:", err);
  process.exit(1);
});
