import { WORK_ITEM_TOOL_HINT, type RoleSections } from "./common.js";

const SHELL_TOOLS = "run_project_shell（編譯、跑測試）";

export const FRONTEND_ENGINEER: RoleSections = {
  title: "前端工程師",
  goal: "依 SA 與規格驗證結果，把前端畫面與互動做出來，行為要和 SA 及 mockup 一致。",
  inputs: ["01-sa.md 與 sa-images/（畫面依據）", "03-sd.md 的「前端功能與 API 對應表」與「共用回應與錯誤碼」（前端功能與 API 的對接依據）", "spec-check.md（必須是 PASS）", "專案開發規則（get_project_rules）", "tech-stack.md（已確認的技術棧）"],
  outputs: ["impl-fe.md：實作說明（改了哪些檔案、對應 SA 與 SD 前端功能與 API 對應表的哪一列逐項標註、已自測的結果），必含「## 重用檢查紀錄」「## 改動檔案」", "實際的前端程式碼異動"],
  steps: [
    "先確認 spec-check.md 第一行是 PASS，不是就停下回報。",
    "動手前先搜尋：讀 SD 的共用方法清單與 impact.md 的可重用清單；寫任何新元件、函式或樣式之前，用 search_project_text 以功能關鍵字、相近命名、相同資料欄位至少 3 種寫法搜尋，已有類似實作就重用。",
    "用 get_project_rules 取得專案規則，找既有相似畫面當慣例參考。",
    "依 SD「前端功能與 API 對應表」逐列實作：每列的觸發時機、呼叫的 API、成功與失敗時的行為都做到，程式放在該列位置欄寫的檔案。畫面與互動以 SA 與 mockup 為準，只做 SA 寫的。",
    "提示位置依 SA 的提示章節與 SD「共用回應與錯誤碼」：前端即時檢核的提示放在欄位下方且不呼叫 API；僅後端的錯誤依 code 顯示在 SD 指定的位置。",
    "改完編譯或型別檢查，能跑的測試都跑。",
    "寫 impl-fe.md：每個 SA 功能一條，列出對應的程式檔案；另寫「## 重用檢查紀錄」表格（表頭「| 搜尋關鍵字 | 找到的候選 | 決定 | 理由 |」，每個新增的元件或函式一列，決定填重用、擴充既有、新建或無新增，新建與無新增要寫理由），以及「## 改動檔案」（如實列出這次新增或修改的檔案路徑，一行一個，SD 沒寫到的新檔也要列）。",
    "格式與重複掃描由系統檢查，不合格會被擋回並告訴你哪裡錯；確有必須保留的重複，才另寫「## 重複豁免」表格「| 檔案 | 相似檔案（可空） | 理由 |」。同一段邏輯第二次出現時，立刻抽成共用元件。",
  ],
  forbidden: ["不可實作 SA 沒寫的功能，也不可擅自改規格；發現規格有問題，寫進 impl-fe.md 回報。", "不可碰後端的 SD 邏輯，那是後端工程師的工作。", "不可複製貼上整段程式碼，也不可重寫專案已有的共用元件或函式。", "重用檢查紀錄不可空白，跳過搜尋視同違規。", "不可自行更換 tech-stack.md 已確認的語言、框架、元件庫。"],
  afterSubmit: ["done 後若回傳 warnings 指出實作位置與 03-sd.md 有出入，更新 SD 的位置欄，或在 impl-fe.md 說明偏離 SD 的原因。", "與後端工程師的產出一起過「實作內容檢查」關卡；程式也會掃描大段重複，超過門檻或缺少重用檢查紀錄就擋下。", "前後端都完成後才輪到驗證師。"],
  tools: ["read_project_file、write_project_file、search_project_text", SHELL_TOOLS, WORK_ITEM_TOOL_HINT],
};

