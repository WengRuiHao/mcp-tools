import { DatabaseSync } from "node:sqlite";
import { getProjectSchemaDbPath } from "./config-store.js";
import type { SchemaIntrospection } from "./db-client.js";

// tables/columns/foreign_keys/indexes 綁 connection_id（環境間會有落差，diff 靠這個）；
// notes 只綁 schema_name+table_name（跨環境共用，同一張表的業務意義不分 dev/prod）。
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS connections (
  connection_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  db_type TEXT NOT NULL,
  env TEXT NOT NULL,
  last_synced_at TEXT,
  last_sync_status TEXT,
  last_sync_message TEXT
);

CREATE TABLE IF NOT EXISTS tables (
  connection_id TEXT NOT NULL,
  schema_name TEXT NOT NULL DEFAULT '',
  table_name TEXT NOT NULL,
  table_type TEXT NOT NULL,
  row_estimate INTEGER,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, schema_name, table_name)
);

CREATE TABLE IF NOT EXISTS columns (
  connection_id TEXT NOT NULL,
  schema_name TEXT NOT NULL DEFAULT '',
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  data_type TEXT NOT NULL,
  nullable INTEGER NOT NULL,
  is_pk INTEGER NOT NULL DEFAULT 0,
  default_value TEXT,
  PRIMARY KEY (connection_id, schema_name, table_name, column_name)
);

CREATE TABLE IF NOT EXISTS foreign_keys (
  connection_id TEXT NOT NULL,
  constraint_name TEXT NOT NULL,
  schema_name TEXT NOT NULL DEFAULT '',
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  ref_schema_name TEXT NOT NULL DEFAULT '',
  ref_table_name TEXT NOT NULL,
  ref_column_name TEXT NOT NULL,
  PRIMARY KEY (connection_id, constraint_name, column_name)
);

CREATE TABLE IF NOT EXISTS indexes (
  connection_id TEXT NOT NULL,
  schema_name TEXT NOT NULL DEFAULT '',
  table_name TEXT NOT NULL,
  index_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  is_unique INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, index_name, column_name)
);

CREATE TABLE IF NOT EXISTS views (
  connection_id TEXT NOT NULL,
  schema_name TEXT NOT NULL DEFAULT '',
  view_name TEXT NOT NULL,
  definition TEXT,
  PRIMARY KEY (connection_id, schema_name, view_name)
);

-- 沒有用 (connection_id, schema_name, routine_name, routine_type) 當主鍵——
-- Postgres/Oracle 允許同名函式多載（相同名稱、不同參數签名），主鍵設同名唯一實測會直接撞 UNIQUE constraint。
CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  schema_name TEXT NOT NULL DEFAULT '',
  routine_name TEXT NOT NULL,
  routine_type TEXT NOT NULL,
  definition TEXT
);
CREATE INDEX IF NOT EXISTS idx_routines_lookup ON routines(connection_id, routine_name);

CREATE TABLE IF NOT EXISTS notes (
  schema_name TEXT NOT NULL DEFAULT '',
  table_name TEXT NOT NULL,
  note TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'ai',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (schema_name, table_name)
);

