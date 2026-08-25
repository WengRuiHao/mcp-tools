import mysql from "mysql2/promise";
import type { DbConnection } from "../config-store.js";
import type {
  DbDriver,
  QueryParams,
  SchemaIntrospection,
  QueryResult,
  TestConnectionResult,
  ColumnInfo,
  TableInfo,
  ForeignKeyInfo,
  IndexInfo,
  ViewDefinitionInfo,
  RoutineInfo,
} from "../db-client.js";
import { toPositionalPlaceholders } from "../named-params.js";

async function buildConnection(conn: DbConnection, timeoutMs: number) {
  return mysql.createConnection({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    connectTimeout: timeoutMs,
  });
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  return v;
}

async function testConnection(conn: DbConnection): Promise<TestConnectionResult> {
  const start = Date.now();
  let connection: mysql.Connection | undefined;
  try {
    connection = await buildConnection(conn, 5000);
    await connection.query("SELECT 1");
    const ms = Date.now() - start;
    return { ok: true, message: `連線成功 (${ms}ms)`, executionTimeMs: ms };
  } catch (e: any) {
    const ms = Date.now() - start;
    return { ok: false, message: `連線失敗：${e.message}`, executionTimeMs: ms };
  } finally {
    await connection?.end().catch(() => {});
  }
}

async function introspectSchema(conn: DbConnection): Promise<SchemaIntrospection> {
  const connection = await buildConnection(conn, 15000);
  try {
    const schema = conn.database;

    const [tableRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT table_name, table_type, table_rows
       FROM information_schema.tables
       WHERE table_schema = ?
       ORDER BY table_name`,
      [schema]
    );
    const tables: TableInfo[] = tableRows.map((r) => ({
      schema,
      name: r.table_name,
      type: r.table_type === "VIEW" ? "VIEW" : "TABLE",
      rowEstimate: r.table_rows === null ? null : Number(r.table_rows),
    }));

    const [pkRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT table_name, column_name
       FROM information_schema.key_column_usage
       WHERE table_schema = ? AND constraint_name = 'PRIMARY'`,
      [schema]
    );
    const pkSet = new Set(pkRows.map((r) => `${r.table_name}.${r.column_name}`));

    const [colRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = ?
       ORDER BY table_name, ordinal_position`,
      [schema]
    );
    const columns: ColumnInfo[] = colRows.map((r) => ({
      schema,
      table: r.table_name,
      name: r.column_name,
      ordinal: r.ordinal_position,
      dataType: r.data_type,
      nullable: r.is_nullable === "YES",
      isPk: pkSet.has(`${r.table_name}.${r.column_name}`),
      defaultValue: r.column_default,
    }));

    const [fkRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT constraint_name, table_name, column_name, referenced_table_schema, referenced_table_name, referenced_column_name
       FROM information_schema.key_column_usage
       WHERE table_schema = ? AND referenced_table_name IS NOT NULL`,
      [schema]
    );
    const foreignKeys: ForeignKeyInfo[] = fkRows.map((r) => ({
      constraintName: r.constraint_name,
      schema,
      table: r.table_name,
      column: r.column_name,
      refSchema: r.referenced_table_schema,
      refTable: r.referenced_table_name,
      refColumn: r.referenced_column_name,
    }));

    const [idxRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT table_name, index_name, column_name, seq_in_index, non_unique
       FROM information_schema.statistics
       WHERE table_schema = ?
       ORDER BY table_name, index_name, seq_in_index`,
      [schema]
    );
    const indexes: IndexInfo[] = idxRows.map((r) => ({
      schema,
      table: r.table_name,
      indexName: r.index_name,
      column: r.column_name,
      ordinal: Number(r.seq_in_index),
      isUnique: Number(r.non_unique) === 0,
    }));

    const [viewRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT table_name, view_definition
       FROM information_schema.views
       WHERE table_schema = ?`,
      [schema]
    );
    const views: ViewDefinitionInfo[] = viewRows.map((r) => ({
      schema,
      name: r.table_name,
      definition: r.view_definition,
    }));

    // routine_definition 需要對應權限才拿得到，權限不夠會是 NULL（不是錯誤，就只是看不到內容）。
    const [routineRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT routine_name, routine_type, routine_definition
       FROM information_schema.routines
       WHERE routine_schema = ?`,
      [schema]
    );
    const routines: RoutineInfo[] = routineRows.map((r) => ({
      schema,
      name: r.routine_name,
      type: r.routine_type === "PROCEDURE" ? "PROCEDURE" : "FUNCTION",
      definition: r.routine_definition,
    }));

    return { tables, columns, foreignKeys, indexes, views, routines };
  } finally {
    await connection.end().catch(() => {});
  }
}

async function runQuery(
  conn: DbConnection,
  sql: string,
  params: QueryParams | undefined,
  maxRows: number,
  timeoutMs: number
): Promise<QueryResult> {
  const start = Date.now();
  const connection = await buildConnection(conn, timeoutMs);
  try {
    let finalSql = sql;
    let values: unknown[] | undefined;
    if (params && Object.keys(params).length > 0) {
      const { sql: prepared, paramOrder } = toPositionalPlaceholders(sql, () => "?");
      finalSql = prepared;
      values = paramOrder.map((name) => params[name] ?? null);
    }
    const [rows, fields] = await connection.query<any>(finalSql, values);
    // SELECT 回傳 row 陣列；純 DML（INSERT/UPDATE/DELETE）回傳的是 ResultSetHeader 物件，不是陣列。
    if (!Array.isArray(rows)) {
      const ms = Date.now() - start;
      return { type: "update", columns: [], rows: [], rowCount: 0, affectedRows: rows?.affectedRows ?? 0, truncated: false, executionTimeMs: ms };
    }
    const columns = (fields ?? []).map((f: any) => f.name);
    const allRows = rows.map((row: any) => columns.map((c: string) => normalizeValue(row[c])));
    const truncated = allRows.length > maxRows;
    const limited = truncated ? allRows.slice(0, maxRows) : allRows;
    return { type: "query", columns, rows: limited, rowCount: limited.length, truncated, executionTimeMs: Date.now() - start };
  } finally {
    await connection.end().catch(() => {});
  }
}

export const mysqlDriver: DbDriver = { testConnection, introspectSchema, runQuery };
