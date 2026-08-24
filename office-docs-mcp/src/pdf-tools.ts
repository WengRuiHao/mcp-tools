import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runPythonTool } from "./python-bridge.js";
import { toolResult } from "./shared.js";

// ---------------------------------------------------------------------------
// PDF — pypdf + reportlab
// ---------------------------------------------------------------------------

export function registerPdfTools(server: McpServer): void {
  server.tool(
    "read_pdf",
    "【唯讀】抽取一份 .pdf 檔案每一頁的純文字內容。" +
      "**PDF 天生不是給人編輯內容用的格式，這裡只做文字抽取（掃描圖片型 PDF 抽不出文字）**——需要修改內容請改用 Word/Excel 對應工具，或用下面的合併/分割/浮水印/表單填寫功能。",
    { path: z.string().describe("pdf 檔案的本機絕對路徑") },
    async ({ path }) => toolResult(runPythonTool("pdf_tool.py", { action: "read", path }))
  );

  server.tool(
    "merge_pdf",
    "把多份 .pdf 檔案依陣列順序合併成一份新檔案。",
    {
      paths: z.array(z.string()).min(2).describe("要合併的 pdf 檔案路徑，依這個順序合併"),
      output_path: z.string().describe("合併後輸出的 pdf 檔案路徑"),
    },
    async ({ paths, output_path }) => toolResult(runPythonTool("pdf_tool.py", { action: "merge", paths, output_path }))
  );

  server.tool(
    "extract_pdf_pages",
    "從一份 .pdf 檔案抽取指定頁碼（可跳頁、可任意順序），組成一份新檔案——用來做「分割」：例如只想要第 3、5、6 頁，帶 pages:[3,5,6]。",
    {
      path: z.string().describe("來源 pdf 檔案的本機絕對路徑"),
      pages: z.array(z.number().int().positive()).min(1).describe("要抽取的頁碼陣列，從 1 開始"),
      output_path: z.string().describe("抽取後輸出的 pdf 檔案路徑"),
    },
    async ({ path, pages, output_path }) =>
      toolResult(runPythonTool("pdf_tool.py", { action: "extract_pages", path, pages, output_path }))
  );

  server.tool(
    "watermark_pdf",
    "在一份 .pdf 檔案的每一頁疊加一個斜向文字浮水印，輸出成新檔案（不動原檔）。",
    {
      path: z.string().describe("來源 pdf 檔案的本機絕對路徑"),
      text: z.string().describe("浮水印文字"),
      output_path: z.string().describe("加浮水印後輸出的 pdf 檔案路徑"),
    },
    async ({ path, text, output_path }) =>
      toolResult(runPythonTool("pdf_tool.py", { action: "watermark", path, text, output_path }))
  );

  server.tool(
    "fill_pdf_form",
    "填寫一份 .pdf 裡的 AcroForm 表單欄位，輸出成新檔案（不動原檔）。" +
      "**只能填寫 PDF 本身就有設計好的互動表單欄位**——沒有表單欄位的一般 PDF（多數掃描件、匯出版）無法用這個工具填寫任何內容。",
    {
      path: z.string().describe("來源 pdf 檔案的本機絕對路徑"),
      fields: z.record(z.string(), z.string()).describe("表單欄位名稱 -> 要填入的值"),
      output_path: z.string().describe("填寫後輸出的 pdf 檔案路徑"),
    },
    async ({ path, fields, output_path }) =>
      toolResult(runPythonTool("pdf_tool.py", { action: "fill_form", path, fields, output_path }))
  );
}