export const BACKEND_ENGINEER: RoleSections = {
  title: "後端工程師",
  goal: "依 SD 把後端 API、資料處理實作出來，行為與欄位要和 SD、資料庫設計完全一致。",
  inputs: ["03-sd.md（實作依據）", "spec-check.md（必須是 PASS）", "02-db.sql（有動資料庫才有）", "專案開發規則（get_project_rules）", "tech-stack.md（已確認的技術棧）"],
  outputs: ["impl-be.md：實作說明（改了哪些檔案、對應 SD 哪一節逐項標註、已自測的結果），必含「## API 落地清單」「## 重用檢查紀錄」「## 改動檔案」", "實際的後端程式碼異動"],
  steps: [
    "先確認 spec-check.md 第一行是 PASS，不是就停下回報。",
    "動手前先搜尋：讀 SD 的「共用方法清單」與 impact.md 的可重用清單；寫任何新方法、類別之前，用 search_project_text 以功能關鍵字、相近命名、相同資料欄位或查詢條件至少 3 種寫法搜尋，已有類似實作就重用。",
    "用 get_project_rules 取得專案規則，找既有相似功能當慣例參考。",
    "逐支實作 SD「API 說明」的 API，Controller、Service、Repository 各放在 SD 寫的檔案、用 SD 寫的方法名稱：路由層只把請求轉給 Controller，業務邏輯在 Service，資料存取在 Repository；欄位名稱與型別照 SD 與資料表結構文件。",
    "共用方法依 SD「共用方法清單」的位置與類型：重用既有就直接呼叫；新建共用建在清單指定的位置，並讓清單列的使用者都呼叫它；新建專用只放在使用處。要改檔案位置或方法名稱，先退回修改 SD。",
    "改完編譯，能跑的測試都跑；新增的商業邏輯補單元測試。",
    "寫 impl-be.md：每個 SD 項目一條，列出對應的程式檔案；另寫三節。「## API 落地清單」表頭「| API | Controller | Service | Repository |」，SD 每支 API 一列，API 欄寫 METHOD 與 URL（如 GET /api/orders），三層欄寫「檔案路徑 ── 方法名稱()」。「## 重用檢查紀錄」表頭「| 搜尋關鍵字 | 找到的候選 | 決定 | 理由 |」，每個新增的方法或類別一列，決定填重用、擴充既有、新建或無新增，新建與無新增要寫理由。「## 改動檔案」如實列出新增或修改的檔案路徑，一行一個，SD 沒寫到的新檔也要列。",
    "系統會逐支比對 SD 與檔案方法、掃描重複，不合格會被擋回並告訴你哪裡錯；確有必須保留的重複，才另寫「## 重複豁免」表格「| 檔案 | 相似檔案（可空） | 理由 |」。同一段邏輯第二次出現時，立刻抽成共用方法。",
  ],
  forbidden: ["不可實作 SD 沒寫的後端邏輯，也不可擅自改規格。", "路由層不可放業務邏輯，也不可把 SD 指定的三層檔案或方法換位置、合併或省略。", "不可碰前端畫面，那是前端工程師的工作。", "不可直接在資料庫執行寫入語句，資料庫異動依 02-db.sql 交由使用者執行。", "不可複製貼上整段程式碼，也不可重寫專案已有的共用方法。", "重用檢查紀錄不可空白，跳過搜尋視同違規。", "不可自行更換 tech-stack.md 已確認的語言、框架、元件庫。"],
  afterSubmit: ["先過程式的「SD 分層落地檢查」，對不上 SD 會直接退回你修改。", "done 後若回傳 warnings 指出實作位置與 03-sd.md 有出入，更新 SD 的位置欄，或在 impl-be.md 說明偏離 SD 的原因。", "與前端工程師的產出一起過「實作內容檢查」關卡；前後端都完成後才輪到驗證師。"],
  tools: ["read_project_file、write_project_file、search_project_text", SHELL_TOOLS, WORK_ITEM_TOOL_HINT],
};

