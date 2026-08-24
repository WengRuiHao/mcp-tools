import oracledb from "oracledb";
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

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

// v1 假設用 service name 連（host:port/service），不是舊式的 SID（host:port:SID）；
// 也假設用 schema 擁有者本人的帳號連線，所以查 USER_* 系列 view 就夠，不用查 ALL_*/DBA_*。
function buildConnectString(conn: DbConnection): string {
  return `${conn.host}:${conn.port}/${conn.database}`;
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  return v;
}

async function testConnection(conn: DbConnection): Promise<TestConnectionResult> {
  const start = Date.now();
  let connection: oracledb.Connection | undefined;
  try {
    connection = await oracledb.getConnection({
      user: conn.username,
      password: conn.password,
      connectString: buildConnectString(conn),
    });
    await connection.execute("SELECT 1 FROM DUAL");
    const ms = Date.now() - start;
    return { ok: true, message: `連線成功 (${ms}ms)`, executionTimeMs: ms };
  } catch (e: any) {
    const ms = Date.now() - start;
    return { ok: false, message: `連線失敗：${e.message}`, executionTimeMs: ms };
  } finally {
    await connection?.close().catch(() => {});
  }
}

async function introspectSchema(conn: DbConnection): Promise<SchemaIntrospection> {
  const connection = await oracledb.getConnection({
    user: conn.username,
    password: conn.password,
    connectString: buildConnectString(conn),
  });
  try {
    const schema = conn.username.toUpperCase();

    const tablesRes = await connection.execute<any>(
      `SELECT object_name AS table_name, object_type AS table_type
       FROM user_objects
       WHERE object_type IN ('TABLE', 'VIEW')
       ORDER BY object_name`
    );
    const tables: TableInfo[] = (tablesRes.rows ?? []).map((r) => ({
      schema,
      name: r.TABLE_NAME,
      type: r.TABLE_TYPE,
      rowEstimate: null, // USER_TABLES.NUM_ROWS 只在跑過 ANALYZE/統計資訊更新後才準，v1 先不猜
    }));

    const pkRes = await connection.execute<any>(
      `SELECT cons.table_name, cols.column_name
       FROM user_constraints cons
       JOIN user_cons_columns cols ON cons.constraint_name = cols.constraint_name
       WHERE cons.constraint_type = 'P'`
    );
    const pkSet = new Set((pkRes.rows ?? []).map((r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`));

    const colRes = await connection.execute<any>(
      `SELECT table_name, column_name, column_id AS ordinal_position, data_type, nullable
       FROM user_tab_columns
       ORDER BY table_name, column_id`
    );
    const columns: ColumnInfo[] = (colRes.rows ?? []).map((r) => ({
      schema,
      table: r.TABLE_NAME,
      name: r.COLUMN_NAME,
      ordinal: r.ORDINAL_POSITION,
      dataType: r.DATA_TYPE,
      nullable: r.NULLABLE === "Y",
      isPk: pkSet.has(`${r.TABLE_NAME}.${r.COLUMN_NAME}`),
      defaultValue: null,
    }));

    const fkRes = await connection.execute<any>(
      `SELECT a.constraint_name, a.table_name, a.column_name,
              c_pk.table_name AS ref_table_name, b.column_name AS ref_column_name
       FROM user_cons_columns a
       JOIN user_constraints c ON a.constraint_name = c.constraint_name
       JOIN user_constraints c_pk ON c.r_constraint_name = c_pk.constraint_name
       JOIN user_cons_columns b ON c_pk.constraint_name = b.constraint_name AND a.position = b.position
       WHERE c.constraint_type = 'R'`
    );
    const foreignKeys: ForeignKeyInfo[] = (fkRes.rows ?? []).map((r) => ({
      constraintName: r.CONSTRAINT_NAME,
      schema,
      table: r.TABLE_NAME,
      column: r.COLUMN_NAME,
      refSchema: schema,
      refTable: r.REF_TABLE_NAME,
      refColumn: r.REF_COLUMN_NAME,
    }));

    const idxRes = await connection.execute<any>(
      `SELECT ic.table_name, ic.index_name, ic.column_name, ic.column_position AS ordinal, i.uniqueness
       FROM user_ind_columns ic
       JOIN user_indexes i ON ic.index_name = i.index_name
       ORDER BY ic.table_name, ic.index_name, ic.column_position`
    );
    const indexes: IndexInfo[] = (idxRes.rows ?? []).map((r) => ({
      schema,
      table: r.TABLE_NAME,
      indexName: r.INDEX_NAME,
      column: r.COLUMN_NAME,
      ordinal: Number(r.ORDINAL),
      isUnique: r.UNIQUENESS === "UNIQUE",
    }));

    return { tables, columns, foreignKeys, indexes };
  } finally {
    await connection.close().catch(() => {});
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
  // oracledb 原生就吃 :name 具名參數，不用像 postgres/mysql/mssql 那樣另外轉換語法。
  const connection = await oracledb.getConnection({
    user: conn.username,
    password: conn.password,
    connectString: buildConnectString(conn),
  });
  try {
    connection.callTimeout = timeoutMs;
    // autoCommit: true——DML 沒有這個會停在未提交狀態（oracledb 預設 autoCommit:false），
    // 這條路徑（bridge 給人用）本來就要讓 INSERT/UPDATE 真的生效，不是只給 AI 的唯讀查詢。
    const result = await connection.execute<any>(sql, params ?? {}, { maxRows: maxRows + 1, autoCommit: true });
    // 有 metaData（含欄位描述）才算「查詢」；純 DML 沒有 metaData，回傳影響筆數。
    if (!result.metaData) {
      const ms = Date.now() - start;
      return { type: "update", columns: [], rows: [], rowCount: 0, affectedRows: result.rowsAffected ?? 0, truncated: false, executionTimeMs: ms };
    }
    const columns = result.metaData.map((m) => m.name);
    const allRows = (result.rows ?? []).map((row) => columns.map((c) => normalizeValue(row[c])));
    const truncated = allRows.length > maxRows;
    const rows = truncated ? allRows.slice(0, maxRows) : allRows;
    return { type: "query", columns, rows, rowCount: rows.length, truncated, executionTimeMs: Date.now() - start };
  } finally {
    await connection.close().catch(() => {});
  }
}

export const oracleDriver: DbDriver = { testConnection, introspectSchema, runQuery };
