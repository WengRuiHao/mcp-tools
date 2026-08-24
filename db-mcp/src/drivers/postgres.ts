import pg from "pg";
import type { DbConnection } from "../config-store.js";
import type {
  DbDriver,
  SchemaIntrospection,
  QueryResult,
  TestConnectionResult,
  ColumnInfo,
  TableInfo,
  ForeignKeyInfo,
  IndexInfo,
} from "../db-client.js";

// v1 先固定查 public schema；之後要支援自訂 schema 再幫 DbConnection 加欄位。
const DEFAULT_SCHEMA = "public";

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

async function introspectSchema(conn: DbConnection): Promise<SchemaIntrospection> {
  const client = buildClient(conn, 15000);
  await client.connect();
  try {
    const schema = DEFAULT_SCHEMA;

    const tablesRes = await client.query(
      `SELECT c.relname AS table_name,
              CASE c.relkind WHEN 'v' THEN 'VIEW' ELSE 'TABLE' END AS table_type,
              NULLIF(c.reltuples, -1)::bigint AS row_estimate
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','v')
       ORDER BY c.relname`,
      [schema]
    );
    const tables: TableInfo[] = tablesRes.rows.map((r) => ({
      schema,
      name: r.table_name,
      type: r.table_type,
      rowEstimate: r.row_estimate === null ? null : Number(r.row_estimate),
    }));

    const pkRes = await client.query(
      `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1`,
      [schema]
    );
    const pkSet = new Set(pkRes.rows.map((r) => `${r.table_name}.${r.column_name}`));

    const colRes = await client.query(
      `SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [schema]
    );
    const columns: ColumnInfo[] = colRes.rows.map((r) => ({
      schema,
      table: r.table_name,
      name: r.column_name,
      ordinal: r.ordinal_position,
      dataType: r.data_type,
      nullable: r.is_nullable === "YES",
      isPk: pkSet.has(`${r.table_name}.${r.column_name}`),
      defaultValue: r.column_default,
    }));

    const fkRes = await client.query(
      `SELECT tc.constraint_name, tc.table_name, kcu.column_name,
              ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
      [schema]
    );
    const foreignKeys: ForeignKeyInfo[] = fkRes.rows.map((r) => ({
      constraintName: r.constraint_name,
      schema,
      table: r.table_name,
      column: r.column_name,
      refSchema: r.ref_schema,
      refTable: r.ref_table,
      refColumn: r.ref_column,
    }));

    const idxRes = await client.query(
      `SELECT t.relname AS table_name, i.relname AS index_name, a.attname AS column_name,
              array_position(ix.indkey, a.attnum) AS ordinal, ix.indisunique AS is_unique
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
       WHERE n.nspname = $1
       ORDER BY t.relname, i.relname, ordinal`,
      [schema]
    );
    const indexes: IndexInfo[] = idxRes.rows.map((r) => ({
      schema,
      table: r.table_name,
      indexName: r.index_name,
      column: r.column_name,
      ordinal: Number(r.ordinal),
      isUnique: r.is_unique,
    }));

    return { tables, columns, foreignKeys, indexes };
  } finally {
    await client.end().catch(() => {});
  }
}

async function runQuery(conn: DbConnection, sql: string, maxRows: number, timeoutMs: number): Promise<QueryResult> {
  const start = Date.now();
  const client = buildClient(conn, timeoutMs);
  await client.connect();
  try {
    const res = await client.query(sql);
    const columns = (res.fields ?? []).map((f) => f.name);
    const allRows = res.rows.map((row) => columns.map((c) => normalizeValue(row[c])));
    const truncated = allRows.length > maxRows;
    const rows = truncated ? allRows.slice(0, maxRows) : allRows;
    return { columns, rows, rowCount: rows.length, truncated, executionTimeMs: Date.now() - start };
  } finally {
    await client.end().catch(() => {});
  }
}

export const postgresDriver: DbDriver = { testConnection, introspectSchema, runQuery };
