// work_item 工具測試的共用環境：隔離資料目錄、in-memory MCP client、依角色補齊交件檔、依序推進流程。
// content／evidence 關卡（impact-content、sa-content-check、implementation-content、test-evidence）由程式檢查自動通過，不在 STEPS 內。
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { BASELINE_TECH_OK, techStackFor } from "./tech-fixtures.mjs";
import os from "node:os";
import path from "node:path";

export const CLEAN_REVIEW = { breaksExisting: false, reviewerUncertain: false, scopeSplit: false };
export const REUSABLE_LIST_OK = "影響\n## 可重用清單\n- ExcelUtil：src/main/ExcelUtil.java\n- 已搜尋：日期轉換，未找到\n";
export const REUSE_RECORD_OK = "## 重用檢查紀錄\n| 搜尋關鍵字 | 找到的候選 | 決定 | 理由 |\n| --- | --- | --- | --- |\n| exportExcel | ExcelUtil.write | 重用 | |\n";
/** 專案目錄是暫存空目錄（非版本控制），所以實作說明要自己列出「## 改動檔案」；列的檔案不存在也算有清單。 */
export const CHANGED_FILES_FE = "## 改動檔案\n- src/ui/login-page.js\n";
export const CHANGED_FILES_BE = "## 改動檔案\n- src/api/login-service.js\n";
/** 對應預設 02-db.sql（CREATE TABLE t (id INT)）的合格資料表結構文件。 */
export const VALID_TABLE_SCHEMA = [
  "# t 資料表結構", "", "## 版本管控歷程", "", "| 版次 | 發行日期 | 修訂說明 | 修訂單位 | 修訂人員 |", "| --- | --- | --- | --- | --- |", "| 1.0 | 2026/11/10 | 初版 | 示範團隊 | 系統分析師 |", "",
  "## 欄位清單", "", "| # | 欄位 | 型別 | PK | 說明 |", "|:-:|---|---|:-:|---|", "| 1 | id | INT | ✓ | 編號 |", "",
  "## 各規格使用欄位對照", "", "| 規格 | 使用欄位 |", "| --- | --- |", "| [登入](../03-sd.md) | id |", "",
].join("\n");
/** 通過 mockup 檢查的精簡可操作原型。 */
export const VALID_MOCKUP = `<!doctype html><html><body data-demo-states="normal,loading,success,failed,empty"><button id="b">登入</button><script>document.getElementById("b").addEventListener("click", function () {});</script></body></html>`;
/** 通過所有 SA 檢查的精簡客戶版 SA（只用一張圖 sa-images/a.png）。 */
export const VALID_SA = [
  "# 登入：需求說明", "", "| 項目 | 內容 |", "| --- | --- |", "| 功能名稱 | 登入 |", "| 文件版次 | 0.1 |", "| 系統分析者 | 系統分析師 |", "| 審查者 |  |", "",
  "## 版本管控歷程", "", "| 版次 | 發行日期 | 修訂說明 | 修訂單位 | 修訂人員 |", "| --- | --- | --- | --- | --- |", "| 0.1 | 2026/11/10 | 初版 | 示範團隊 | 系統分析師 |", "",
  "## 功能目的", "會員輸入帳號密碼登入系統。", "",
  "## 畫面", "![登入畫面](sa-images/a.png)", "", "畫面上有帳號、密碼欄位與登入按鈕。", "",
  "## 操作說明", "1. 輸入帳號與密碼。", "2. 按下登入。", "",
  "## 帳號規則", "", "| 規則 | 說明 |", "| --- | --- |", "| 必填 | 帳號與密碼都要輸入 |", "",
  "## 輸入時的提示", "提示顯示在欄位下方。", "", "**帳號空白**", "", "![帳號空白](sa-images/a.png)", "",
].join("\n");
/** 通過 SD 標準檢查的精簡 SD（使用資料表 t 對應 VALID_TABLE_SCHEMA，共用方法 ExcelUtil）。 */
export const VALID_SD = [
  "| 程式代號 | login | 使用技術 | Node.js |", "| --- | --- | --- | --- |", "| 程式名稱 | 登入 | 系統分析者 | 系統分析師 |", "| 上層程式名稱 | 會員中心 | 程式設計者 |  |", "| 程式類別 | 查詢 | 審查者 |  |", "",
  "## 版本管控歷程", "", "| 版次 | 發行日期 | 修訂說明 | 修訂單位 | 修訂人員 |", "| --- | --- | --- | --- | --- |", "| 0.1 | 2026/11/10 | 初版 | 示範團隊 | 系統分析師 |", "",
  "## 目錄", "", "一、規格說明", "二、API 說明", "",
  "## 規格說明", "", "### 1. 使用資料表", "", "| Table | 功能 | 說明 | 結構文件 |", "| --- | --- | --- | --- |", "| t | 帳號 | 帳號資料 | [t 資料表結構](TableSchema/t.md) |", "",
  "### 2. 前端功能與 API 對應表", "", "| 前端功能 | 觸發時機 | 呼叫的 API | 成功時 | 失敗時 | 前端位置 |", "| --- | --- | --- | --- | --- | --- |", "| 登入 | 按下登入 | 登入 `POST /api/login` | 進入首頁 | 訊息區顯示錯誤 | src/ui/login-page.js |", "",
  "### 3. 共用方法清單", "", "| 共用方法 | 位置 | 類型 | 被誰使用 | 說明 |", "| --- | --- | --- | --- | --- |", "| ExcelUtil | src/main/ExcelUtil.java | 重用既有 | 登入 API 的服務層 | 既有工具 |", "",
  "### 4. 共用回應與錯誤碼", "", "| HTTP | code | message | 說明 | 檢核位置 | 前端提示位置 |", "| --- | --- | --- | --- | --- | --- |", "| 401 | LOGIN_FAILED | 帳號或密碼錯誤 | 驗證失敗 | 僅後端 | 訊息區 |", "",
  "## API 說明", "", "### 1. 登入", "", "**URL:** /api/login", "", "**METHOD:** POST", "", "**Controller:** src/api/login-controller.js ── login()", "", "**Service:** src/api/login-service.js ── login()", "", "**Repository:** src/api/login-repository.js ── findAccount()", "", "**使用的共用方法:** ExcelUtil", "",
  "#### INPUT", "", "| ElementName | ElementType | 必填 | 對應 DB 欄位 | 註解 |", "| --- | --- | --- | --- | --- |", "| account | string | Y | t.id | 帳號 |", "",
  "#### 業務邏輯", "1. 依帳號查詢，不存在回 401。", "", "#### OUTPUT", "HTTP 200，登入結果。", "",
].join("\n");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

