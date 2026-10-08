# svn-edit 設計文件

> 狀態：P1（核心）、P2（執行檔、控制頁、自動拉起）、P3（新增檔案）已完成並通過測試；P4 已完成（svn-edit 端的瀏覽 SVN 目錄，加上 dev-pipeline 報告頁的連結，見「P4 完成紀錄」）。日期：2026-10-07。

## 目標

讓使用者在不手動 checkout 的情況下，編輯 SVN 遠端庫上的單一檔案（docx、xlsx、md、txt），改完再傳回遠端。
Word、Excel 一律用使用者本機真正的 Office 編輯，不自己做網頁編輯器，因此圖片、流程圖、公式不會在往返中遺失。

## 架構：一個核心、一個入口

```
 dev-pipeline 網頁按鈕 ──(開啟連結)──┐
                                     ├─→ svn-edit.exe（本機常駐，127.0.0.1）──→ remote-edit-client.ts ──→ svn CLI
 使用者直接開控制頁 ────────────────┘                  ↑ 不註冊成 MCP 工具，AI 碰不到
```

- **核心：`src/remote-edit-client.ts`**（放在 svn-mcp）。所有 svn 邏輯都在這裡，寫法比照 `workcopy-client.ts`。
- **唯一入口：`svn-edit.exe`**。用 `pkg` 打包（比照 `dist-exe/svn-http-bridge.exe`），在 `127.0.0.1` 提供控制頁與本機 API。
- **dev-pipeline 不實作任何 svn-edit 邏輯，也不新增 `/svn-edit/*` 端點。** 網頁按鈕只負責組出連結並開啟，所有行為都由執行檔決定，因此兩邊不會有落差。
- `svn-http-bridge.exe` 維持唯讀，不放任何寫入功能（claudeweb 依賴這個保證）。

## dev-pipeline 按鈕與執行檔的銜接

按鈕按下後，開啟（新分頁）：

```
http://127.0.0.1:<port>/edit?connection=<連線名稱>&path=<遠端路徑>&ticket=<票號>
```

- `GET /edit` **只顯示確認頁**（檔案名稱、連線、票號、「開始編輯」按鈕），不會執行任何動作。
- 真正的取出動作要由確認頁發出 `POST`，並帶上執行檔嵌在頁面裡的一次性 token。
  這是為了防止其他網站用連結或圖片請求，偷偷觸發本機開檔（CSRF）。
- `ticket` 參數用來預填 commit 訊息前綴，例如 `[GV-5005] `。
- 不跨來源呼叫（用頁面導向而不是 fetch），所以不需要處理 CORS，dev-pipeline 也不用保存執行檔的 token。
- 執行檔不在執行時，連結會打不開。解法見「待決事項」。

## 一次編輯的生命週期

