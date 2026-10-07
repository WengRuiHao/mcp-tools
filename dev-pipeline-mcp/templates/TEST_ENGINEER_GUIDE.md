# 測試工程師說明書

## 定位：跟「驗證師」角色的差異

驗證師角色做的是「核對工程師的修改是否確實解決票單描述的問題」——比對規格/程式碼是否一致，屬於**交叉核對**。

這份文件是給**設計測試案例、實際跑手動/情境測試**時查的檢查清單，適用對象：

- 驗證師階段判斷「該測哪些情境」時可以參考
- 使用者自己手動驗收前可以照著測
- 涉及報表輸出、老舊系統（JDK6 + 舊 IE 這類環境）時，通用測試框架不夠用，要另外看對應章節

三章節彼此獨立，依專案性質挑對應章節看，不需要每次全讀：一般功能改動看「一、通用測試框架」；報表相關改動加看「二、報表測試」；老舊系統（JDK6 + 舊 IE）改動加看「三、老舊系統測試」。

**例外：第五章「測試證據」每張票都要套用**（`record_test_evidence`、測試層級、機密遮蔽、Excel/PDF 截圖與假資料標註），不能因為專案性質而略過。

---

## 一、通用測試框架（所有專案共通）

### 等價分類與邊界值

- 合法範圍的頭尾值（最小值、最大值、剛好等於邊界）
- 剛好超出邊界一單位（邊界值 +1 / -1）
- 空值、null、空字串、全空白字串
- 極端長度字串（超長輸入、單一字元）
- 型別邊界（數字欄位塞入非數字、日期欄位塞入不合法日期）

### 狀態機／流程跳轉測試

- 逐一測試「不該發生的跳轉」，不是只測 happy path 的正向流程
- 例如：已核准的單再核准一次、已作廢的單被修改、流程卡在中間狀態時重複觸發同一動作
- 兩個使用者同時對同一筆資料做互斥操作（搶單、重複送出）

### 權限與角色矩陣

- 每個角色 × 每個操作交叉測試，重點抓「應該擋卻沒擋」
- 越權存取：用角色 A 的帳號直接呼叫角色 B 才能用的功能/API/頁面
- 資料範圍越權：同角色但不同承辦範圍的資料能不能被看到/修改

### 負向測試

- 刻意送錯誤格式、超長輸入、SQL/HTML 特殊字元，確認有被擋下而不是丟出未處理例外或吐出敏感錯誤訊息
- 必填欄位留空、選填欄位帶入不合理組合
- 重複送出同一筆請求（雙擊送出鍵、重整後再送一次）

### 回歸測試

- **改動前先跑一次現有行為當基準記錄下來**，改完再比對差異，不是只驗證「新需求有沒有滿足」
- 特別注意這次改動範圍以外、但共用同一段邏輯/同一張表的功能有沒有被連帶影響
- 有自動化測試的，本地先跑過一次確認全綠，再開始手動測試

---

## 二、報表測試（Crystal → Jasper 遷移類報表適用，可搭配 `crystal-to-jasper-mcp`）

報表類問題通常不是「有沒有跑出來」，而是藏在版面細節裡，逐項列出來測，不要只看整體像不像。

### 分組／小計／合計

- Group break 換組時小計是否歸零重算
- 跨頁時小計/合計是否正確延續（不會歸零，也不會累加兩次）
- 巢狀分組（組中有組）時，每一層小計各自正確

### 分頁與跨頁表頭

- 多頁報表每一頁的表頭/表尾是否正確重複
- 最後一頁筆數剛好用完一整頁、或剛好多一筆跨到下一頁時的邊界情況
- 分頁後合計/總筆數的頁碼、總頁數顯示是否正確

### 格式在地化

- 千分位、小數位數、日期格式（民國年/西元年）、幣別符號
- 多國語系 Excel 輸出，固定套用既有規則：i18n Excel 5 欄單一工作表範本，新增 caption key 要主動產出對應語系欄位

### 空值／零值抑制