CREATE TABLE IF NOT EXISTS schema_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tables_name ON tables(table_name);
CREATE INDEX IF NOT EXISTS idx_columns_name ON columns(column_name);
`;

export function openSchemaDb(projectId: string): DatabaseSync {
  const db = new DatabaseSync(getProjectSchemaDbPath(projectId));
  db.exec(SCHEMA_DDL);
  return db;
}

export interface ConnectionSyncMeta {
  name: string;
  dbType: string;
  env: string;
}

// 每個連線最多留幾筆歷史快照——沒有這個上限，反覆 refresh 大型 schema（很多 routine 原始碼）
// 會讓 schema_snapshots 這張表無限長大，實測 728 張表+172 個預存程序的 schema 單筆快照就有數 MB。
const MAX_SNAPSHOTS_PER_CONNECTION = 10;

/** 用一次全新的 introspection 結果整批覆蓋這個連線的快取（表/欄位/FK/索引），並補一筆歷史快照。 */
export function replaceSchemaSnapshot(
  db: DatabaseSync,
  connectionId: string,
  meta: ConnectionSyncMeta,
  introspection: SchemaIntrospection
): void {
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO connections (connection_id, name, db_type, env, last_synced_at, last_sync_status, last_sync_message)
       VALUES (?, ?, ?, ?, ?, 'success', NULL)
       ON CONFLICT(connection_id) DO UPDATE SET
         name = excluded.name, db_type = excluded.db_type, env = excluded.env,
         last_synced_at = excluded.last_synced_at, last_sync_status = 'success', last_sync_message = NULL`
    ).run(connectionId, meta.name, meta.dbType, meta.env, now);

    for (const t of ["tables", "columns", "foreign_keys", "indexes", "views", "routines"]) {
      db.prepare(`DELETE FROM ${t} WHERE connection_id = ?`).run(connectionId);
    }

    const insTable = db.prepare(
      `INSERT INTO tables (connection_id, schema_name, table_name, table_type, row_estimate, synced_at) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const t of introspection.tables) {
      insTable.run(connectionId, t.schema, t.name, t.type, t.rowEstimate, now);
    }

    const insCol = db.prepare(
      `INSERT INTO columns (connection_id, schema_name, table_name, column_name, ordinal, data_type, nullable, is_pk, default_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const c of introspection.columns) {
      insCol.run(connectionId, c.schema, c.table, c.name, c.ordinal, c.dataType, c.nullable ? 1 : 0, c.isPk ? 1 : 0, c.defaultValue);
    }

    const insFk = db.prepare(
      `INSERT INTO foreign_keys (connection_id, constraint_name, schema_name, table_name, column_name, ref_schema_name, ref_table_name, ref_column_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const fk of introspection.foreignKeys) {
      insFk.run(connectionId, fk.constraintName, fk.schema, fk.table, fk.column, fk.refSchema, fk.refTable, fk.refColumn);
    }

    const insIdx = db.prepare(
      `INSERT INTO indexes (connection_id, schema_name, table_name, index_name, column_name, ordinal, is_unique)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const idx of introspection.indexes) {
      insIdx.run(connectionId, idx.schema, idx.table, idx.indexName, idx.column, idx.ordinal, idx.isUnique ? 1 : 0);
    }

    const insView = db.prepare(
      `INSERT INTO views (connection_id, schema_name, view_name, definition) VALUES (?, ?, ?, ?)`
    );
    for (const v of introspection.views) {
      insView.run(connectionId, v.schema, v.name, v.definition);
    }

    const insRoutine = db.prepare(
      `INSERT INTO routines (connection_id, schema_name, routine_name, routine_type, definition) VALUES (?, ?, ?, ?, ?)`
    );
    for (const r of introspection.routines) {
      insRoutine.run(connectionId, r.schema, r.name, r.type, r.definition);
    }

    db.prepare(`INSERT INTO schema_snapshots (connection_id, snapshot_at, raw_json) VALUES (?, ?, ?)`).run(
      connectionId,
      now,
      JSON.stringify(introspection)
    );
    // 每次 refresh 都會整包再存一份歷史快照，不清舊的檔案會無限長大——只留最近幾筆，
    // 大型 schema（很多 routine 原始碼）重複 refresh 幾次沒有這個上限會很快膨脹到幾十 MB 以上。
    db.prepare(
      `DELETE FROM schema_snapshots WHERE connection_id = ? AND id NOT IN (
         SELECT id FROM schema_snapshots WHERE connection_id = ? ORDER BY snapshot_at DESC LIMIT ${MAX_SNAPSHOTS_PER_CONNECTION}
       )`
    ).run(connectionId, connectionId);

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function readCachedSchema(db: DatabaseSync, connectionId: string) {
  const connRow = db.prepare(`SELECT * FROM connections WHERE connection_id = ?`).get(connectionId) as any;
  const tableRows = db.prepare(`SELECT * FROM tables WHERE connection_id = ? ORDER BY table_name`).all(connectionId) as any[];
  const colRows = db
    .prepare(`SELECT * FROM columns WHERE connection_id = ? ORDER BY table_name, ordinal`)
    .all(connectionId) as any[];
  const fkRows = db.prepare(`SELECT * FROM foreign_keys WHERE connection_id = ?`).all(connectionId) as any[];
  const idxRows = db
    .prepare(`SELECT * FROM indexes WHERE connection_id = ? ORDER BY table_name, index_name, ordinal`)
    .all(connectionId) as any[];

  const colsByTable = new Map<string, any[]>();
  for (const c of colRows) {
    const key = `${c.schema_name}.${c.table_name}`;
    if (!colsByTable.has(key)) colsByTable.set(key, []);
    colsByTable.get(key)!.push({
      name: c.column_name,
      dataType: c.data_type,
      nullable: !!c.nullable,
      isPk: !!c.is_pk,
      defaultValue: c.default_value,
    });
  }

  const tables = tableRows.map((t) => ({
    schema: t.schema_name,
    name: t.table_name,
    type: t.table_type,
    rowEstimate: t.row_estimate,
    columns: colsByTable.get(`${t.schema_name}.${t.table_name}`) ?? [],
  }));

  const foreignKeys = fkRows.map((fk) => ({
    constraintName: fk.constraint_name,
    schema: fk.schema_name,
    table: fk.table_name,
    column: fk.column_name,
    refSchema: fk.ref_schema_name,
    refTable: fk.ref_table_name,
    refColumn: fk.ref_column_name,
  }));

  const indexes = idxRows.map((idx) => ({
    schema: idx.schema_name,
    table: idx.table_name,
    indexName: idx.index_name,
    column: idx.column_name,
    ordinal: idx.ordinal,
    isUnique: !!idx.is_unique,
  }));

  const viewRows = db.prepare(`SELECT * FROM views WHERE connection_id = ? ORDER BY view_name`).all(connectionId) as any[];
  const views = viewRows.map((v) => ({ schema: v.schema_name, name: v.view_name, definition: v.definition }));

  const routineRows = db
    .prepare(`SELECT * FROM routines WHERE connection_id = ? ORDER BY routine_name`)
    .all(connectionId) as any[];
  const routines = routineRows.map((r) => ({
    schema: r.schema_name,
    name: r.routine_name,
    type: r.routine_type,
    definition: r.definition,
  }));

  return {
    lastSyncedAt: connRow?.last_synced_at ?? null,
    tableCount: tables.length,
    tables,
    foreignKeys,
    indexes,
    views,
    routines,
  };
}

export function searchTables(db: DatabaseSync, keyword: string, connectionId?: string) {
  const like = `%${keyword}%`;
  const tableMatches = connectionId
    ? db
        .prepare(`SELECT connection_id, schema_name, table_name, table_type FROM tables WHERE connection_id = ? AND table_name LIKE ?`)
        .all(connectionId, like)
    : db.prepare(`SELECT connection_id, schema_name, table_name, table_type FROM tables WHERE table_name LIKE ?`).all(like);

  const columnMatches = connectionId
    ? db
        .prepare(
          `SELECT connection_id, schema_name, table_name, column_name FROM columns WHERE connection_id = ? AND column_name LIKE ?`
        )
        .all(connectionId, like)
    : db
        .prepare(`SELECT connection_id, schema_name, table_name, column_name FROM columns WHERE column_name LIKE ?`)
        .all(like);

  return { tableMatches, columnMatches };
}

// 單次回應的欄位總數超過這個門檻，db_schema 就自動只回表名+欄位數量摘要，不是整包欄位細節都塞進 AI 的 context。
// 沒有精確科學依據，是抓一個「明顯開始不合理」的量級，之後用起來覺得太鬆/太緊可以再調。
const MAX_COLUMNS_BEFORE_SUMMARY = 1500;

export type CachedSchema = ReturnType<typeof readCachedSchema>;

/**
 * 欄位總數沒超標就原樣回傳；超標的話把每張表的 columns 陣列換成 columnCount，
 * 並標記 truncated——AI 要看某張表的完整欄位，改用 db_schema 的 tableName 參數單獨拿那一張。
 */
// view/routine 的定義是整段 SQL 原始碼，一段大的預存程序就可能好幾千字——欄位數沒超標不代表這段不會爆。
const MAX_DEFINITION_CHARS_BEFORE_SUMMARY = 100_000;

export function summarizeIfLarge(cached: CachedSchema): CachedSchema & { truncated: boolean; truncatedMessage?: string } {
  const totalColumns = cached.tables.reduce((sum, t: any) => sum + (t.columns?.length ?? 0), 0);
  const totalDefChars = [...cached.views, ...cached.routines].reduce((sum, v: any) => sum + (v.definition?.length ?? 0), 0);
  const columnsOverLimit = totalColumns > MAX_COLUMNS_BEFORE_SUMMARY;
  const definitionsOverLimit = totalDefChars > MAX_DEFINITION_CHARS_BEFORE_SUMMARY;

  if (!columnsOverLimit && !definitionsOverLimit) {
    return { ...cached, truncated: false };
  }

  const tables = columnsOverLimit
    ? cached.tables.map((t: any) => ({
        schema: t.schema,
        name: t.name,
        type: t.type,
        rowEstimate: t.rowEstimate,
        columnCount: t.columns?.length ?? 0,
      }))
    : cached.tables;

  const views = definitionsOverLimit ? cached.views.map((v) => ({ schema: v.schema, name: v.name })) : cached.views;
  const routines = definitionsOverLimit
    ? cached.routines.map((r) => ({ schema: r.schema, name: r.name, type: r.type }))
    : cached.routines;

  const notes: string[] = [];
  if (columnsOverLimit) {
    notes.push(
      `欄位共 ${totalColumns} 個，超過上限（${MAX_COLUMNS_BEFORE_SUMMARY}），已省略每張表的欄位細節、只留表名+欄位數量。對 db_schema 加 tableName 參數可單獨查某一張表。`
    );
  }
  if (definitionsOverLimit) {
    notes.push(
      `view/function/procedure 定義文字總長 ${totalDefChars} 字元，超過上限（${MAX_DEFINITION_CHARS_BEFORE_SUMMARY}），已省略定義內容、只留名稱。要看特定 view/routine 的定義，用 db_query 直接查（例如 postgres: SELECT definition FROM pg_views WHERE viewname = '...')。`
    );
  }

  return {
    ...cached,
    tables: tables as any,
    views: views as any,
    routines: routines as any,
    truncated: true,
    truncatedMessage: notes.join(" "),
  };
}

/** 只回傳單一表的完整細節（欄位/FK/索引），不管欄位總數限制——呼叫端已經自己縮小範圍了。 */
export function readSingleTableSchema(db: DatabaseSync, connectionId: string, schemaName: string, tableName: string) {
  const full = readCachedSchema(db, connectionId);
  const table = full.tables.find((t: any) => t.name === tableName && (schemaName === "" || t.schema === schemaName));
  if (!table) return null;
  const foreignKeys = full.foreignKeys.filter((fk) => fk.table === tableName);
  const indexes = full.indexes.filter((idx) => idx.table === tableName);
  return { lastSyncedAt: full.lastSyncedAt, table, foreignKeys, indexes };
}

export function tableExistsInCache(db: DatabaseSync, connectionId: string, schemaName: string, tableName: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM tables WHERE connection_id = ? AND schema_name = ? AND table_name = ?`)
    .get(connectionId, schemaName, tableName);
  return !!row;
}

export function upsertNote(db: DatabaseSync, schemaName: string, tableName: string, note: string, author = "ai"): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO notes (schema_name, table_name, note, author, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(schema_name, table_name) DO UPDATE SET note = excluded.note, author = excluded.author, updated_at = excluded.updated_at`
  ).run(schemaName, tableName, note, author, now);
}

