import type { DbConnection } from "./config-store.js";
import { postgresDriver } from "./drivers/postgres.js";

export interface ColumnInfo {
  schema: string;
  table: string;
  name: string;
  ordinal: number;
  dataType: string;
  nullable: boolean;
  isPk: boolean;
  defaultValue: string | null;
}

export interface TableInfo {
  schema: string;
  name: string;
  type: string; // TABLE / VIEW
  rowEstimate: number | null;
}

export interface ForeignKeyInfo {
  constraintName: string;
  schema: string;
  table: string;
  column: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
}

export interface IndexInfo {
  schema: string;
  table: string;
  indexName: string;
  column: string;
  ordinal: number;
  isUnique: boolean;
}

export interface SchemaIntrospection {
  tables: TableInfo[];
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  executionTimeMs: number;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  executionTimeMs: number;
}

export interface DbDriver {
  testConnection(conn: DbConnection): Promise<TestConnectionResult>;
  introspectSchema(conn: DbConnection): Promise<SchemaIntrospection>;
  runQuery(conn: DbConnection, sql: string, maxRows: number, timeoutMs: number): Promise<QueryResult>;
}

function notImplemented(type: string): DbDriver {
  const err = async (): Promise<never> => {
    throw new Error(`資料庫類型 "${type}" 尚未實作查詢引擎（目前只有 postgresql 完成），先用 PostgreSQL 連線測試流程`);
  };
  return { testConnection: err, introspectSchema: err, runQuery: err };
}

const drivers: Record<string, DbDriver> = {
  postgresql: postgresDriver,
  mysql: notImplemented("mysql"),
  mssql: notImplemented("mssql"),
  oracle: notImplemented("oracle"),
};

export function getDriver(type: string): DbDriver {
  const driver = drivers[type];
  if (!driver) throw new Error(`不支援的資料庫類型："${type}"`);
  return driver;
}
