import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { svnBrowse, svnCat, svnDocImages } from "./svn-client.js";
import { toolResult, connectionIdParam } from "./shared.js";

export function registerReadTools(server: McpServer): void {
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
    "svn_doc_images",
    "【唯讀】把 SVN 上的 Word/Excel 等文件寫入本機暫存檔（實際圖片抽取請用專案既有的 python-docx 流程處理這個暫存檔，不是這個工具自己做 OCR）。規格書的流程圖/畫面設計常常在圖片裡，讀 docx 規格務必連這個一起呼叫，不要只讀文字。",
    {
      path: z.string().describe("docx/xlsx 檔案路徑（相對於這個連線的 repo 根目錄）"),
      rev: z.string().default("HEAD").describe("版本號，預設 HEAD"),
      connectionId: connectionIdParam,
    },
    async ({ path, rev, connectionId }) => toolResult(await svnDocImages(path, rev, connectionId ?? undefined))
  );
}