- 舊 Crystal Report 常見「值為 0 不顯示」「值為 null 顯示空白而非 0」這類隱藏邏輯，轉 Jasper 時最容易漏
- 測試時要刻意準備「某欄位為 0」「某欄位為 null」的資料列分別驗證

### 新舊報表逐欄比對（遷移類報表的驗收基準）

1. 用 `inspect_crystal_report` / `dump_report_layout` 先把舊報表的欄位、公式、分組邏輯列成清單
2. 用 `generate_jrxml_draft` 產出的新版報表，逐欄比對上一步列出的清單，而不是肉眼看整體排版像不像
3. 公式邏輯（加總方式、條件顯示規則）要對照舊報表原始公式，確認語意一致，不是只比對輸出數字剛好一樣（同樣的輸出可能來自錯的公式+巧合的測試資料）

### 大資料量效能

- 小量資料測正常、務必額外用大量資料（接近正式環境量級）測一次，常見問題：分頁跑很慢、版面跑掉、記憶體不足

---

## 三、老舊系統測試（JDK6 + 舊 IE 這類環境適用）

這類系統的核心問題是工具鏈跟現代測試生態脫節，先劃清「能自動化」跟「只能手動」，不要硬套現代工具。

### 環境準備 Checklist（測試前必查）

- **確認 document mode**：多半靠 `<meta http-equiv="X-UA-Compatible">` 或伺服器端 header 鎖定，F12 → Emulation 分頁實際確認目前跑的 doc mode，不能只看瀏覽器版本號
- **VM snapshot 固定測試環境**：現行 Windows 10/11 已無原生 IE8/9，只能用舊版 OS 的 VM 或 IE11 相容模式模擬——**手冊上要註明這是模擬環境，跟真實老 IE 有落差，發現差異以實機為準**
- **字元編碼**：這類系統常見 Big5/MS950，測試資料故意放中文全形符號、生僻字，確認沒有亂碼——這個問題在 UTF-8 環境測不出來，一定要在對應編碼環境下測
- **建置版本鎖定**：完整重編譯要用專案實際指定的 JDK 版本（例如 JDK6），不是開發機預設安裝的較新版本

### 自動化 ROI 低的部分，直接走手動 + 截圖比對

- Selenium 的 IEDriverServer 對 IE8/9 支援度差、極不穩定，這類頁面**直接標記「手動測試，不強求自動化覆蓋」**，避免浪費工時硬套工具
- 改動前先截一份「現況畫面」存底，改完後截圖比對差異，重點放在版面有沒有跑掉（老 IE 常見 table-layout 排版、無 flexbox）

### 瀏覽器相依功能清單（優先手動測）

- ActiveX 元件（列印元件、憑證簽章、讀卡機）在現代瀏覽器測不出來，必須在指定 IE 版本上實測
- 建立「元件版本 × IE 版本」相容矩陣紀錄，因為 ActiveX 元件本身也有版本相依問題
- 列印功能獨立測試：老 IE 列印預覽/分頁規則跟一般畫面渲染規則不同

### 老版本 JDK 建置端測試要點

- **不能只看 IDE 編譯過就當作沒問題**：IDE 預設 language level 常是較新版本，開發者可能不小心用了 diamond operator、try-with-resources、lambda 這類老版本 JDK 不支援的語法，IDE 沒噴錯不代表用指定版本 `javac` 實際編譯也會過
- 測試流程要求**實際用專案指定的 JDK 版本編譯一次**，不能只信任 IDE 或現代建置工具的語法檢查

### 已知怪異行為要先記基準，避免誤判

- 老系統常有「看起來像 bug 但其實一直都這樣」的行為（例如函式名稱寫著即時計算、實際內部邏輯是寫死值的案例）
- 測試前先跑一次現況記錄當基準，測試時只抓「跟基準不一樣」的差異，不要把系統原本就有的怪異行為當成這次改動引入的新 bug 回報

---

## 四、專案專屬補充（延伸方向）

