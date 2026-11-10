| 程式代號 | orders-export | 使用技術 | Node.js 22 / 內建 http / SQLite 3 |
| --- | --- | --- | --- |
| 程式名稱 | 會員匯出訂單 Excel | 系統分析者 | 系統分析師 |
| 上層程式名稱 | 會員中心 | 程式設計者 |  |
| 程式類別 | 查詢＋Excel 匯出 | 審查者 |  |

## 版本管控歷程

| 版次 | 發行日期 | 修訂說明 | 修訂單位 | 修訂人員 |
| --- | --- | --- | --- | --- |
| 0.1 | 2026/11/10 | 初版 | 示範團隊 | 系統分析師 |

## 目錄

一、規格說明
&nbsp;&nbsp;1. 使用資料表
&nbsp;&nbsp;2. 前端功能與 API 對應表
&nbsp;&nbsp;3. 共用方法清單
&nbsp;&nbsp;4. 共用回應與錯誤碼

二、API 說明
&nbsp;&nbsp;1. 查詢訂單列表
&nbsp;&nbsp;2. 匯出訂單 Excel


## 規格說明

### 1. 使用資料表

| Table | 功能 | 說明 | 結構文件 |
| --- | --- | --- | --- |
| members | 會員 | 會員基本資料 | [members 資料表結構](TableSchema/members.md) |
| orders | 訂單主檔 | 訂單編號、所屬會員、下單時間 | [orders 資料表結構](TableSchema/orders.md) |
| order_items | 訂單明細 | 每項商品的名稱、數量、小計 | [order_items 資料表結構](TableSchema/order_items.md) |

### 2. 前端功能與 API 對應表

| 前端功能 | 觸發時機 | 呼叫的 API | 成功時 | 失敗時 | 前端位置 |
| --- | --- | --- | --- | --- | --- |
| 顯示訂單列表 | 開啟「我的訂單」頁面 | 查詢訂單列表 `GET /api/orders`（start＝本月 1 日、end＝今天） | 列表顯示該區間訂單 | 日期檢核不通過：欄位下方提示且不呼叫 API；其他錯誤依錯誤碼顯示（見錯誤碼表的提示位置） | public/app.js、public/logic.js |
| 更新訂單列表 | 改變「起」或「迄」日期 | 查詢訂單列表 `GET /api/orders` | 列表更新為新區間（只採用最後一次請求的結果） | 日期檢核不通過：欄位下方提示，列表維持原內容、不呼叫 API；查詢失敗：列表區提示 | public/app.js |
| 匯出 Excel | 按下「匯出 Excel」 | 匯出訂單 Excel `GET /api/orders/export` | 瀏覽器存檔；回應標示為空時顯示「此區間沒有訂單」 | 日期檢核不通過：欄位下方提示、按鈕不能按；其他錯誤依錯誤碼顯示在訊息區，列表不受影響 | public/app.js、public/logic.js |
| 尚未登入或登入失效 | 任一 API 回 401 | 兩支 API 皆適用 | 前往登入頁，登入後回到「我的訂單」頁面 | — | public/logic.js、public/config.js |

### 3. 共用方法清單

| 共用方法 | 位置 | 類型 | 被誰使用 | 說明 |
| --- | --- | --- | --- | --- |
| getMemberId | src/auth.js | 新建共用 | 兩支 API 的控制層 | 取得登入會員 id 的固定介面；目前為測試用實作，登入功能由另一支程式提供 |
| validateRange | src/order-query.js | 新建共用 | 兩支 API 的服務層 | 日期區間驗證（必填、格式、起迄順序、366 天） |
| isValidDateString、nextDay、diffDays | src/date-utils.js | 新建共用 | validateRange、前端 | 日期字串運算；不使用 src/util.js 的 formatDate（以 UTC 輸出，會讓部分訂單日期差一天） |
| sendError | src/http-errors.js | 新建共用 | 兩支 API 的控制層 | 統一的 code 與 message 輸出 |
| findOrderRows | src/repositories/order-repository.js | 新建共用 | 兩支 API 的服務層 | 依會員與日期區間查詢訂單明細 |
| buildXlsx | src/xlsx-writer.js | 新建專用 | 匯出 API 的服務層 | 組出 Excel 檔，只有匯出使用 |

### 4. 共用回應與錯誤碼

