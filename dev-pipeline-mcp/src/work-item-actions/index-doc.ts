import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TicketStatus } from "../pipeline-store.js";
import { buildWhenContext } from "../work-item-store.js";
import { artifactDeliverablePaths, deliverablePaths } from "../workflow/deliverable-files.js";
import { FINAL_SUMMARY_FILE, decisionText, deciderText, formatTime, gateLabel, oneLine } from "../workflow/final-summary.js";
import { INDEX_DOC_FILE } from "../workflow/internal-files.js";
import { resolveWorkflow } from "../workflow/resolve.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { isRoleDone } from "../workflow/work-item-progress.js";
import { errorMessage } from "./common.js";
import { loadEffectiveDef } from "./context.js";
import { decisionsOf, uncovered } from "./decisions.js";
import { staleUpstreamNote } from "./stale-upstream.js";
import { readPendingQuestions } from "./sa-notes-questions.js";
import { escalationsOf } from "./review-escalation.js";
import { ROLE_LABELS, viewFor } from "./view.js";

/**
 * 每個工作項目目錄的 00-索引.md：由系統依 status.json 與流程定義產生（不是 AI 手寫），
 * 讓使用者一眼看出流程走到哪、哪些檔案要看、關卡誰在何時確認了什麼。write／done／confirm／verdict／create 後都應重新產生。
 */

export { INDEX_DOC_FILE };

const ROLE_PURPOSE: Readonly<Record<string, string>> = {
  "baseline-survey": "盤點既有系統現況並分析影響範圍、列出可重用清單",
  "tech-selector": "決定本次採用的技術棧",
  "mockup-designer": "做可操作的畫面原型供使用者確認",
  "sa-analyst": "撰寫給客戶看的需求說明（SA）",
  "db-designer": "設計資料表結構與 SQL（無異動時內容很少）",
  "flow-analyst": "畫出流程圖",
  "sd-analyst": "撰寫給工程師實作用的設計規格（SD）",
  "spec-verifier": "比對 SA、DB、流程、SD 是否一致",
  "frontend-engineer": "前端實作並記錄改動",
  "backend-engineer": "後端實作並記錄改動",
  verifier: "驗證實作是否符合規格",
  tester: "實際測試並留下測試證據",
};
const NOT_STARTED = "未開始";
const FOCUS_TAG = "給人看的重點檔";
const INTERNAL_TAG = "內部過程檔（給後面角色用，可以不看）";

/** 表格儲存格：跳脫直線、換行改成空白。 */
const cell = (s: string): string => oneLine(s).replace(/\|/g, "\\|");
const link = (p: string): string => `[${p}](${p})`;

interface RoleRow {
  order: number;
  id: string;
  state: "完成" | "進行中" | "未開始";
  files: { path: string; focus: boolean; exists: boolean }[];
}

async function exists(dir: string, rel: string): Promise<boolean> {
  return stat(path.join(dir, rel)).then(() => true, () => false);
}

async function roleRows(dir: string, status: TicketStatus, def: WorkflowDefinition, available: ReadonlySet<string>): Promise<RoleRow[]> {
  const resolved = resolveWorkflow(def, buildWhenContext(status));
  const focus = new Set(deliverablePaths(def));
  return Promise.all(
    resolved.roles.map(async (r, i) => {
      const paths = [...new Set(r.outputs.flatMap((o) => def.artifacts.filter((a) => a.id === o).flatMap((a) => [a.file, ...(a.attachments ?? []), ...(a.render ? [a.render] : [])])))];
      const files = await Promise.all(paths.map(async (p) => ({ path: p, focus: focus.has(p), exists: await exists(dir, p) })));
      const state = isRoleDone(status.work_item_progress, r.id) ? "完成" : available.has(r.id) ? "進行中" : NOT_STARTED;
      return { order: i + 1, id: r.id, state, files } satisfies RoleRow;
    })
  );
}

const fileCell = (f: RoleRow["files"][number]): string => `${link(f.path)}${f.exists ? "" : "（尚未產生）"}｜${f.focus ? FOCUS_TAG : INTERNAL_TAG}`;

function flowTable(rows: readonly RoleRow[]): string[] {
  return [
    "## 流程對照表",
    "",
    "| 順序 | 階段／角色 | 負責角色 | 交件檔案（及類別） | 狀態 | 用途 |",
    "| :-: | --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.order} | ${cell(ROLE_LABELS[r.id] ?? r.id)} | ${r.id} | ${cell(r.files.map(fileCell).join("<br>"))} | ${r.state} | ${cell(ROLE_PURPOSE[r.id] ?? "（無說明）")} |`),
    "",
  ];
}

async function focusSection(dir: string, def: WorkflowDefinition, status: TicketStatus): Promise<string[]> {
  const active = new Set(resolveWorkflow(def, buildWhenContext(status)).roles.flatMap((r) => r.outputs));
  const paths = [...new Set(deliverablePaths(def, [...active]))];
  const lines = await Promise.all(paths.map(async (p) => `- ${link(p)}${(await exists(dir, p)) ? "" : "（尚未產生）"}`));
  const summary = (await exists(dir, FINAL_SUMMARY_FILE)) ? [`- ${link(FINAL_SUMMARY_FILE)}（最終驗收整理報告）`] : [];
  return ["## 給人看的重點檔（正式交付物）", "", ...(lines.length > 0 ? lines : ["- （無）"]), ...summary, "", "其餘檔案是內部過程檔（給後面的角色或程式檢查用），不需要逐一閱讀。", ""];
}