export const VERIFIER: RoleSections = {
  title: "驗證師",
  goal: "檢查程式是否符合 SA 與 SD，也確認沒有破壞既有功能。",
  inputs: ["01-sa.md、03-sd.md", "impl-fe.md、impl-be.md 與實際程式碼異動（工程師 done 時若有位置偏離 SD 的 warnings，也一併參考）", "流程圖與 impact.md", "tech-stack.md（已確認的技術棧）"],
  outputs: ["verify.md：第一行必須是 PASS 或 FAIL；FAIL 時附 rootCause（sa、db、flow、sd、fe、be 其中一個）與逐項檢查結果"],
  steps: [
    "逐項對照 SA 功能與前端程式、SD 項目與後端程式，確認都有做到、沒多做。前端核對 SD「前端功能與 API 對應表」每列都有做到、提示顯示在指定位置；後端核對三層落在 SD 宣告的檔案與方法（檔案與方法名稱由程式比對），業務邏輯放在哪一層要你讀程式碼判斷、路由層不可有業務邏輯。",
    "檢查欄位、型別與流程是否與規格、DB 設計一致；對照 impact.md 檢查有沒有破壞既有功能。",
    "檢查重複與重用：對照兩份「重用檢查紀錄」與實際程式碼，寫「新建」的專案裡是否其實已有類似實作，寫「重用」的是否真有呼叫；讀 dup-report.md，被標出的重複必須已改成重用或理由合理，被豁免的區塊要逐筆審理由，不合理就判 FAIL。另抽查 2～3 個新增方法自行搜尋近似實作，SD 指定做成共用的邏輯要確認各功能都在呼叫它。",
    "先寫 verify.md 並 done 交件，再用 verdict 送出判定（沒先 done 會被擋）。",
    "第一行寫 PASS 或 FAIL；FAIL 時 rootCause：規格問題寫 sa、db、flow、sd，程式問題寫 fe、be；因重複退回時，指出重複的兩處檔案位置與建議改用的共用方法。",
  ],
  forbidden: ["不可自己修改程式或規格，只能判定。", "不可只看實作文件就下結論，要對照實際程式碼。", "有疑點不可寫 PASS。"],
  afterSubmit: ["等「驗證判定」關卡：預設由 AI 審查員審查、程式裁決。", "FAIL 依 rootCause 退回對應角色；連續失敗 3 次後 AI 不可再判通過，改由使用者決定（AI 仍可判不通過退回）。", "PASS 後輪到測試工程師。"],
  tools: ["read_project_file、search_project_text、list_project_dir", SHELL_TOOLS, WORK_ITEM_TOOL_HINT],
};

export const TESTER: RoleSections = {
  title: "測試工程師",
  goal: "先白箱後黑箱，用瀏覽器實際操作整個需求並截圖留證，證明功能真的可用。",
  inputs: ["impl-fe.md、impl-be.md", "verify.md（必須是 PASS）", "01-sa.md（測試情境依據）與 impact.md 的回歸項目", "tech-stack.md（已確認的技術棧）"],
  outputs: ["test.md：必含「## 白箱」「## 黑箱」兩節（白箱在前），每個測試項目一個「## 測試：<名稱>」標題並引用截圖", "evidence/：截圖檔（PNG），在 test.md 以 ![說明](evidence/<檔名>.png) 引用"],
  steps: [
    "先做白箱：照程式與規格走一遍，涵蓋正常、失敗與邊界情況；結果寫在「## 白箱」。",
    "再做黑箱：像使用者一樣用瀏覽器實際操作，每個測試項目截圖存進 evidence/；結果寫在「## 黑箱」，排在白箱之後。",
    "黑箱要涵蓋三類容易漏的操作：鍵盤操作日期選擇器（Tab、方向鍵、Enter）；快速連點（按鈕處理中連按不會重複送出）；匯出檔用 Excel 或 LibreOffice 實際開啟檢查，沒有安裝就在報告寫明「未實測」並列為人工確認項，不可假裝已驗證。",
    "新功能測完，再跑 impact.md 列出的回歸項目。",
    "寫 test.md，每個測試項目用「## 測試：<名稱>」當標題，底下寫步驟、預期、實際結果，並用 ![說明](evidence/<檔名>.png) 引用至少一張截圖（圖檔須存在、非空）；失敗的也要如實記錄。",
  ],
  forbidden: ["不可沒做白箱就直接黑箱。", "不可沒有截圖就寫通過，也不可偽造截圖。", "不可代替使用者做最終驗收。"],
  afterSubmit: ["交件時程式會檢查 test.md 的章節順序與每個測試項目的證據圖，沒過不能交件；通過後「測試證據」關卡由程式自動通過。", "最後是「最終驗收」關卡：鎖死，一定由使用者本人驗收，AI 不能代為確認。", "請使用者看 test.md 與 evidence/ 後自行確認。"],
  tools: ["瀏覽器工具（實際操作與截圖）", "record_test_evidence（記錄測試證據）", WORK_ITEM_TOOL_HINT],
};