| 步驟 | 動作 | 細節 |
|---|---|---|
| 1. 開啟 | 取出單一檔案 | `svn checkout --depth empty` 加 `svn update 檔案`，放進 `%TEMP%\svn-edit\<sessionId>\`，記下基準版本 |
| 2. 鎖定 | docx、xlsx 預設先 `svn lock` | 已被別人鎖住就拒絕開啟，並顯示鎖定者 |
| 3. 開啟檔案 | 用系統預設程式開啟暫存檔 | 由副檔名決定（Word、Excel、VS Code 等） |
| 4. 編輯 | 使用者自行編輯，控制頁等待 | 不輪詢、不猜測 |
| 5. 上傳 | 使用者按「改好了，上傳」 | 先做下列檢查，再 commit |
| 6. 結束 | commit 成功後清理暫存與鎖 | commit 預設會一併釋放鎖 |
| 放棄 | 使用者按「放棄」 | `svn unlock`，刪除暫存資料夾 |

按下上傳時依序檢查：

| 檢查 | 失敗時 |
|---|---|
| Office 暫存鎖定檔（`~$檔名`）是否還在 | 提示「Word/Excel 還開著這個檔，請先關閉」，不上傳 |
| 檔案內容有沒有變（雜湊值比對） | 提示「沒有任何修改」，不產生空 commit |
| commit 訊息是否為空 | 拒絕 |
| 遠端是否已被別人改過 | 見「衝突處理」 |

## 衝突處理（第一版：保守策略）

遠端有新版本時，**拒絕上傳**，保留暫存檔，並提供「下載最新版另存」讓使用者手動比對。
不做自動合併，因為 Word、Excel 本來就不能合併。

## 當機復原

每個 session 的狀態寫成 `session.json`，放在暫存資料夾內。執行檔啟動時偵測殘留 session，讓使用者選擇「繼續上傳」或「放棄並解鎖」。
否則電腦當機後，檔案會被自己的鎖卡住。

## 安全邊界（沿用現有規則）

- 只能操作連線 URL 底下的檔案，以 `/` 為邊界比對；拒絕 `..` 與完整 URL（重用 `assertSafeSubPath`）。
- 第一版只處理單一檔案，不處理資料夾。
- 副檔名白名單：`.docx`、`.xlsx`、`.md`、`.txt`；另設檔案大小上限。
- 只綁 `127.0.0.1`；所有會改動狀態的請求都要 token。
- 帳密沿用 `resolveConnection`（`info/svn-connections.json`），不經由網頁傳遞。
- 每次開啟、上傳、放棄都寫稽核紀錄，commit 訊息只記長度與前 80 字（比照 `svn-workcopy-bridge.ts`）。
- 中文 commit 訊息寫成 UTF-8 暫存檔，以 `-F` 傳給 svn（比照 `workcopy-client.ts`）。
- 整個寫入模組不得被 `index.ts` 或 `*-tools.ts` 引用；擴充 `tests/read-only-surface.test.mjs` 鎖住這一點。

## 分階段交付

| 階段 | 內容 | 驗收 |
|---|---|---|
| P1 | 核心 `remote-edit-client.ts`：開啟、鎖定、上傳、放棄、復原，附測試 | 本機臨時庫（`svnadmin create` + `file://`）跑完整流程，含衝突、鎖被占、中文檔名 |
| P2 | `svn-edit.exe`：本機 API、確認頁、控制頁，`pkg` 打包 | 真實用 Word 開啟、修改、上傳一次；從瀏覽器連結觸發 |
| P3 | 新增檔案：`svn import` 加屬性（docx、xlsx 設 `needs-lock`；md 設 `eol-style=native`） | 新檔案進庫且屬性正確 |
| P4 | dev-pipeline 網頁按鈕：只組連結，帶入連線、路徑、票號 | 從票單頁一鍵進入編輯 |

P4 只改 dev-pipeline 的頁面產生程式，不新增任何 svn 邏輯。

## 啟動方式：連接 svn-mcp 時自動拉起

- svn-mcp 的 `index.ts` 啟動時，先呼叫執行檔的 `/health`；沒有回應才以**分離模式**（detached、unref）拉起執行檔，已在跑就略過。
- svn-mcp 每個 Claude Code 對話會啟動一份，dev-pipeline 也會再開一份子程序，所以必須是冪等的：固定埠號本身也保證只會有一個實例。
- 執行檔要比 MCP 活得久：不跟著 MCP 結束，改為「沒有任何進行中的編輯，且閒置超過一段時間」後自行結束，避免使用者編輯到一半控制頁失效。
- `index.ts` 只用路徑拉起執行檔，**不得 import `remote-edit-client`**，維持 AI 唯讀鎖定（由 `read-only-surface.test.mjs` 檢查）。
- 備援：沒有使用 Claude Code 的同事，可雙擊桌面捷徑手動啟動執行檔；日後可加開機自動啟動選項。
- 找不到執行檔時，退而求其次用 `node dist/edit-server.js` 啟動。