上面三章是通用框架，個別專案如果有自己的特殊測試慣例（例如某系統驗證方式是重啟特定服務、而不是重新編譯），建議另外用專案自己的設定或文件記錄，不要塞進這份通用文件，避免內容越滾越大、通用性被稀釋。

---

## 五、測試證據（每張票都要；Excel／PDF、API、測試報告、DB 狀態）

`write_ticket_artifact` 寫 `04-test.md`、`advance_ticket_stage` 推進到 `tested` 都會檢查：**每張票至少要有 1 筆用 `record_test_evidence` 記錄的測試證據**。證據會被**複製**備份到票單追蹤目錄的 `test-evidence/` 讓使用者回頭觀察；每筆都標明是哪個功能、哪種類型、什麼測試層級、是假資料還是真實資料。

### 5.0 每筆證據只存一個檔案，假資料一眼看得出來

| 情況 | 資料夾 | 證據檔 | 截圖 |
|------|--------|--------|------|
| 真實資料（`usesFakeData=false`） | `test-evidence/<功能名稱>/` | `<原檔名>.<副檔名>`（不加任何後綴） | `<原檔名>_截圖_<序號>.<副檔名>` |
| 假資料（`usesFakeData=true`） | `test-evidence/【假資料】<功能名稱>/` | `<原檔名>_假資料.<副檔名>` | `<原檔名>_假資料_截圖_<序號>.<副檔名>` |

- **不再另存「原始」或「標註副本」兩份**。假資料的 excel／pdf 只存你提供的 `markedFile`（已標註的副本，改名為 `_假資料`）；`sourceFile` 不複製，只在 `status.json` 記下它的絕對路徑與 sha256 供追溯。其他類型存 `sourceFile` 本身。
- 同一功能若同時有假資料與真實資料的證據，會分在兩個資料夾。同一筆（功能名稱＋原檔名）把 `usesFakeData` 改掉再呼叫，會把檔案搬到新資料夾並刪掉舊檔。
- 舊格式備份（`_原始`、`_假資料標註`、舊資料夾名）在同一筆再次呼叫時會被換成新命名、舊檔刪除、舊資料夾空了就移除。**清理舊檔失敗（例如舊檔正被 Excel 開著，資料夾裡會有 `~$` 鎖定檔）不會讓登記失敗**：新檔已就位、status 已更新，呼叫仍回 `success:true`，並帶 `cleanupWarnings`（相對路徑與原因）與「已登記，但有 N 個舊檔未能刪除」的說明；關閉檔案後用同功能名稱與原檔名再呼叫一次就會重試清理（鎖定檔不再被占用時一併刪除，資料夾真的清空才移除）。`get_ticket_status` 的 `test_evidence.stale_old_backups` 會提示仍有未清理的舊備份。

### 5.1 測試層級（testLevel，每筆證據必填）

| testLevel | 意義 | 可以宣稱的範圍 |
|-----------|------|----------------|
| `unit-mock` | 依賴（資料庫、外部服務）全是 mock | 只能說「邏輯在 mock 條件下正確」 |
| `integration-db` | 有連真實資料庫 | 可說已驗證真實 DB 行為，但不能說已驗證整條 API |
| `live-api` | 打真實運行中的服務 | 可說已驗證真實 API |

層級由低到高：`unit-mock` < `integration-db` < `live-api`。`04-test.md` 宣告的 `testLevel` **必須等於證據中最高的層級**（不可灌水也不可低報）。**只有 `unit-mock` 證據時，不得宣稱已驗證真實資料庫或真實 API**，要寫明「僅 mock 層級驗證」。

### 5.2 證據類型與取得方式（fileKind）

