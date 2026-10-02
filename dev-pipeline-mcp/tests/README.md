# 自動化測試

- 執行：`npm test`（先 build 再跑 `node --test`，用 Node 內建 `node:test`，無額外依賴）；單檔：`node --test tests/xxx.test.mjs`（需先 `npm run build`）。
- 分檔：`rule-files`（規則檔與快照）、`gates`（專案關卡）、`toolsets`（工具群組與工具清單契約）、`list-filter`、`next-action`、`pending-actions-sync`（本機重建報告）、`manual-blocks`（手動貼上內容區塊）、`role-prompt`、`overview`、`registry`、`sd-doc`、`no-customer-codes`（客戶代號守門）。
- 共用工具在 `helpers/support.mjs`（暫時目錄、資料目錄隔離、in-memory MCP client、假的 TicketStatus）。
- 慣例：檔名 `*.test.mjs`、從 `../dist/...` 以相對路徑匯入；內容盡量 ASCII（中文用 `\uXXXX`）；
  暫時資料一律 `mkdtemp`，並用 `ASANA_PIPELINE_DATA_DIR` 指到暫時目錄，測完清掉；不打網路、不碰真實 Asana 與正式 `data/`。
- 刻意新增或移除工具時，要同步更新 `toolsets.test.mjs` 的 `EXPECTED_TOOLS` 與各工具數量。
- 未涵蓋：`list_pending_tickets` 實際打 Asana 的部分、HTTP bridge、worktree 的實際 git 操作。
