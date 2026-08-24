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

    for (const t of ["tables", "columns", "foreign_keys", "indexes"]) {
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

    db.prepare(`INSERT INTO schema_snapshots (connection_id, snapshot_at, raw_json) VALUES (?, ?, ?)`).run(
      connectionId,
      now,
      JSON.stringify(introspection)
    );

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

  return {
    lastSyncedAt: connRow?.last_synced_at ?? null,
    tableCount: tables.length,
    tables,
    foreignKeys,
    indexes,
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