## 多人使用（執行檔不與 dev-pipeline 綁定）

同事也會使用，因此執行檔必須自給自足：

| 項目 | 設計 |
|---|---|
| 與 dev-pipeline 的關係 | 無依賴。dev-pipeline 只負責產生連結。 |
| 埠號 | 固定預設埠（暫定 8096），可用環境變數 `SVN_EDIT_PORT` 覆蓋。連結使用預設埠。 |
| 帳密與連線設定 | **與 svn-mcp 唯讀工具共用同一份設定檔**（見下方「共用連線設定」）。每位同事在自己的電腦上維護自己的那一份，使用自己的 SVN 帳號與密碼，不隨執行檔或程式碼散布。 |
| `svn.exe` | 第一版**不隨附**，要求同事自行安裝 svn 命令列工具（例如 TortoiseSVN 安裝時勾選 command line client tools）。啟動時偵測不到 `svn` 就在控制頁明確提示安裝方式。 |
| 鎖定 | SVN 的鎖綁定帳號，每人各自帳號才分得出「誰在編輯」，也才能判斷「這是不是我自己的鎖」。 |

## 共用連線設定

svn-edit 與 svn-mcp 現有唯讀工具讀**同一份** `svn-connections.json`，只維護一處：

- 解析邏輯重用 `config-store.ts` 的 `getConnectionsFilePath()`：先看環境變數 `SVN_CONNECTIONS_FILE`，沒有就用 `<svn-mcp 目錄>/info/svn-connections.json`；連線的查找與路徑檢查重用 `resolveConnection`。
- **打包成執行檔時，預設路徑要特別處理。** `pkg` 打包後 `__dirname` 指向內部虛擬檔案系統，不是真實目錄。執行檔改用 `path.dirname(process.execPath)/../info/svn-connections.json`（執行檔放在 `dist-exe/`，剛好對應原本的預設位置），環境變數優先順序不變。這要寫一個測試鎖住。
- 設定檔內容維持現有格式（連線 id、name、url、username、password），不新增欄位，所以舊的唯讀工具不受影響。
- 設定頁（第一次啟動、尚無設定檔或沒有任何連線時顯示）可以新增、編輯連線，寫入同一份檔案：
  - 以原子方式寫入（先寫暫存檔再改名），避免寫到一半被唯讀工具讀到殘缺內容。
  - 設定頁絕不回傳密碼給瀏覽器（編輯時密碼欄留空代表「不變更」）。
  - 設定頁的端點同樣要 token，只綁 `127.0.0.1`。
- 設定檔已被 `svn-mcp/.gitignore`（`info/`）排除，沒有被 git 追蹤，帳密不會被推上 GitHub。
- 現況是明文密碼，沿用現有作法，不在這次需求內改變。

## 已確認的決定

- 控制頁形式：瀏覽器開 localhost 小頁面，不做桌面視窗。
- docx、xlsx 預設鎖定。
- 衝突第一版採「拒絕加手動比對」。
- 新增檔案排在 P3，先把修改既有檔案做穩。
- dev-pipeline 按鈕直接連接執行檔，不另外設計端點。
- 啟動方式：連接 svn-mcp 時自動拉起（冪等、分離模式、閒置自行結束），並提供手動啟動備援。
- SVN 倉庫協定為 `https`（已確認 4 個連線皆是），鎖定與遠端檢查可正常使用；正式環境仍需實測一次鎖定。
- 使用對象包含同事；每位同事使用各自的 SVN 帳號；`svn` 命令列工具第一版由使用者自行安裝，不隨附。
- 連線設定與 svn-mcp 唯讀工具共用同一份 `svn-connections.json`，不另建一份。

## 實作紀錄（與草案不同、或實作時才發現的地方）