function gateSection(status: TicketStatus, def: WorkflowDefinition): string[] {
  const resolved = resolveWorkflow(def, buildWhenContext(status));
  const gates = status.work_item_progress?.gates ?? {};
  const rows = resolved.gates.map((g) => {
    const r = gates[g.id];
    if (!r) {
      const esc = escalationsOf(status)[g.id];
      return `| ${cell(gateLabel(g.id))} | 尚無紀錄 | | | ${esc ? cell(`AI 審查員已升級給使用者（申報 ${esc.declared.join("、")}）：${esc.reasons}`) : ""} |`;
    }
    const styleNote = g.id === "mockup-confirm" && r.decision === "confirmed" && status.selected_style ? `（選定風格：${status.selected_style}）` : "";
    const who = r.by === "human" ? "human（使用者本人）" : `agent（${deciderText(r)}）`;
    return `| ${cell(gateLabel(g.id))} | ${decisionText(r.decision)} | ${who} | ${formatTime(r.at)} | ${cell(`${r.reason ?? ""}${styleNote}`)} |`;
  });
  return ["## 關卡確認紀錄", "", "只保留各關卡最後一次的決定；「使用者原話」欄是 human 確認時附的原文，agent 則是審查理由。", "", "| 關卡 | 決定 | 誰 | 時間 | 使用者原話／理由 |", "| --- | --- | --- | --- | --- |", ...rows, ""];
}

/** 使用者決定記錄與尚無記錄的待確認問題；兩者都沒有時不產生章節。 */
async function decisionSection(dir: string, status: TicketStatus): Promise<string[]> {
  const ds = decisionsOf(status);
  const open = uncovered(await readPendingQuestions(dir), ds);
  if (ds.length === 0 && open.length === 0) return [];
  return [
    "## 使用者決定記錄",
    "",
    "使用者對待確認問題與其他事項的決定（record_decision 記錄；審查員依此判斷，已記錄的事項不再升級給使用者）。",
    "",
    ...(ds.length > 0
      ? ["| 問題 | 決定 | 使用者原話 | 時間 |", "| --- | --- | --- | --- |", ...ds.map((d) => `| ${cell(d.question)} | ${cell(d.answer)} | ${cell(d.quote)} | ${formatTime(d.at)} |`)]
      : ["（尚無）"]),
    ...(open.length > 0 ? ["", `尚無決定記錄的待確認問題：${open.map((q) => cell(`${q.id} ${q.title}`)).join("；")}`] : []),
    "",
  ];
}

async function staleSection(dir: string, status: TicketStatus): Promise<string[]> {
  const note = await staleUpstreamNote(dir, status);
  return note ? ["## 上游文件可能過期", "", note, ""] : [];
}

/** 純函式的索引全文組裝（IO 結果由呼叫端量測）。 */
export async function buildIndexDoc(dir: string, status: TicketStatus, def: WorkflowDefinition, overrideApplied = false): Promise<string> {
  const v = viewFor(status, def, overrideApplied);
  const available = new Set(v.next.available.map((a) => a.roleId));
  const rows = await roleRows(dir, status, def, available);
  const title = status.name ? oneLine(status.name) : path.basename(dir);
  return [
    `# 工作項目索引：${title}`,
    "",
    `> 本檔由系統依進度紀錄自動產生，請勿手動修改。需求名稱：${title}｜目前階段：${v.summary}｜是否完成：${v.next.complete ? "是" : "否"}`,
    "",
    ...flowTable(rows),
    ...(await focusSection(dir, def, status)),
    ...gateSection(status, def),
    ...(await decisionSection(dir, status)),
    ...(await staleSection(dir, status)),
  ].join("\n");
}

/**
 * 重新產生 00-索引.md；絕不丟錯：成功回 undefined，失敗回警告字串（呼叫端可附在回傳）。
 * ctx.status 必須是「動作之後」的最新狀態；已有流程定義時傳 opts.def 可省一次載入。
 */
export async function refreshIndexDoc(ctx: { dir: string; status: TicketStatus }, opts: { def?: WorkflowDefinition; overrideApplied?: boolean } = {}): Promise<string | undefined> {
  try {
    const loaded = opts.def ? { def: opts.def, overrideApplied: opts.overrideApplied ?? false } : await loadEffectiveDef(ctx.status);
    await writeFile(path.join(ctx.dir, INDEX_DOC_FILE), await buildIndexDoc(ctx.dir, ctx.status, loaded.def, loaded.overrideApplied), "utf-8");
    return undefined;
  } catch (e) {
    return `${INDEX_DOC_FILE} 更新失敗（不影響本次動作）：${errorMessage(e)}`;
  }
}