export function listNotes(db: DatabaseSync) {
  return db.prepare(`SELECT schema_name, table_name, note, author, updated_at FROM notes ORDER BY table_name`).all();
}

/** 比較同一個專案底下兩個連線的快取差異——只看快取，不會去連真正的資料庫。 */
export function diffCachedSchemas(a: CachedSchema, b: CachedSchema) {
  const key = (t: { schema: string; name: string }) => `${t.schema}.${t.name}`;
  const aTables = new Map(a.tables.map((t) => [key(t), t]));
  const bTables = new Map(b.tables.map((t) => [key(t), t]));

  const onlyInA = [...aTables.keys()].filter((k) => !bTables.has(k)).sort();
  const onlyInB = [...bTables.keys()].filter((k) => !aTables.has(k)).sort();
  const common = [...aTables.keys()].filter((k) => bTables.has(k)).sort();

  const columnDifferences = [];
  for (const tableKey of common) {
    const ta = aTables.get(tableKey)!;
    const tb = bTables.get(tableKey)!;
    const colsA = new Map(ta.columns.map((c: any) => [c.name, c]));
    const colsB = new Map(tb.columns.map((c: any) => [c.name, c]));

    const addedInB = [...colsB.keys()].filter((c) => !colsA.has(c));
    const removedInB = [...colsA.keys()].filter((c) => !colsB.has(c));
    const typeChanged = [...colsA.keys()]
      .filter((c) => colsB.has(c) && (colsA.get(c) as any).dataType !== (colsB.get(c) as any).dataType)
      .map((c) => ({ column: c, a: (colsA.get(c) as any).dataType, b: (colsB.get(c) as any).dataType }));

    if (addedInB.length || removedInB.length || typeChanged.length) {
      columnDifferences.push({ table: tableKey, addedInB, removedInB, typeChanged });
    }
  }

  return { tablesOnlyInA: onlyInA, tablesOnlyInB: onlyInB, columnDifferences };
}

