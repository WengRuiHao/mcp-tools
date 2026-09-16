# gitlab-mcp

讓 Claude 幫你查 GitLab 上「屬於你自己」的東西：有哪些專案、專案裡有哪些分支、每個分支改過什麼、程式內容長怎樣。只能看、不會幫你改動或刪除任何東西。

公司原本共用帳號查到的專案是共用視角，不是你自己真正參與的專案。這個小工具用**你自己申請的通行證**登入，看到的才是你個人帳號實際看得到的東西。

## 這是怎麼運作的

![運作方式共四步：你跟 Claude 說想看的東西；Claude 請一個小幫手去查；小幫手用你自己的通行證登入 GitLab，所以只會看到你自己的專案，不是公司共用帳號那份；最後把結果整理成看得懂的樣子給你。如果還沒設定通行證，會提醒你要先申請一組只能看、不能改的通行證](docs/img/how-it-works.svg)

## 平常怎麼用

從「看專案」開始，一路點下去就能看到細節：

![平常怎麼用：先看自己有哪些專案，點一個進去看它有哪些分支；選了分支之後可以三選一，看修改紀錄、看資料夾跟檔案、或比較兩個分支差在哪；看修改紀錄可以再點一筆看那次到底改了什麼；看資料夾可以再點開某個檔案直接看內容](docs/img/usage-flow.svg)

---

以下是給負責設定的人看的技術細節。

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