| fileKind | 內容 | 副檔名 | 取得方式 |
|----------|------|--------|----------|
| `api-call` | 實際呼叫記錄原文：method、URL、request、HTTP 狀態、response、耗時 | `.json` `.txt` `.http` `.md` | 從真實呼叫擷取（例如 `curl -i -w "\n耗時 %{time_total}s\n"`、測試框架實際輸出）。**禁止手寫或憑記憶改寫 response** |
| `test-report` | 測試執行報告 | `.xml` `.html` `.txt` `.json` | 備份 `build/test-results` 等處的實際報告檔（JUnit XML/HTML），並在 `04-test.md` 記錄通過／失敗數 |
| `db-state` | 資料庫測試前後狀態 | `.csv` `.json` `.txt` `.md` | 用 db-mcp 的 `db_query`（唯讀）把測試前後的 SELECT 結果各存一份 |
| `excel` | 實際產出的 Excel | `.xlsx` `.xls` | 見 5.4 |
| `pdf` | 實際產出的 PDF | `.pdf` | 見 5.5 |

`api-call`／`test-report`／`db-state` 的截圖可省略（不會產生待截圖旗標）。

### 5.3 機密遮蔽與假資料標註（文字類證據）

- **機密一律遮蔽成 `****`**：Authorization／Bearer token、JWT（`eyJ…` 三段式）、`password`／`secret`／`api key`／`token` 後面的值、連線字串裡的帳密。`record_test_evidence` 會掃描這三類文字檔，命中就拒絕並回報檔名與行號（不會回印疑似機密的內容本身），遮蔽後重新呼叫即可。已寫成 `****`、`<redacted>` 的值視為安全。
- **假資料**：`usesFakeData=true` 時，標註文字固定為 `【測試假資料，非正式資料】`。
  - `api-call`／`db-state`：`sourceFile` 的**第一個非空白行**必須就是這段文字（工具會讀檔驗證；存進證據資料夾的就是這個檔案，不需要 `markedFile`）。JSON 檔第一行放標註會讓它不是合法 JSON，建議這類證據存成 `.txt`／`.md`／`.http`。
  - `test-report`：由建置工具產生，不改檔內容；只靠檔名（`_假資料`）、資料夾（`【假資料】`）與記錄標示，`usesFakeData` 記在記錄裡。
  - `excel`／`pdf`：見下方，標註在 `markedFile` 副本上。

### 5.4 Excel 證據

**為什麼 Excel 要人工截圖**：這台機器沒有 Excel／LibreOffice，無法對實際 xlsx 做真實渲染；而「用 Python 轉成網頁重畫」「依公式重算」都不是實際檔案的畫面，**不能當證據**。所以流程是：

1. 備份證據檔（真實資料存 xlsx 本身；假資料存標註副本）；`record_test_evidence` 不帶 `screenshotPaths`，會標記 `pendingManualScreenshot=true`。
2. 寫 `04-test.md` 時，工具**自動**在 manualActions 加一條待辦：「請用 Excel 開啟 …，截圖後放進同一資料夾（或請 AI 用 record_test_evidence 補登）」。
3. 使用者開啟證據檔截圖，放進同一資料夾；再請 AI 用同樣的 `featureName` 與 `sourceFile` 呼叫 `record_test_evidence` 並帶 `screenshotPaths`，就會更新同一筆並清除待截圖旗標與待辦。
4. 不得以任何自動方式產生 Excel 的假截圖。

**假資料標註要醒目**：標註文字**紅字、粗體、字級 14 以上**，放在截圖第一眼就看得到的位置——前 5 列內第一個完全空白的列（含緊貼表格下方那一列），沒有的話放在前 5 列某列最後一個資料格的右邊，再不行才用已用範圍內第一個空白列或表格正下方；**不要放到遠離資料的欄**（例如 K1）。只寫入空白儲存格，**不得更動任何既有儲存格與合併範圍**。標註只做在副本，實際產出的原始檔不要動（也不會被備份）。範例（會自動找位置）：

