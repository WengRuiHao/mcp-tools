# svn-mcp

唯讀 MCP server，直接執行本機的 `svn` CLI，不依賴 claudeweb 或任何網站服務——stdio 工具（下表）跟 claudeweb 完全無關。

> **注意**：這份 README 曾經描述過一個更早期的架構（stdio 工具轉呼叫 claudeweb 的 SVN REST API，靠 `SVN_API_BASE` 指定 claudeweb 網址）。目前原始碼（`src/svn-client.ts`）已經沒有這個機制、也沒有讀取 `SVN_API_BASE` 這個環境變數了——已更新成下方實際的樣子。真正還會呼叫 claudeweb 的是另一個獨立元件，見下方「HTTP bridge」一節。

## 環境變數（stdio 工具）

| 變數 | 說明 | 預設值 |
|---|---|---|
| `SVN_CONNECTION_ID` | 預設使用的 SVN 連線 ID（沒指定就用這個） | 無（工具呼叫需自行指定連線） |
| `SVN_CONNECTIONS_FILE` | SVN 連線設定檔路徑（含各連線的 url/username/password） | 這個 MCP 自己目錄下的 `info/svn-connections.json` |
| `SVN_TIMEOUT_MS` | 執行 `svn` 指令的逾時毫秒數 | `30000` |

## 工具（stdio，執行本機 `svn` CLI）

| 工具 | 對應 `svn` 子命令 |
|---|---|
| `svn_browse` | `svn list` |
| `svn_cat` | `svn cat`（docx/xlsx/pdf 自動解析成文字） |
| `svn_log` | `svn log` |
| `svn_diff` | `svn diff` |
| `svn_doc_images` | 用 `svn cat` 抓 docx，提取內嵌圖片，回傳本地路徑清單 |

## HTTP bridge（`src/http-server.ts`，給 claudeweb 用的獨立介面）

跟上面的 stdio 工具是兩條完全不同的路——這是給 `claudeweb`（Java Web App，`C:\Tool\claudeweb`）依賴的持久化 HTTP 服務，讓它能對 `svn` CLI 下指令而不用自己重新實作一份。`claudeweb` 這邊透過 `svn.mcp.http.base`（預設 `http://localhost:8095`）呼叫，兩者設計上跑在同一台機器（`claudeweb` 會用 `ProcessBuilder` 直接在本機拉起 `dist-exe/svn-http-bridge.exe`）。

| 變數 | 說明 | 預設值 |
|---|---|---|
| `SVN_MCP_HTTP_PORT` | 監聽的埠號 | `8095` |
| `SVN_BRIDGE_HOST` | 綁定的網路介面 | `127.0.0.1`（只接受本機連線） |
| `SVN_BRIDGE_TOKEN` | 選配的共用密鑰，設定後 `POST /run` 要求 `Authorization: Bearer <token>` | 未設定（不驗證，僅靠 host 綁定防護） |

`POST /run` 只允許 `list`/`cat`/`log`/`diff`/`info` 這幾個唯讀子命令，且拒絕任何 `file://` 開頭的參數——這是給 claudeweb 瀏覽/讀取 SVN 用的橋接，不是任意執行 `svn` 指令的通道。

## 安裝

```bash
npm install
npm run build
```