- **Windows 上拉起背景服務比預期麻煩。** 光用 `spawn(..., { detached: true, stdio: "ignore" })` 不夠：子程序仍會繼承父程序的管道控制代碼，測試時就因此卡住等不到結束。實際使用時，svn-mcp 的 stdout 是 MCP 通訊管道，服務握著它會讓等待管道結束的一方被卡住。
  最後的做法是 Windows 改由 PowerShell 的 `Start-Process` 建立服務（不繼承控制代碼）；PowerShell 本身**不能**加 `detached`（沒有主控台拉不起服務），所以 `ensureEditServer` 會等 PowerShell 拉完才回傳（Node 會把非 detached 的子程序放進「父程序結束就一起被殺」的 Job，父程序太早結束 PowerShell 會被一起殺掉）。`tests/edit-autostart.test.mjs` 有兩個專門的測試鎖住這兩件事。
- **GET 確認頁加上一次性 token。** `GET /` 與 `GET /edit` 回傳的頁面內嵌每次啟動隨機產生的 token，頁面之後的操作一律帶 `X-Edit-Token`；另外檢查 `Host`（擋 DNS rebinding）與 `Origin`。
- **新增 `edit-main.ts` 與 `edit-server.ts` 分離。** 伺服器可以在測試裡用隨機埠啟動；入口檔負責埠被占用時的處理（手動啟動時順便幫使用者打開已在跑的那個）、閒置自動結束。
- **連線設定檔路徑**：`config-store.ts` 新增 `getInstallRoot()`；打包成執行檔後改用「執行檔所在目錄的上一層」，已用打包出的執行檔實測讀到共用的 `info/svn-connections.json`。
- **前端實測抓到的 bug**：控制頁的 `h()` 小工具原本不接受陣列子節點，已有連線時設定區會組不出來，且錯誤被 `refresh()` 的 `.catch` 吞掉。已修正並改成「連線失敗」與「畫面錯誤」分開顯示；設定區的簽章改成建完才寫入。這個 bug 單靠伺服器端測試找不到，是用無頭 Chrome 實際走完整流程才發現的。

## 尚未驗證

- **https 正式環境的鎖定行為**：所有測試都用本機 `file://` 儲存庫；鎖定、遠端版本檢查在 https 正式環境仍需用測試檔案實測一次。
- **真實 Word／Excel 開啟流程**：測試以「暫存資料夾裡改檔案」模擬使用者編輯，並用 `SVN_EDIT_NO_LAUNCH=1` 避免真的開啟程式；實際用 Word 開啟、修改、關閉、上傳的體驗需要人工驗證一次。
- **瀏覽器擴充功能連不到本機服務**：這次的自動化瀏覽器（Claude in Chrome）連 `127.0.0.1` 會顯示錯誤頁，所以前端改用無頭 Chrome 加遠端除錯協定驗證；一般的瀏覽器使用不受影響，但值得在使用者自己的瀏覽器上打開一次確認。

## P3 實作紀錄（新增檔案）

- 核心 `importNewFile`（`remote-edit-client.ts`）＋ `POST /api/import`（檔案內容放請求本文，其餘參數放查詢字串）＋控制頁「新增檔案到 SVN」卡片。
- 屬性用 `svn import --config-option` 的 auto-props 在**同一個 revision** 一起設定，不需要第二次提交；已用測試確認 docx／xlsx 有 `svn:needs-lock`、md 有 `svn:eol-style=native`。
- **`eol-style=native` 的副作用**：倉庫裡存 LF，在 Windows 上取出或 `svn cat` 會變成 CRLF，這是 native 的正常行為。如果上傳的 md／txt 本身換行字元混用（LF 與 CRLF 混在一起），svn 可能拒絕並回報錯誤；目前沒有特別處理，錯誤訊息會原樣顯示在控制頁。
- **測試抓到的輸入驗證漏洞（已修）**：路徑 `file:///c:/x.md` 在整理路徑時被壓成 `file:/c:/x.md`，繞過「完整 URL」的檢查，會在倉庫裡建出 `file:`、`c:` 這種 Windows 無法取出的資料夾。現在路徑區段不允許 `: * ? " < > |` 與控制字元，開啟編輯與新增檔案兩條路徑都套用。