| HTTP | code | message | 說明 | 檢核位置 | 前端提示位置 |
| --- | --- | --- | --- | --- | --- |
| 400 | DATE_REQUIRED | 請選擇日期區間 | 缺少起日或迄日 | 前端即時檢核；後端再檢核 | 日期欄位下方 |
| 400 | DATE_ORDER | 起日不可晚於迄日 | | 前端即時檢核；後端再檢核 | 日期欄位下方 |
| 400 | RANGE_TOO_LONG | 日期區間不可超過 366 天 | | 前端即時檢核；後端再檢核 | 日期欄位下方 |
| 400 | DATE_INVALID | 日期格式不正確 | 非 YYYY-MM-DD 或日期不存在 | 僅後端（日期欄位為日期選擇器，前端不會產生） | 訊息區 |
| 401 | UNAUTHORIZED | 請先登入 | 未登入或登入失效 | 僅後端 | 前往登入頁 |
| 413 | TOO_MANY_ROWS | 資料量過大，請縮小日期區間 | 超過 10000 列 | 僅後端 | 訊息區 |
| 500 | EXPORT_FAILED | 匯出失敗，請稍後再試 | 匯出時發生非預期錯誤 | 僅後端 | 訊息區 |
| 500 | LIST_FAILED | 查詢失敗，請稍後再試 | 列表查詢時發生非預期錯誤 | 僅後端 | 列表區 |

前端即時檢核的三項（DATE_REQUIRED、DATE_ORDER、RANGE_TOO_LONG）在改變日期時立即檢查，不通過時不呼叫 API，也不能按「匯出 Excel」；後端對所有請求一律再檢核一次，前端被略過時由後端以相同 code 與 message 回應，前端顯示在訊息區。

回應格式：`{ "code": "...", "message": "..." }`。

## API 說明

### 1. 查詢訂單列表

**URL:** /api/orders

**METHOD:** GET

**Controller:** src/controllers/orders-controller.js ── listOrders()

**Service:** src/services/order-service.js ── listOrders()

**Repository:** src/repositories/order-repository.js ── findOrderRows()

**使用的共用方法:** getMemberId、validateRange（內含 isValidDateString、nextDay、diffDays）、findOrderRows、sendError

#### INPUT

| ElementName | ElementType | 必填 | 對應 DB 欄位 | 註解 |
| --- | --- | --- | --- | --- |
| start | string | Y | orders.ordered_at | 起日，YYYY-MM-DD；缺少回 DATE_REQUIRED |
| end | string | Y | orders.ordered_at | 迄日，YYYY-MM-DD，包含當天 |

#### 業務邏輯
1. 先確認登入，未登入回 401。
2. 驗證日期區間（必填、格式、起日不晚於迄日、不超過 366 天），不合法回 400。
3. 只查該會員本人的訂單，下單時間大於等於起日 00:00:00 且小於迄日隔天 00:00:00。
4. 每項商品一列，依下單時間、訂單編號、明細順序由舊到新排列。

#### OUTPUT

| ElementName | ElementType | 說明 |
| --- | --- | --- |
| orderNo | string | 訂單編號 |
| orderedDate | string | 下單日期（取下單時間前 10 個字元，年-月-日） |
| productName | string | 商品名稱 |
| quantity | number | 數量 |
| subtotal | number | 該項商品小計 |

---

### 2. 匯出訂單 Excel

**URL:** /api/orders/export

**METHOD:** GET

**Controller:** src/controllers/orders-controller.js ── exportOrders()

**Service:** src/services/order-service.js ── exportOrders()

**Repository:** src/repositories/order-repository.js ── findOrderRows()

**使用的共用方法:** getMemberId、validateRange、findOrderRows、sendError、buildXlsx

#### INPUT

| ElementName | ElementType | 必填 | 對應 DB 欄位 | 註解 |
| --- | --- | --- | --- | --- |
| start | string | Y | orders.ordered_at | 起日，YYYY-MM-DD |
| end | string | Y | orders.ordered_at | 迄日，YYYY-MM-DD，包含當天 |

#### 業務邏輯
1. 登入與日期驗證同「查詢訂單列表」。
2. 查詢最多取 10001 列，超過 10000 回 413，不產生檔案。
3. 區間內沒有訂單時仍產生只有標題列的檔案，並在回應標頭標示為空。
4. 回應檔名「訂單_起日_迄日.xlsx」，並加上不快取標頭。

#### OUTPUT
HTTP 200，Excel 檔案。欄位：訂單編號、下單日期、商品名稱、數量、金額（數值，千分位）。