```python
import sys
from openpyxl import load_workbook
from openpyxl.styles import Font

LABEL = "【測試假資料，非正式資料】"
TOP_ROWS = 5  # 截圖第一眼看得到的範圍：前 5 列


def merged_coordinates(ws):
    return {
        cell.coordinate
        for rng in ws.merged_cells.ranges
        for row in ws.iter_rows(min_row=rng.min_row, max_row=rng.max_row, min_col=rng.min_col, max_col=rng.max_col)
        for cell in row
    }


def find_label_spot(ws):
    """回傳 (列, 欄, 是否整列空白)：醒目又不會動到既有內容的位置。

    1) 前 5 列內第一個完全空白的列（含緊貼表格下方的那一列），放在 A 欄；
    2) 否則前 5 列內某一列「最後一個有資料的欄」右邊的第一格（緊貼資料，不會跑到遠處的欄）；
    3) 否則已用範圍內第一個完全空白的列；
    4) 都沒有就放在表格正下方的下一列。
    """
    max_row, max_col = ws.max_row, ws.max_column  # 先固定範圍，避免讀取時範圍被撐大
    merged = merged_coordinates(ws)

    def row_cells(r):
        return [ws.cell(row=r, column=c) for c in range(1, max_col + 1)]

    def is_blank_row(r):
        return all(cell.value is None and cell.coordinate not in merged for cell in row_cells(r))

    for r in range(1, min(max_row + 1, TOP_ROWS) + 1):
        if is_blank_row(r):
            return r, 1, True
    for r in range(1, min(max_row, TOP_ROWS) + 1):
        used = [cell.column for cell in row_cells(r) if cell.value is not None or cell.coordinate in merged]
        c = (max(used) if used else 0) + 1
        if ws.cell(row=r, column=c).coordinate not in merged:
            return r, c, False
    for r in range(TOP_ROWS + 1, max_row + 1):
        if is_blank_row(r):
            return r, 1, True
    return max_row + 1, 1, True


def mark_excel(src, dst):
    wb = load_workbook(src)  # 公式與格式保留；圖表、圖片、樞紐分析表可能遺失（見說明）
    for ws in wb.worksheets:
        r, c, blank_row = find_label_spot(ws)
        cell = ws.cell(row=r, column=c)
        cell.value = LABEL  # 只寫入空白儲存格，不動任何既有儲存格與合併範圍
        cell.font = Font(color="FFFF0000", bold=True, size=16)  # 紅字、粗體、16 級字
        if blank_row:
            ws.row_dimensions[r].height = 28  # 整列本來就是空白，加高避免大字被裁掉
    wb.save(dst)


if __name__ == "__main__":
    mark_excel(sys.argv[1], sys.argv[2])
```

限制：`openpyxl` 不支援 `.xls`，且重新儲存可能遺失圖表、圖片、樞紐分析表。遇到這些情況，改在 Excel 開啟副本、於空白儲存格手動輸入紅字粗體（14 級以上）標註，並在 `note` 說明。標註是否真的寫進檔案，工具無法自動驗證，只能要求你帶 `fakeDataMarked: true` 明確確認。

### 5.5 PDF 證據

PDF 可以真實渲染：用 PyMuPDF（pip 套件 `pymupdf`）把**實際 PDF** 逐頁轉成 PNG，屬於真實渲染，可全自動。`fileKind=pdf` 時 `screenshotPaths` 必填至少 1 張。**若本機裝不到 PyMuPDF，就比照 Excel 走人工截圖（請使用者開 PDF 截圖），不得用其他推算或重畫方式代替。**

逐頁轉 PNG：

```python
import sys
from pathlib import Path
import pymupdf


def pdf_to_png(pdf_path, out_dir, dpi=130):
    """把實際 PDF 逐頁渲染成 PNG（真實渲染，不是重畫）。回傳 PNG 路徑清單。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths = []
    with pymupdf.open(pdf_path) as doc:
        for i, page in enumerate(doc, start=1):
            target = out / f"{Path(pdf_path).stem}_p{i}.png"
            page.get_pixmap(dpi=dpi).save(target)
            paths.append(str(target))
    return paths


if __name__ == "__main__":
    for p in pdf_to_png(sys.argv[1], sys.argv[2]):
        print(p)
```

假資料浮水印（每頁加斜向文字，只做在副本 `markedFile`；截圖用標註後的副本）：

