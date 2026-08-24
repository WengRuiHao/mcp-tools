import { z } from "zod";

export interface DbMcpResult {
  success: boolean;
  message?: string;
  [key: string]: unknown;
}

export function toolResult(result: DbMcpResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    isError: result.success !== true,
  };
}

export function ok(data: Record<string, unknown> = {}): DbMcpResult {
  return { success: true, ...data };
}

export function fail(message: string, data: Record<string, unknown> = {}): DbMcpResult {
  return { success: false, message, ...data };
}

export const projectIdParam = z.string().describe("db_project_create / db_project_list 回傳的專案 id");

export const connectionIdParam = z.string().describe("db_list_connections 回傳的連線 id");

export const dbTypeEnum = z
  .enum(["postgresql", "mysql", "mssql", "oracle"])
  .describe("資料庫類型。目前只有 postgresql 真正實作查詢引擎，其餘三種登記連線會成功，但 db_test_connection/db_schema/db_query 會回傳「尚未實作」");

export const dbEnvEnum = z
  .enum(["dev", "test", "staging", "prod"])
  .describe("這個連線是哪個環境，標記 prod 的連線在唯讀查詢工具的回應裡會加警示字樣");
