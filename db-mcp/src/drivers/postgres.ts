import pg from "pg";
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

function buildClient(conn: DbConnection, timeoutMs: number): pg.Client {
  return new pg.Client({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs,
    connectionTimeoutMillis: 10000,
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
  const client = buildClient(conn, 5000);
  try {
    await client.connect();
    await client.query("SELECT 1");
    const ms = Date.now() - start;
    return { ok: true, message: `連線成功 (${ms}ms)`, executionTimeMs: ms };
  } catch (e: any) {
    const ms = Date.now() - start;
    return { ok: false, message: `連線失敗：${e.message}`, executionTimeMs: ms };
  } finally {
    await client.end().catch(() => {});
  }
}

// 排除系統 schema，其餘全部內省——實測遇到真實案例是自訂 schema（跟資料庫同名，public 反而是空的），
// 硬編碼單一 schema（之前是寫死 "public"）會直接漏掉整個資料庫，所以改成掃全部使用者 schema。
const SYSTEM_SCHEMA_FILTER = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'`;
const SYSTEM_SCHEMA_FILTER_INFO_SCHEMA = `table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%'`;

async function introspectSchema(conn: DbConnection): Promise<SchemaIntrospection> {
  const client = buildClient(conn, 15000);
  await client.connect();
  try {
    const tablesRes = await client.query(
      `SELECT n.nspname AS schema_name, c.relname AS table_name,
              CASE c.relkind WHEN 'v' THEN 'VIEW' ELSE 'TABLE' END AS table_type,
              NULLIF(c.reltuples, -1)::bigint AS row_estimate
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${SYSTEM_SCHEMA_FILTER} AND c.relkind IN ('r','v')
       ORDER BY n.nspname, c.relname`
    );
    const tables: TableInfo[] = tablesRes.rows.map((r) => ({
      schema: r.schema_name,
      name: r.table_name,
      type: r.table_type,
      rowEstimate: r.row_estimate === null ? null : Number(r.row_estimate),
    }));

    const pkRes = await client.query(
      `SELECT tc.table_schema, tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND ${SYSTEM_SCHEMA_FILTER_INFO_SCHEMA.replace(/table_schema/g, "tc.table_schema")}`
    );
    const pkSet = new Set(pkRes.rows.map((r) => `${r.table_schema}.${r.table_name}.${r.column_name}`));

    const colRes = await client.query(
      `SELECT table_schema, table_name, column_name, ordinal_position, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE ${SYSTEM_SCHEMA_FILTER_INFO_SCHEMA}
       ORDER BY table_schema, table_name, ordinal_position`
    );
    const columns: ColumnInfo[] = colRes.rows.map((r) => ({
      schema: r.table_schema,
      table: r.table_name,
      name: r.column_name,
      ordinal: r.ordinal_position,
      dataType: r.data_type,
      nullable: r.is_nullable === "YES",
      isPk: pkSet.has(`${r.table_schema}.${r.table_name}.${r.column_name}`),
      defaultValue: r.column_default,
    }));

    const fkRes = await client.query(
      `SELECT tc.constraint_name, tc.table_schema, tc.table_name, kcu.column_name,
              ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND ${SYSTEM_SCHEMA_FILTER_INFO_SCHEMA.replace(/table_schema/g, "tc.table_schema")}`
    );
    const foreignKeys: ForeignKeyInfo[] = fkRes.rows.map((r) => ({
      constraintName: r.constraint_name,
      schema: r.table_schema,
      table: r.table_name,
      column: r.column_name,
      refSchema: r.ref_schema,
      refTable: r.ref_table,
      refColumn: r.ref_column,
    }));

    const idxRes = await client.query(
      `SELECT n.nspname AS schema_name, t.relname AS table_name, i.relname AS index_name, a.attname AS column_name,
              array_position(ix.indkey, a.attnum) AS ordinal, ix.indisunique AS is_unique
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
       WHERE ${SYSTEM_SCHEMA_FILTER}
       ORDER BY n.nspname, t.relname, i.relname, ordinal`
    );
    const indexes: IndexInfo[] = idxRes.rows.map((r) => ({
      schema: r.schema_name,
      table: r.table_name,
      indexName: r.index_name,
      column: r.column_name,
      ordinal: Number(r.ordinal),
      isUnique: r.is_unique,
    }));

    const viewRes = await client.query(
      `SELECT schemaname AS schema_name, viewname AS view_name, definition
       FROM pg_views
       WHERE ${SYSTEM_SCHEMA_FILTER.replace(/n\.nspname/g, "schemaname")}`
    );
    const views: ViewDefinitionInfo[] = viewRes.rows.map((r) => ({
      schema: r.schema_name,
      name: r.view_name,
      definition: r.definition,
    }));

    // prokind 是 PG11+ 才有的欄位（'f'=function, 'p'=procedure）；舊版 PG 沒有這個欄位會查不到，先接受這個限制。
    const routineRes = await client.query(
      `SELECT n.nspname AS schema_name, p.proname AS routine_name,
              CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS routine_type,
              pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE ${SYSTEM_SCHEMA_FILTER} AND p.prokind IN ('f', 'p')`
    );
    const routines: RoutineInfo[] = routineRes.rows.map((r) => ({
      schema: r.schema_name,
      name: r.routine_name,
      type: r.routine_type,
      definition: r.definition,
    }));

    return { tables, columns, foreignKeys, indexes, views, routines };
  } finally {
    await client.end().catch(() => {});
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
  const client = buildClient(conn, timeoutMs);
  await client.connect();
  try {
    let finalSql = sql;
    let values: unknown[] | undefined;
    if (params && Object.keys(params).length > 0) {
      const { sql: prepared, paramOrder } = toPositionalPlaceholders(sql, (i) => `$${i}`);
      finalSql = prepared;
      values = paramOrder.map((name) => params[name] ?? null);
    }
    const res = await client.query(finalSql, values);
    const columns = (res.fields ?? []).map((f) => f.name);
    // 有欄位描述（含 INSERT/UPDATE ... RETURNING）才算「查詢」；純 DML/DDL 沒有欄位，回傳影響筆數。
    if (columns.length === 0) {
      const ms = Date.now() - start;
      return { type: "update", columns: [], rows: [], rowCount: 0, affectedRows: res.rowCount ?? 0, truncated: false, executionTimeMs: ms };
    }
    const allRows = res.rows.map((row) => columns.map((c) => normalizeValue(row[c])));
    const truncated = allRows.length > maxRows;
    const rows = truncated ? allRows.slice(0, maxRows) : allRows;
    return { type: "query", columns, rows, rowCount: rows.length, truncated, executionTimeMs: Date.now() - start };
  } finally {
    await client.end().catch(() => {});
  }
}

export const postgresDriver: DbDriver = { testConnection, introspectSchema, runQuery };