```python
import sys
import pymupdf

LABEL = "【測試假資料，非正式資料】"


def mark_pdf(src, dst):
    doc = pymupdf.open(src)
    for page in doc:
        rect = page.rect
        center = pymupdf.Point(rect.width / 2, rect.height / 2)
        page.insert_text(
            pymupdf.Point(rect.width * 0.08, rect.height * 0.58),
            LABEL,
            fontsize=30,
            fontname="china-t",  # 內建繁中字型，不需額外安裝
            color=(1, 0, 0),
            fill_opacity=0.5,
            morph=(center, pymupdf.Matrix(35)),  # 以頁面中心旋轉成斜向
        )
    doc.save(dst)
    doc.close()


if __name__ == "__main__":
    mark_pdf(sys.argv[1], sys.argv[2])
```

### 5.6 呼叫 record_test_evidence

```text
# Excel：用了假資料，只存標註副本，尚無截圖（待使用者截圖）
# 結果：test-evidence/【假資料】月報表 Excel 匯出/export_假資料.xlsx（sourceFile 只記路徑與 sha256）
record_test_evidence({
  taskGid: "<票單 gid>",
  featureName: "月報表 Excel 匯出",
  fileKind: "excel",
  testLevel: "integration-db",
  testSource: "呼叫匯出 API 取得 xlsx",
  sourceFile: "C:\\temp\\export.xlsx",
  usesFakeData: true,
  markedFile: "C:\\temp\\export_marked.xlsx",
  fakeDataMarked: true
})

# PDF：真實資料，實際 PDF 加上 PyMuPDF 渲染的截圖
record_test_evidence({
  taskGid: "<票單 gid>", featureName: "月報表 PDF 列印", fileKind: "pdf", testLevel: "live-api",
  sourceFile: "C:\\temp\\report.pdf", usesFakeData: false,
  screenshotPaths: ["C:\\temp\\out\\report_p1.png", "C:\\temp\\out\\report_p2.png"]
})

# API 呼叫原文（已遮蔽 token）
record_test_evidence({
  taskGid: "<票單 gid>", featureName: "新增申請單 API", fileKind: "api-call", testLevel: "live-api",
  testSource: "curl -i POST /api/applications", sourceFile: "C:\\temp\\call.txt", usesFakeData: false
})
```

同功能＋同原檔名重複呼叫＝更新同一筆（用來補登 Excel 截圖，或把假資料改成真實資料）。路徑一律要是絕對路徑，檔案必須存在、是一般檔案（不接受符號連結）、副檔名在白名單內、不超過 50MB。

### 5.7 `04-test.md` 的「測試證據」一節

`04-test.md` 內文**必須**有標題含「測試證據」的一節，每筆證據的功能名稱與宣告的 `testLevel` 字串都要出現，有任何假資料證據時「資料來源」欄要明確寫「假資料」；並在 `write_ticket_artifact` 帶 `testLevel` 與 `producesOfficeFiles`（有產出 Excel/PDF 才帶 `true`，且需至少 1 筆 excel／pdf 證據）。建議格式：

```markdown
## 測試證據

整體測試層級：integration-db（證據中最高層級；僅 unit-mock 時不得宣稱已驗證真實 DB／API）

| 功能名稱 | 資料來源 | 測試層級 | 檔案類型 | 證據檔位置（單一檔案） | 截圖 | 備註 |
|----------|----------|----------|----------|------------------------|------|------|
| 月報表 Excel 匯出 | 假資料 | integration-db | excel | test-evidence/【假資料】月報表_Excel_匯出/export_假資料.xlsx | 待使用者截圖 | 標註副本；原始檔路徑與 sha256 見 status.json |
| 月報表 PDF 列印 | 真實資料 | live-api | pdf | test-evidence/月報表_PDF_列印/report.pdf | report_截圖_1.png、report_截圖_2.png | PyMuPDF 渲染 |
| 新增申請單 API | 真實資料 | live-api | api-call | test-evidence/新增申請單_API/call.txt | — | token 已遮蔽 |
```