export async function setupEnv(prefix, { renderer } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.ASANA_PIPELINE_DATA_DIR = path.join(tmp, "data");
  const projectDir = path.join(tmp, "proj");
  await mkdir(projectDir, { recursive: true });
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { registerWorkItemTools } = await import("../../dist/work-item-tools.js");
  const store = await import("../../dist/pipeline-store.js");
  const server = new McpServer({ name: "t", version: "0" });
  registerWorkItemTools(server, renderer ? { renderer } : {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);

  async function call(args) {
    const r = await client.callTool({ name: "work_item", arguments: args });
    const text = r.content[0].text;
    return { isError: !!r.isError, text, json: JSON.parse(text) };
  }
  async function create(extra = {}) {
    const r = await call({ action: "create", projectDir, title: "測試需求", requirement: "需求原文", baseline: "greenfield", scope: "both", hasDb: true, ...extra });
    if (r.isError) throw new Error(r.text);
    return { id: r.json.workItemId, dir: r.json.dir };
  }
  return { tmp, projectDir, call, create, store, client, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

/** 依角色補齊合格的交件檔。 */
export async function fulfil(dir, roleId, opts = {}) {
  const w = (rel, text) => mkdir(path.dirname(path.join(dir, rel)), { recursive: true }).then(() => writeFile(path.join(dir, rel), text));
  const files = {
    "baseline-survey": async () => { await w("baseline.md", BASELINE_TECH_OK); await w("impact.md", REUSABLE_LIST_OK); },
    "tech-selector": async () => w("tech-stack.md", techStackFor(JSON.parse(await readFile(path.join(dir, "status.json"), "utf-8")).tech_source)),
    "mockup-designer": () => w("sa-mockup/index.html", VALID_MOCKUP),
    "sa-analyst": async () => { await w("01-sa.md", VALID_SA); await w("sa-notes.md", "## 待確認問題\n- 無\n"); await writeFile(path.join(dir, "sa-images", "a.png"), PNG); },
    "db-designer": async () => { await w("02-db.sql", opts.sql ?? "CREATE TABLE t (id INT);"); await w("TableSchema/t.md", VALID_TABLE_SCHEMA); },
    "flow-analyst": async () => { await w("flow.mmd", "graph TD\nA-->B"); await writeFile(path.join(dir, "flow.png"), PNG); },
    "sd-analyst": () => w("03-sd.md", VALID_SD),
    "spec-verifier": () => w("spec-check.md", opts.verdictText ?? "PASS\n對照表"),
    "frontend-engineer": () => w("impl-fe.md", `FE\n${REUSE_RECORD_OK}${CHANGED_FILES_FE}`),
    "backend-engineer": () => w("impl-be.md", `BE\n${REUSE_RECORD_OK}${CHANGED_FILES_BE}`),
    verifier: () => w("verify.md", opts.verdictText ?? "PASS\n"),
    tester: async () => {
      await w("test.md", "## 白箱\n白箱結果\n## 黑箱\n黑箱結果\n## 測試：登入\n![畫面](evidence/a.png)\n");
      await w("evidence/a.png", PNG);
    },
  };
  await files[roleId]();
}

const STEPS = [
  ["tech-selector"], ["tech-confirm", "human"], ["mockup-designer"], ["mockup-confirm", "human"], ["sa-analyst"], ["sa-confirm", "agent"], ["db-designer"], ["flow-analyst"],
  ["db-flow-confirm", "agent"], ["sd-analyst"], ["sd-confirm", "agent"], ["spec-verifier"], ["spec-check-verdict", "verdict"],
  ["frontend-engineer"], ["backend-engineer"], ["verifier"], ["verdict", "verdict"], ["tester"],
];

/** 依序推進直到「下一步」是 stopBefore（角色 id 或關卡 id）；全部做完則推進到最終驗收之前。 */
export async function runUntil(env, id, dir, stopBefore) {
  env.cursor ??= new Map();
  for (let i = env.cursor.get(id) ?? 0; i < STEPS.length; i++) {
    const [label, kind] = STEPS[i];
    if (label === stopBefore) return;
    let r;
    if (label === "tech-confirm" && JSON.parse(await readFile(path.join(dir, "status.json"), "utf-8")).tech_source === "existing") {
      env.cursor.set(id, i + 1); // 沿用現有：技術確認由程式自動記錄
      continue;
    }
    if (!kind) {
      await fulfil(dir, label);
      r = await env.call({ action: "done", workItemId: id, roleId: label });
    } else if (kind === "verdict") {
      r = await env.call({ action: "verdict", workItemId: id, gateId: label, result: "pass", by: "agent", review: CLEAN_REVIEW });
    } else {
      r = await env.call({ action: "confirm", workItemId: id, gateId: label, decision: "confirmed", by: kind, ...(kind === "agent" ? { review: CLEAN_REVIEW } : { reason: "使用者說確認" }) });
    }
    if (r.isError) throw new Error(`推進到 ${label} 失敗：${r.text}`);
    env.cursor.set(id, i + 1);
  }
}
