import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runPythonTool } from "./python-bridge.js";
import { toolResult } from "./shared.js";

// ---------------------------------------------------------------------------
// Excel (.xlsx) — openpyxl
// ---------------------------------------------------------------------------

export const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export function registerXlsxTools(server: McpServer): void {
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

  server.tool(
    "extract_xlsx_images",
    "【唯讀】把一份 .xlsx 檔案裡內嵌的圖片原始檔案抽取出來，存到指定目錄，回傳每張圖片的檔案路徑＋所在工作表名稱＋錨點座標(anchor_row/anchor_col，從 1 開始)。" +
      "**不做圖片內容判讀（不做 OCR/視覺分析）**——抽出來的圖片檔案請改用你自己內建的讀圖能力（例如 Read 工具）逐一讀取理解內容，這個工具只負責把圖片正確定位、原封不動抽出來。",
    {
      path: z.string().describe("xlsx 檔案的本機絕對路徑"),
      output_dir: z.string().describe("抽取出的圖片要存放的本機目錄（不存在會自動建立）"),
    },
    async ({ path, output_dir }) =>
      toolResult(runPythonTool("xlsx_tool.py", { action: "extract_images", path, output_dir }))
  );
}
