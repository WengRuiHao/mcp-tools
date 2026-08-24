import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runPythonTool } from "./python-bridge.js";
import { toolResult } from "./shared.js";
import { cellValue } from "./xlsx-tools.js";

// ---------------------------------------------------------------------------
// CSV — 內建 csv 模組
// ---------------------------------------------------------------------------

export function registerCsvTools(server: McpServer): void {
  server.tool(
    "read_csv",
    "【唯讀】讀取一份 .csv 檔案的所有列（以 utf-8-sig 讀取，容忍檔案有沒有 BOM）。",
    {
      path: z.string().describe("csv 檔案的本機絕對路徑"),
      delimiter: z.string().default(",").describe("欄位分隔字元，預設逗號"),
    },
    async ({ path, delimiter }) => toolResult(runPythonTool("csv_tool.py", { action: "read", path, delimiter }))
  );

  server.tool(
    "create_csv",
    "建立一份全新的 .csv 檔案（以 utf-8-sig／帶 BOM 寫入，Excel 開啟中文不會亂碼）。檔案已存在時預設拒絕，要覆蓋請帶 overwrite:true。",
    {
      path: z.string().describe("要建立的 csv 檔案本機絕對路徑"),
      rows: z.array(z.array(cellValue)).default([]).describe("初始資料列"),
      delimiter: z.string().default(",").describe("欄位分隔字元，預設逗號"),
      overwrite: z.boolean().default(false).describe("檔案已存在時是否覆蓋"),
    },
    async ({ path, rows, delimiter, overwrite }) =>
      toolResult(runPythonTool("csv_tool.py", { action: "create", path, rows, delimiter, overwrite }))
  );

  server.tool(
    "append_csv_row",
    "在既有 .csv 檔案的最後一列後面接續加入一列資料。",
    {
      path: z.string().describe("csv 檔案的本機絕對路徑（必須已存在）"),
      values: z.array(cellValue).min(1).describe("這一列每一欄的值，依序對應第 1、2、3...欄"),
      delimiter: z.string().default(",").describe("欄位分隔字元，預設逗號"),
    },
    async ({ path, values, delimiter }) =>
      toolResult(runPythonTool("csv_tool.py", { action: "append_row", path, values, delimiter }))
  );
}
