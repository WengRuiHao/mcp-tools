# mcp-tools

個人維護的一組 MCP server，供 Claude Code（或其他支援 MCP 的 AI/host）驅動日常開發與 Asana 票單處理流程。

## 目錄

| 目錄 | 說明 |
|---|---|
| `asana-mcp` | 唯讀 Asana 存取（共用帳號 token）——workspaces/projects/board/task/comments |
| `svn-mcp` | 自主的 SVN 存取——直接執行本機 `svn` CLI，不依賴任何網站服務；也提供一個獨立的 HTTP bridge（`dist-exe/` 打包成 .exe）讓其他服務（例如 claudeweb）依賴它 |
| `spec-pipeline-mcp` | 規格文件（docx/md）→ 分析師 → 工程師 → 驗證師。角色定義（`get_role_prompt`）內建在 MCP 裡，任何 AI host 接上都拿到同一套 |
| `asana-pipeline-mcp` | 「Asana 票單 → 分析師 → 工程師 → 驗證師」全自動流程，橋接上面三個 MCP；專案↔目錄的登記是自己本機維護的，只有分析師抓 commit 才會呼叫 spec-pipeline-mcp |
| `github-mcp` | 個人 GitHub（Personal Access Token）——repo/issue/PR 管理 |
| `office-docs-mcp` | Word（.docx）／Excel（.xlsx）／PDF 的讀取／寫入／建立／刪除——包一層 Node/TS 呼叫 `scripts/` 底下的 python 腳本（python-docx／openpyxl／pypdf／reportlab），不橋接也不被任何其他 MCP 橋接 |

## 架構圖解

### 怎麼呼叫、MCP 之間怎麼溝通

![六個 MCP 的連線架構：AI host 對六個 MCP 各自建立獨立的 MCP stdio 連線；asana-pipeline-mcp 另外自己啟動 asana-mcp、spec-pipeline-mcp、svn-mcp 三個子行程，是完全獨立於 host 那三條連線的第二份實體；github-mcp 跟 office-docs-mcp 都沒有被任何其他 MCP 橋接](docs/img/mcp-architecture.svg)

- Host 對六個 MCP 各自建立獨立連線——六個獨立 process，透過 stdio／JSON-RPC 溝通，彼此互不知道對方存在。
- 只有 `asana-pipeline-mcp` 會再啟動一次 `asana-mcp`／`spec-pipeline-mcp`／`svn-mcp` 當子行程橋接（見 `mcp-clients.ts`），是跟 host 直連的那三個完全不同的另一份 process；`github-mcp`／`office-docs-mcp` 都沒被任何人橋接。
- `svn-mcp` 另外有個非 MCP 協定的 HTTP bridge（`dist-exe/`），是給 `claudeweb` 用的第二個介面，跟這裡講的「MCP 對 MCP」橋接是兩件事。

### asana-pipeline-mcp 主流程：每一步呼叫哪個 MCP

![asana-pipeline-mcp 的橋接關係：Asana 專案對應目錄、SA/SD 規格設定、git 版控根目錄這三份登記表都是本機的，不跨行程；真正呼叫別的 MCP 只有三處——抓票單橋接 asana-mcp、讀規格橋接 svn-mcp、分析師階段視需要抓 commit 記錄橋接 spec-pipeline-mcp；角色判斷跟改程式碼都是呼叫端 AI 自己做](docs/img/pipeline-bridge-flow.svg)

一次性設定（專案/目錄/SA-SD/git roots）都是本機登記表，不跨行程；真正橋接別的 MCP 只有三處：抓票單 → asana-mcp、讀規格 → svn-mcp、分析師視需要抓 commit → spec-pipeline-mcp。角色判斷跟改程式碼一律是呼叫端 AI 自己做。

## 各自的連線/憑證資料

每個 MCP 的連線資訊（token、SVN 帳密等）都放在自己目錄底下的 `info/`（已加進 `.gitignore`，不會進版控），是各自獨立維護的個人副本，不跟任何其他系統共用同一份檔案。

## 安裝

每個子目錄都是獨立的 npm 專案：

```bash
cd asana-mcp && npm install && npm run build
cd ../svn-mcp && npm install && npm run build
cd ../spec-pipeline-mcp && npm install && npm run build
cd ../asana-pipeline-mcp && npm install && npm run build
cd ../github-mcp && npm install && npm run build
cd ../office-docs-mcp && npm install && npm run build
```

`office-docs-mcp` 額外需要本機 Python 環境裝好 `python-docx`／`openpyxl`／`pypdf`／`reportlab`（`pip install python-docx openpyxl pypdf reportlab`），Node 端只是包一層呼叫 `scripts/*.py`。

## 為什麼放在同一個 repo

這幾個 MCP 大多彼此有橋接關係（`asana-pipeline-mcp` 會把另外三個當子行程啟動），放在同一個 repo 方便一起看歷史、一起改版，不用切換好幾個 repo。各自的 `package.json`/`.gitignore` 仍然獨立，互不影響。`office-docs-mcp` 目前是獨立的一個，沒有跟其他 MCP 橋接，純粹是圖方便管理放進同一個 repo。
