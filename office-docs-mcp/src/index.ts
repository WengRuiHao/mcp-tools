#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { unlink, stat } from "node:fs/promises";
import { runPythonTool } from "./python-bridge.js";

const server = new McpServer({
  name: "office-docs-mcp",
  version: "0.1.0",
});

function textResult(payload: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError };
}

function toolResult(result: { success: boolean; [key: string]: unknown }) {
  return textResult(result, result.success !== true);
}

// ---------------------------------------------------------------------------
// Word (.docx) — python-docx
// ---------------------------------------------------------------------------

const paragraphShape = z.object({
  text: z.string(),
  style: z.string().nullable().optional().describe("段落樣式名稱，例如 \"Heading 1\"（跟 heading_level 二選一，不用兩個都帶）"),
  heading_level: z.number().int().min(1).max(9).nullable().optional().describe("帶這個會用 add_heading 加入標題，1~9 對應 Word 的標題層級"),
});

server.tool(
  "read_docx",
  "【唯讀】讀取一份 .docx 檔案的所有段落文字＋表格內容。",
  { path: z.string().describe("docx 檔案的本機絕對路徑") },
  async ({ path }) => toolResult(runPythonTool("docx_tool.py", { action: "read", path }))
);

server.tool(
  "create_docx",
  "建立一份全新的 .docx 檔案，帶入初始段落清單。檔案已存在時預設拒絕，要覆蓋請帶 overwrite:true。",
  {
    path: z.string().describe("要建立的 docx 檔案本機絕對路徑"),
    paragraphs: z.array(paragraphShape).default([]).describe("初始段落清單，依序寫入"),
    overwrite: z.boolean().default(false).describe("檔案已存在時是否覆蓋"),
  },
  async ({ path, paragraphs, overwrite }) =>
    toolResult(runPythonTool("docx_tool.py", { action: "create", path, paragraphs, overwrite }))
);

server.tool(
  "append_docx_paragraph",
  "在既有 .docx 檔案的最後面接續加入一段或多段文字/標題，不動原本已有的內容。",
  {
    path: z.string().describe("docx 檔案的本機絕對路徑（必須已存在）"),
    paragraphs: z.array(paragraphShape).min(1).describe("要接續加入的段落清單"),
  },
  async ({ path, paragraphs }) =>
    toolResult(runPythonTool("docx_tool.py", { action: "append_paragraph", path, paragraphs }))
);

server.tool(
  "replace_docx_text",
  "在既有 .docx 檔案裡找出所有出現 find 字串的地方（段落＋表格內文字），整份取代成 replace。" +
    "**取代後該段落會失去原有跨 run 的格式變化（例如原本一段裡有一部分粗體、一部分不是），只保留段落層級格式**——需要保留精細格式時請改用 append_docx_paragraph／insert_docx_table 另外處理，不要對含有複雜格式的段落做取代。",
  {
    path: z.string().describe("docx 檔案的本機絕對路徑（必須已存在）"),
    find: z.string().describe("要找的字串"),
    replace: z.string().describe("取代成的字串"),
  },
  async ({ path, find, replace }) =>
    toolResult(runPythonTool("docx_tool.py", { action: "replace_text", path, find, replace }))
);

server.tool(
  "insert_docx_table",
  "在既有 .docx 檔案的最後面加入一個表格。",
  {
    path: z.string().describe("docx 檔案的本機絕對路徑（必須已存在）"),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1).describe("表格內容，每個內層陣列是一列，所有列必須跟第一列同樣的欄數"),
    style: z.string().nullable().optional().describe("Word 表格樣式名稱，例如 \"Table Grid\"，不帶則用預設樣式"),
  },
  async ({ path, rows, style }) =>
    toolResult(runPythonTool("docx_tool.py", { action: "insert_table", path, rows, style: style ?? undefined }))
);

// ---------------------------------------------------------------------------
// Excel (.xlsx) — openpyxl
// ---------------------------------------------------------------------------

const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