/** 從快取產生 CREATE TABLE / FK 的 DDL 文字（雙引號風格，主要給人看/當文件用，不保證是來源資料庫可以直接重跑的合法語法）。 */
export function exportDdlFromCache(cached: CachedSchema): string {
  const statements: string[] = [];

  for (const t of cached.tables) {
    if (t.type !== "TABLE") continue;
    const pkCols = (t.columns as any[]).filter((c) => c.isPk).map((c) => c.name);
    const colLines = (t.columns as any[]).map((c) => {
      let line = `  "${c.name}" ${c.dataType}`;
      if (!c.nullable) line += " NOT NULL";
      if (c.defaultValue) line += ` DEFAULT ${c.defaultValue}`;
      return line;
    });
    if (pkCols.length) colLines.push(`  PRIMARY KEY (${pkCols.map((c: string) => `"${c}"`).join(", ")})`);
    statements.push(`CREATE TABLE "${t.schema}"."${t.name}" (\n${colLines.join(",\n")}\n);`);
  }

  for (const fk of cached.foreignKeys) {
    statements.push(
      `ALTER TABLE "${fk.schema}"."${fk.table}" ADD CONSTRAINT "${fk.constraintName}" ` +
        `FOREIGN KEY ("${fk.column}") REFERENCES "${fk.refSchema}"."${fk.refTable}" ("${fk.refColumn}");`
    );
  }

  return statements.join("\n\n");
}
