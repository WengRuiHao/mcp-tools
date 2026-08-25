import type { DbConnection } from "./config-store.js";
import { postgresDriver } from "./drivers/postgres.js";
import { mysqlDriver } from "./drivers/mysql.js";
import { mssqlDriver } from "./drivers/mssql.js";
import { oracleDriver } from "./drivers/oracle.js";

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

export interface ViewDefinitionInfo {
  schema: string;
  name: string;
  definition: string | null;
}

export interface RoutineInfo {
  schema: string;
  name: string;
  type: "FUNCTION" | "PROCEDURE";
  definition: string | null;
}

export interface SchemaIntrospection {
  tables: TableInfo[];
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  views: ViewDefinitionInfo[];
  routines: RoutineInfo[];
}

export interface QueryResult {
  type: "query" | "update";
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  affectedRows?: number;
  truncated: boolean;
  executionTimeMs: number;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  executionTimeMs: number;
}

export type QueryParams = Record<string, string | number | boolean | null>;

export interface DbDriver {
  testConnection(conn: DbConnection): Promise<TestConnectionResult>;
  introspectSchema(conn: DbConnection): Promise<SchemaIntrospection>;
  runQuery(
    conn: DbConnection,
    sql: string,
    params: QueryParams | undefined,
    maxRows: number,
    timeoutMs: number
  ): Promise<QueryResult>;
}

const drivers: Record<string, DbDriver> = {
  postgresql: postgresDriver,
  mysql: mysqlDriver,
  mssql: mssqlDriver,
  oracle: oracleDriver,
};

export function getDriver(type: string): DbDriver {
  const driver = drivers[type];
  if (!driver) throw new Error(`不支援的資料庫類型："${type}"`);
  return driver;
}
