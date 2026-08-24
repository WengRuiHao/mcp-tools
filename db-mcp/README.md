# db-mcp

獨立的資料庫存取 MCP。從 claudeweb 的 Java JDBC 資料庫功能抽出來，重新設計成給 AI 用的資料庫工具：顯式的專案分組、SQLite 快取 schema（含 PK/FK/索引，claudeweb 原本沒有）、AI 可以寫回去的表格筆記、以及寫死在程式碼裡的唯讀查詢把關（不是靠 CLAUDE.md 規則靠 AI 自己記得）。

## 資料模型

```
Project（建置案/翻修案）
  └─ Connection（環境：dev/test/staging/prod，各自的帳密/host/port）
       └─ 一次 db_schema 同步 → 寫進這個專案的 SQLite 快取
```

- `info/projects.json`：專案登記表
- `info/db-connections.json`：連線設定（含密碼，**這個 MCP 是連線登記的唯一來源**，claudeweb 之後改成呼叫這裡的 HTTP bridge，不再自己存一份）
- `info/projects/<projectId>/schema.sqlite`：這個專案所有連線共用一份 schema 快取
  - `tables`/`columns`/`foreign_keys`/`indexes`：綁 `connection_id`（環境間會有落差，之後 `db_diff_schema` 靠這個比對）
  - `notes`：只綁 `schema_name`+`table_name`，跨環境共用（同一張表的業務意義不分 dev/prod）
  - `schema_snapshots`：每次同步留一份歷史快照（給以後的 `db_schema_history` 用）

`info/` 整個目錄已加進 `.gitignore`，不會進版控，是這個 MCP 自己獨立維護的個人副本。

## 目前的工具（stdio, 給 Claude Code 用）

| 工具 | 唯讀？ | 說明 |
|---|---|---|
| `db_project_create` / `db_project_list` / `db_project_get` | 唯讀（create 除外）| 專案分組管理 |
| `db_add_connection` / `db_list_connections` | 唯讀（add 除外）| 連線管理，回傳/列出時一律不含密碼 |
| `db_test_connection` | ✅ | 硬性把關：真的連一次確認可用 |
| `db_schema` | ✅ | 預設讀 SQLite 快取，`refresh:true` 才真的連線同步 |
| `db_search_tables` | ✅ | 快取裡關鍵字搜表名/欄位名 |
| `db_annotate_table` / `db_list_notes` | 唯讀（annotate 除外）| 專案層級的表格筆記 |
| `db_query` | ✅ | 執行 SQL，只放行 `SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`EXPLAIN`，其餘一律拒絕（見下方「唯讀把關」）|
| `db_sample_rows` | ✅ | 免寫 SQL，直接看某張表前 N 筆（表名要先在快取裡查得到） |
| `db_explain` | ✅ | 對 SQL 跑 `EXPLAIN`，跟 `db_query` 共用同一套把關規則 |

## 唯讀把關（`readonly-gate.ts`）

只包在這些 stdio 工具裡，**不是**放進共用的查詢引擎（`db-client.ts`）——之後 HTTP bridge 給 claudeweb 網頁的 Database 工具用時，人手動點「執行」本來就應該能跑 INSERT/UPDATE，那正是 CLAUDE.md 規則裡「寫入語句交給使用者手動執行」的那個手動執行管道，不該被這裡擋掉。

規則（寧可誤擋，不可誤放）：
1. 去除註解後，切開的每一句都必須以 `SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`DESC`/`EXPLAIN` 開頭
2. 就算開頭合法，仍全文掃描 `INSERT`/`UPDATE`/`DELETE`/`MERGE`/`DROP`/`ALTER`/`CREATE`/`TRUNCATE`/`GRANT`/`REVOKE`/`EXEC`/`EXECUTE`/`CALL`/`INTO`（`\b` 詞界比對），抓到就整句擋掉——這會擋住 `WITH cte AS (INSERT ... RETURNING ...) SELECT * FROM cte` 這種包裝寫法，也會擋住 MSSQL 的 `SELECT ... INTO new_table`
3. 多語句一起送進來，任一句沒過關就整批拒絕

## 目前完成度 / 待辦

- ✅ PostgreSQL：連線測試、schema 內省（表/欄位/PK/FK/索引）、查詢執行都已實作並跑過 stdio 煙霧測試
- ⏳ MySQL / MSSQL / Oracle：連線設定可以先登記，但 `db_test_connection`/`db_schema`/`db_query` 會回傳「尚未實作」，之後照 `drivers/postgres.ts` 的介面補
- ⏳ `db_diff_schema`（比對兩個連線的快取差異）、`db_export_ddl`（快取匯出成 CREATE TABLE）：還沒做
- ⏳ HTTP bridge（`http-server.ts`）+ claudeweb 整合（`DbMcpBridgeManager`、`DatabaseService` 改接 bridge）：還沒做，`DatabaseServiceTest`/`DatabaseControllerTest` 現有案例要當回歸基準
- ⏳ `:paramName` 具名參數綁定（claudeweb 原本 Java 版有）：v1 `db_query` 先只吃純 SQL，之後要補
- ⚠️ `db_query`/`db_sample_rows` 目前是整包查詢結果抓進記憶體後才截斷前 1000 筆，超大結果集沒有用 cursor 分批抓，之後如果遇到真的很肥的表要注意

## 安裝

```bash
npm install
npm run build
npm start   # 或設定成 Claude Code 的 MCP server
```

需要 Node 22.5+（用到內建的 `node:sqlite`，目前仍是實驗性 API，跑起來會在 stderr 印一則 ExperimentalWarning，不影響 stdio MCP 的 JSON-RPC 通訊）。
