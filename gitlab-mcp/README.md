# gitlab-mcp

個人 GitLab MCP server（Personal Access Token）——查詢自己在 GitLab 上的專案、分支、commit 歷史、檔案內容。全部唯讀，不做任何寫入操作。

跟公司共用帳號的 GitLab 整合是分開的兩條路：共用帳號看到的是共用視角，這支 MCP 用你自己的 PAT，`gitlab_list_projects` 查出來的才是你個人實際參與/擁有的專案。

## 架構與流程

```mermaid
flowchart TD
    A["Claude Code 呼叫 gitlab_* 工具"] --> B["config-store.ts 讀取 info/gitlab.json"]
    B -->|token 不存在| D["回傳錯誤：尚未設定 Personal Access Token"]
    B -->|token 存在| E["gitlab-client.ts 帶 PRIVATE-TOKEN header 打 GitLab REST API v4"]
    E --> F["GitLab 站台（預設 gitlab.universalec.com.tw）"]
    F -->|4xx/5xx| G1["解析錯誤訊息，回傳 success:false"]
    F -->|200| G2["解析 JSON，回傳 success:true"]
    G1 --> H["shared.ts toolResult() 包裝成 MCP 回應"]
    G2 --> H
```

典型的查詢流程，由大範圍逐層鑽入到單一檔案：

```mermaid
flowchart LR
    P1["gitlab_list_projects
    列出我的專案"] --> P2["gitlab_list_branches
    列出分支"]
    P2 --> P3["gitlab_list_commits
    看 commit 歷史"]
    P2 --> P4["gitlab_get_repository_tree
    瀏覽目錄結構"]
    P2 --> P7["gitlab_compare_branches
    比較兩分支差異"]
    P3 --> P5["gitlab_get_commit_diff
    看單一 commit 改了什麼"]
    P4 --> P6["gitlab_get_file_contents
    讀取檔案內容"]
```

## 設定

在這支 MCP 自己目錄下的 `info/gitlab.json`（已 gitignore，個人專屬，不進版控）：

```json
{
  "token": "你的 Personal Access Token（scope 只需要 read_api）",
  "baseUrl": "https://gitlab.universalec.com.tw"
}
```

`baseUrl` 可省略，預設就是上面這個站台。也可以用環境變數 `GITLAB_MCP_CONFIG_PATH` 指定其他設定檔路徑。

## 工具（全部唯讀）

| 工具 | 說明 |
|---|---|
| `gitlab_whoami` | 確認 token 有效，回傳登入的個人帳號 |
| `gitlab_list_projects` | 列出自己參與/擁有的專案 |
| `gitlab_get_project` | 單一專案詳細資訊 |
| `gitlab_list_branches` | 列出專案的分支 |
| `gitlab_get_branch` | 單一分支詳情 |
| `gitlab_list_commits` | 指定分支的 commit 歷史 |
| `gitlab_get_commit` | 單一 commit 詳情 |
| `gitlab_get_commit_diff` | 單一 commit 的 diff |
| `gitlab_compare_branches` | 兩分支/tag/SHA 之間的差異 |
| `gitlab_get_repository_tree` | 瀏覽分支底下的目錄結構 |
| `gitlab_get_file_contents` | 讀取分支上某檔案的內容（自動 base64 解碼） |

## 安裝

```bash
npm install
npm run build
```
