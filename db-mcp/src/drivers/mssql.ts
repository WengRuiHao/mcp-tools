import sql from "mssql";
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
} from "../db-client.js";
import { toAtNamedPlaceholders } from "../named-params.js";

const DEFAULT_SCHEMA = "dbo";

async function buildPool(conn: DbConnection, timeoutMs: number): Promise<sql.ConnectionPool> {
  const pool = new sql.ConnectionPool({
    server: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    connectionTimeout: timeoutMs,
    requestTimeout: timeoutMs,
    options: { encrypt: false, trustServerCertificate: true },
  });
  return pool.connect();
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  return v;
}

async function testConnection(conn: DbConnection): Promise<TestConnectionResult> {
  const start = Date.now();
  let pool: sql.ConnectionPool | undefined;
  try {
    pool = await buildPool(conn, 5000);
    await pool.request().query("SELECT 1");
    const ms = Date.now() - start;
    return { ok: true, message: `連線成功 (${ms}ms)`, executionTimeMs: ms };
  } catch (e: any) {
    const ms = Date.now() - start;
    return { ok: false, message: `連線失敗：${e.message}`, executionTimeMs: ms };
  } finally {
    await pool?.close().catch(() => {});
  }
}

async function introspectSchema(conn: DbConnection): Promise<SchemaIntrospection> {
  const pool = await buildPool(conn, 15000);
  try {
    const schema = DEFAULT_SCHEMA;

    const tablesRes = await pool.request().input("schema", sql.NVarChar, schema).query(
      `SELECT t.TABLE_NAME AS table_name, t.TABLE_TYPE AS table_type,
              p.rows AS row_estimate
       FROM INFORMATION_SCHEMA.TABLES t
       LEFT JOIN sys.tables st ON st.name = t.TABLE_NAME
       LEFT JOIN sys.partitions p ON p.object_id = st.object_id AND p.index_id IN (0, 1)
       WHERE t.TABLE_SCHEMA = @schema
       ORDER BY t.TABLE_NAME`
    );
    const tables: TableInfo[] = tablesRes.recordset.map((r: any) => ({
      schema,
      name: r.table_name,
      type: r.table_type === "VIEW" ? "VIEW" : "TABLE",
      rowEstimate: r.row_estimate === null || r.row_estimate === undefined ? null : Number(r.row_estimate),
    }));

    const pkRes = await pool.request().input("schema", sql.NVarChar, schema).query(
      `SELECT tc.TABLE_NAME AS table_name, kcu.COLUMN_NAME AS column_name
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
       WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = @schema`
    );
    const pkSet = new Set(pkRes.recordset.map((r: any) => `${r.table_name}.${r.column_name}`));

    const colRes = await pool.request().input("schema", sql.NVarChar, schema).query(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, ORDINAL_POSITION AS ordinal_position,
              DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = @schema
       ORDER BY TABLE_NAME, ORDINAL_POSITION`
    );
    const columns: ColumnInfo[] = colRes.recordset.map((r: any) => ({
      schema,
      table: r.table_name,
      name: r.column_name,
      ordinal: r.ordinal_position,
      dataType: r.data_type,
      nullable: r.is_nullable === "YES",
      isPk: pkSet.has(`${r.table_name}.${r.column_name}`),
      defaultValue: r.column_default,
    }));

    const fkRes = await pool.request().input("schema", sql.NVarChar, schema).query(
      `SELECT fk.name AS constraint_name, tp.name AS table_name, cp.name AS column_name,
              tr.name AS ref_table_name, cr.name AS ref_column_name
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id
       JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
       JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id
       JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
       JOIN sys.schemas s ON s.schema_id = tp.schema_id
       WHERE s.name = @schema`
    );
    const foreignKeys: ForeignKeyInfo[] = fkRes.recordset.map((r: any) => ({
      constraintName: r.constraint_name,
      schema,
      table: r.table_name,
      column: r.column_name,
      refSchema: schema,
      refTable: r.ref_table_name,
      refColumn: r.ref_column_name,
    }));

    const idxRes = await pool.request().input("schema", sql.NVarChar, schema).query(
      `SELECT t.name AS table_name, i.name AS index_name, c.name AS column_name,
              ic.key_ordinal AS ordinal, i.is_unique AS is_unique
       FROM sys.indexes i
       JOIN sys.tables t ON t.object_id = i.object_id
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE s.name = @schema AND i.name IS NOT NULL
       ORDER BY t.name, i.name, ic.key_ordinal`
    );
    const indexes: IndexInfo[] = idxRes.recordset.map((r: any) => ({
      schema,
      table: r.table_name,
      indexName: r.index_name,
      column: r.column_name,
      ordinal: Number(r.ordinal),
      isUnique: !!r.is_unique,
    }));

    return { tables, columns, foreignKeys, indexes };
  } finally {
    await pool.close().catch(() => {});
  }
}

async function runQuery(
  conn: DbConnection,
  sqlText: string,
  params: QueryParams | undefined,
  maxRows: number,
  timeoutMs: number
): Promise<QueryResult> {
  const start = Date.now();
  const pool = await buildPool(conn, timeoutMs);
  try {
    const request = pool.request();
    let finalSql = sqlText;
    if (params && Object.keys(params).length > 0) {
      const { sql: prepared, paramNames } = toAtNamedPlaceholders(sqlText);
      finalSql = prepared;
      for (const name of paramNames) request.input(name, params[name] ?? null);
    }
    const result = await request.query(finalSql);
    // 純 DML（沒有 OUTPUT 子句）不會有 recordset；有 recordset 才當「查詢」處理。
    if (!result.recordset) {
      const ms = Date.now() - start;
      const affectedRows = (result.rowsAffected ?? []).reduce((a: number, b: number) => a + b, 0);
      return { type: "update", columns: [], rows: [], rowCount: 0, affectedRows, truncated: false, executionTimeMs: ms };
    }
    const rowsRaw = result.recordset;
    const columns = Object.keys(rowsRaw.columns ?? rowsRaw[0] ?? {});
    const allRows = rowsRaw.map((row: any) => columns.map((c) => normalizeValue(row[c])));
    const truncated = allRows.length > maxRows;
    const limited = truncated ? allRows.slice(0, maxRows) : allRows;
    return { type: "query", columns, rows: limited, rowCount: limited.length, truncated, executionTimeMs: Date.now() - start };
  } finally {
    await pool.close().catch(() => {});
  }
}

export const mssqlDriver: DbDriver = { testConnection, introspectSchema, runQuery };
