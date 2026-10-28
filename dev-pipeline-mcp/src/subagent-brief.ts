import type { SdMode, SpecOrder } from "./project-registry.js";
import type { RoleName } from "./prompts.js";

const ROLE_LABEL: Record<RoleName, string> = {
  analyst: "分析師",
  "spec-writer": "規格撰寫者",
  engineer: "工程師",
  verifier: "驗證師",
  tester: "測試工程師",
};

/** 每個角色要寫入哪個追蹤檔、必填欄位、最後要推進到哪個 stage。與各角色說明的「輸出」段一致。 */
const ROLE_WRITE_TARGET: Record<RoleName, string> = {
  analyst:
    "寫入 `01-analysis.md`：`write_ticket_artifact({ taskGid, filename: \"01-analysis.md\", content, summary })`（寫之前須已 `record_sasd_check`），再 `advance_ticket_stage({ taskGid, stage: \"analyzed\" })`。",
  "spec-writer":
    "用 `write_project_sd_doc` 寫 SD 規格（這個角色不寫 `write_ticket_artifact`），再 `advance_ticket_stage({ taskGid, stage: \"sd_drafted\" })` 後停下，等使用者 `record_spec_confirmation`。",
  engineer:
    "寫入 `02-implementation.md`：`write_ticket_artifact({ taskGid, filename: \"02-implementation.md\", content, summary, syncNote, manualActions })`（`syncNote`、`manualActions` 必填；沒有就帶 \"NO_SYNC_NEEDED\"／[]），再 `advance_ticket_stage({ taskGid, stage: \"implemented\" })`。",
  verifier:
    "寫入 `03-verification.md`：`write_ticket_artifact({ taskGid, filename: \"03-verification.md\", content, summary, syncNote, manualActions })`（content 第一行只寫 PASS／FAIL），再 `advance_ticket_stage({ taskGid, stage: \"verified\", verdict, rootCause })`（FAIL 時 rootCause 必填）。",
  tester:
    "先 `record_test_evidence`，再寫入 `04-test.md`：`write_ticket_artifact({ taskGid, filename: \"04-test.md\", content, summary, syncNote, manualActions, producesOfficeFiles, testLevel })`，再 `advance_ticket_stage({ taskGid, stage: \"tested\", verdict, rootCause })`。",
};

const ENV_TRAPS = [
  "## 環境陷阱（照做，不要再踩一次）",
  "- `run_project_shell` 是 Windows PowerShell 5.1：不能用 `&&`／`||`（用 `;`）、原生指令別加 `2>&1`、長輸出導到檔案再讀、git 指令以 `Set-Location <目錄>;` 開頭。",
  "- 這台機器啟動程序很慢：每次 `run_project_shell` 都要設 `timeoutMs`（建議 600000），逐個執行，不要同時開多個。",
  "- 不要寫含中文的 `.ps1`（無 BOM 會亂碼寫壞檔案）；要程式化改檔，用 `python -I` 以 UTF-8 位元組讀寫。",
  "- 專案原始碼多為 CRLF：改檔維持原本換行；改完檢查沒有混用換行、沒有 U+FFFD 亂碼字元、沒有遺失的反斜線。",
  "- Bash 指令文字裡的反斜線會被靜默壓掉（Windows 路徑的分隔符號消失、字串跳脫失效，且不會報錯）：路徑一律用正斜線；需要反斜線或中文時，改用 Write 工具寫成 UTF-8 腳本檔再執行。Windows 原生 Python 看不到 Git Bash 的 `/tmp`，Python 讀標準輸入的中文會被當 cp950。",
  "- 你寫的測試若會觸發狀態寫入或報告同步，必須把 `process.env.ASANA_MCP_PATH` 指向不存在的檔案、設 `PIPELINE_ASANA_USER_GID`，結束時關閉子 MCP 連線；絕不可啟動真的 asana-mcp（會用到使用者真實憑證）。",
  "- 只透過 dev-pipeline-mcp 的工具讀寫程式碼與票單追蹤檔，不要用原生檔案／shell 工具碰 `projectDir`。",
].join("\n");

const REPORT_FORMAT = [
  "## 回報格式（你的最終訊息就是交付物，主流程只會收到它）",
  "1. 寫入了哪些追蹤檔、推進後的 stage。",
  "2. 判定／結論一行（分析：根因；工程：改了什麼；驗證、測試：PASS／FAIL＋理由）。",
  "3. 需要使用者處理的事項清單（manualActions、需使用者決定或確認的事）；沒有寫「無」。",
  "4. 疑慮與不確定處；沒有寫「無」。",
  "禁止：自行 `git commit`／`git push`（commit 由主流程決定；你只需依固定格式列出「已完成但尚未commit：檔名A、檔名B」）；替使用者做確認（`record_confirmation`、`record_spec_confirmation` 等）；自行略過 SD（只有使用者明確說不需要才可略過，且須帶使用者原話）。不清楚或矛盾處停下來回報，不要猜。不要再呼叫 `get_pipeline_overview`。",
].join("\n");

export interface SubagentBriefInput {
  role: RoleName;
  taskGid: string;
  ticketNumber: string;
  projectName: string | null;
  projectGid: string | null;
  projectDir: string | null;
  stage: string;
  verdict: string | null;
  sdMode: SdMode | null;
  specOrder: SpecOrder | null;
  nextActionSummary: string;
  blockedBy: string[];
}

const UNKNOWN = "（未記錄）";

/** 派給子代理人的簡報：票單資訊由狀態自動帶入，主流程不必手寫，也不會漏帶 projectDir。 */
export function buildSubagentBrief(input: SubagentBriefInput): string {
  const lines = [
    `# 派工簡報：${ROLE_LABEL[input.role]}（子代理人）`,
    "",
    "你是主流程派來扮演單一角色的子代理人，沒有主流程的對話記憶。依下面資料與後面的角色說明工作；不要再呼叫 `get_pipeline_overview`。",
    "",
    `- taskGid：\`${input.taskGid}\``,
    `- 票號：${input.ticketNumber}`,
    `- Asana 專案：${input.projectName ?? UNKNOWN}（projectGid：\`${input.projectGid ?? UNKNOWN}\`）`,
    `- projectDir：\`${input.projectDir ?? UNKNOWN}\`（需要時一律帶它）`,
    `- 目前 stage：${input.stage}${input.verdict ? `（verdict：${input.verdict}）` : ""}`,
  ];
  if (input.sdMode) lines.push(`- sdMode：${input.sdMode}${input.specOrder ? `、specOrder：${input.specOrder}` : ""}`);
  lines.push(`- nextAction：${input.nextActionSummary}`);
  if (input.blockedBy.length > 0) lines.push(`- 目前被擋住：${input.blockedBy.join("；")}`);
  lines.push("", "## 你要寫入的追蹤檔", ROLE_WRITE_TARGET[input.role], "", ENV_TRAPS, "", REPORT_FORMAT);
  return lines.join("\n");
}
