import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runPythonTool } from "./python-bridge.js";
import { toolResult } from "./shared.js";

// ---------------------------------------------------------------------------
// Word (.docx) — python-docx
// ---------------------------------------------------------------------------

const paragraphShape = z.object({
  text: z.string(),
  style: z.string().nullable().optional().describe("段落樣式名稱，例如 \"Heading 1\"（跟 heading_level 二選一，不用兩個都帶）"),
  heading_level: z.number().int().min(1).max(9).nullable().optional().describe("帶這個會用 add_heading 加入標題，1~9 對應 Word 的標題層級"),
});

export function registerDocxTools(server: McpServer): void {
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

  server.tool(
    "extract_docx_images",
    "【唯讀】把一份 .docx 檔案裡內嵌的圖片（流程圖、畫面截圖等）原始檔案抽取出來，存到指定目錄，回傳每張圖片的檔案路徑＋位置脈絡（最近的標題、前後鄰近的文字段落、是否在表格裡）。" +
      "**不做圖片內容判讀（不做 OCR/視覺分析）**——抽出來的圖片檔案請改用你自己內建的讀圖能力（例如 Read 工具）逐一讀取理解內容，這個工具只負責把圖片正確定位、原封不動抽出來。" +
      "**已知限制**：只掃描文件主體（body）段落與表格內的圖片，不含頁首/頁尾/文字方塊(text box)裡的圖片。",
    {
      path: z.string().describe("docx 檔案的本機絕對路徑"),
      output_dir: z.string().describe("抽取出的圖片要存放的本機目錄（不存在會自動建立）"),
    },
    async ({ path, output_dir }) =>
      toolResult(runPythonTool("docx_tool.py", { action: "extract_images", path, output_dir }))
  );
}