## P4 待決

dev-pipeline 的「待人工處理」報告頁面裡，**沒有「某張票對應 SVN 上哪一個檔案」的資料**：
- `self-generated` 模式的 SD 是本機檔案（`sdOutputPath`），不在 SVN 上；
- `external`／`self` 模式只登記了規格書的根目錄（`saRoot`／`sdRoot`）與連線 id，沒有逐票的檔名。

所以按鈕目前沒有 `path` 可以帶入連結。可行的方向：
1. 在 svn-edit 控制頁加「瀏覽 SVN 目錄」，按鈕只帶 `connection` 與起始目錄（`saRoot`／`sdRoot`），由使用者在控制頁點選檔案。
2. 在票單資料裡新增「這張票的規格書路徑」欄位，按鈕直接帶完整路徑。
3. 先不做按鈕，使用者直接開控制頁、手動輸入路徑（現在就能用）。

### P4 進度（2026-10-08）

- **已完成（svn-edit 端）**：`GET /api/browse`（唯讀，`svn list`）＋控制頁「瀏覽 SVN 目錄」卡片；用 `/?connection=…&browse=<目錄>&ticket=<票號>` 進入會自動展開並載入該目錄，點檔案跳確認頁、票號預填 commit 訊息。伺服器測試與無頭 Chrome 流程測試都通過。
- **未做（dev-pipeline 端）**：讀程式碼後發現原本的預設決定有兩個問題，需要重新決定：
  1. 報告頁「規格草稿待確認」區（`awaitingSpecConfirmation`）只會出現在 `self-generated` 專案（`stage === "sd_drafted"`），那種專案的 SD 是本機檔案（`sdOutputPath`），**不在 SVN 上**，也不一定登記了 SVN 連線；按鈕放這一區對不上。
  2. `writePendingActionsReport` 只收 `projectDir`／`projectName`，沒有專案 ID（`projectGid`）；其中 `syncPendingActionsReportForProject` 這條呼叫路徑完全拿不到，要讀 `resolveSasdConfig(projectGid)` 得多改一段（例如在追蹤目錄記下 projectGid）。
  可行方向：(a) 報告頁頂端放一個「專案層級」的連結（`external`／`self` 專案才顯示，起始目錄用 `sdRoot`，沒有則 `saRoot`）；(b) 只在有登記 SVN 連線的專案顯示；(c) 先不做按鈕。

### P4 完成紀錄（2026-10-08）

採用方案 (a)：dev-pipeline 的 `PENDING_HUMAN_ACTIONS.html` 上方多一個**專案層級**的「編輯 SVN 上的規格書」區塊，連到 `http://127.0.0.1:8096/?connection=<svnConnectionId>&browse=<sdRoot 或 saRoot>`。
- 只在 `sdMode` 是 `external`／`self` 且登記了 `svnConnectionId` 的專案顯示；`self-generated`（SD 是本機檔案）不顯示。
- 專案 ID 從專案底下任一張票的 `project_gid` 反查（舊票單要等下次 `get_ticket_snapshot` 才有），所以 `writePendingActionsReport` 的簽名完全沒變。
- dev-pipeline-mcp 這邊只有 `src/svn-edit-link.ts`（組連結與區塊 HTML），沒有任何 SVN 邏輯，也沒有新增 MCP 工具或 bridge 端點。
- 因為按鈕是專案層級，不帶票號；票號預填 commit 訊息的功能（`ticket` 參數）仍然保留在 svn-edit 端，之後若要做逐票按鈕可直接使用。
- 已知限制：已經在跑的 dev-pipeline-mcp 行程要重新連線（新的 Claude Code session）才會載入新程式，之後產生的報告才有這個區塊。