server.tool(
  "read_xlsx",
  "【唯讀】讀取一份 .xlsx 檔案的內容。不帶 sheet 會回傳全部工作表，帶了只回傳指定那個。",
  {
    path: z.string().describe("xlsx 檔案的本機絕對路徑"),
    sheet: z.string().nullable().optional().describe("只讀取這個工作表名稱，不指定就讀全部"),
  },
  async ({ path, sheet }) => toolResult(runPythonTool("xlsx_tool.py", { action: "read", path, sheet: sheet ?? undefined }))
);

server.tool(
  "create_xlsx",
  "建立一份全新的 .xlsx 檔案，帶入一或多個工作表跟各自的初始資料列。檔案已存在時預設拒絕，要覆蓋請帶 overwrite:true。",
  {
    path: z.string().describe("要建立的 xlsx 檔案本機絕對路徑"),
    sheets: z
      .array(z.object({ name: z.string(), rows: z.array(z.array(cellValue)).default([]) }))
      .min(1)
      .describe("工作表清單，第一個會成為預設的第一個 sheet"),
    overwrite: z.boolean().default(false).describe("檔案已存在時是否覆蓋"),
  },
  async ({ path, sheets, overwrite }) =>
    toolResult(runPythonTool("xlsx_tool.py", { action: "create", path, sheets, overwrite }))
);

server.tool(
  "append_xlsx_row",
  "在既有 .xlsx 檔案的指定工作表最後一列後面接續加入一列資料。",
  {
    path: z.string().describe("xlsx 檔案的本機絕對路徑（必須已存在）"),
    sheet: z.string().describe("工作表名稱（必須已存在，要新增工作表請用 create_xlsx_sheet）"),
    values: z.array(cellValue).min(1).describe("這一列每一欄的值，依序對應第 1、2、3...欄"),
  },
  async ({ path, sheet, values }) =>
    toolResult(runPythonTool("xlsx_tool.py", { action: "append_row", path, sheet, values }))
);

server.tool(
  "set_xlsx_cell",
  "設定既有 .xlsx 檔案某個工作表裡指定座標的單一格內容（座標從 1 開始）。",
  {
    path: z.string().describe("xlsx 檔案的本機絕對路徑（必須已存在）"),
    sheet: z.string().describe("工作表名稱（必須已存在）"),
    row: z.number().int().positive().describe("列號，從 1 開始"),
    col: z.number().int().positive().describe("欄號，從 1 開始（A=1, B=2...）"),
    value: cellValue.describe("要寫入的值"),
  },
  async ({ path, sheet, row, col, value }) =>
    toolResult(runPythonTool("xlsx_tool.py", { action: "set_cell", path, sheet, row, col, value }))
);

server.tool(
  "create_xlsx_sheet",
  "在既有 .xlsx 檔案裡新增一個工作表，可以帶入初始資料列。",
  {
    path: z.string().describe("xlsx 檔案的本機絕對路徑（必須已存在）"),
    name: z.string().describe("新工作表名稱（不能跟既有工作表重複）"),
    rows: z.array(z.array(cellValue)).default([]).describe("初始資料列"),
  },
  async ({ path, name, rows }) =>
    toolResult(runPythonTool("xlsx_tool.py", { action: "create_sheet", path, name, rows }))
);

// ---------------------------------------------------------------------------
// PDF — pypdf + reportlab
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 通用刪除（純檔案系統操作，三種格式共用，不需要 python）
// ---------------------------------------------------------------------------

server.tool(
  "delete_file",
  "刪除一個本機檔案（docx/xlsx/pdf 或任何檔案皆可，純檔案系統操作）。只會刪一般檔案，不會遞迴刪目錄。",
  { path: z.string().describe("要刪除的檔案本機絕對路徑") },
  async ({ path }) => {
    try {
      const st = await stat(path);
      if (!st.isFile()) {
        return toolResult({ success: false, message: `不是一般檔案，拒絕刪除: ${path}` });
      }
      await unlink(path);
      return toolResult({ success: true, path });
    } catch (e: any) {
      return toolResult({ success: false, message: `刪除失敗: ${e?.message ?? e}` });
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("office-docs-mcp failed to start:", err);
  process.exit(1);
});
