import type { DupBlock, DupReport } from "./types.js";

function range(file: string, start: number, end: number): string {
  return `\`${file}\` 第 ${start}～${end} 行`;
}

function blockLine(b: DupBlock, index: number): string {
  const kind = b.kind === "existing" ? "與專案既有程式碼重複" : "改動檔案之間（或同檔內）重複";
  return `${index}. ${range(b.file, b.startLine, b.endLine)} ⇄ ${range(b.otherFile, b.otherStartLine, b.otherEndLine)}` +
    `（連續 ${b.matchedLines} 行相符，${kind}）`;
}

/** 產出繁體中文 markdown 報告（給 dup-report.md 用）。 */
export function formatDupReport(report: DupReport): string {
  const out: string[] = ["# 重複程式碼偵測報告", ""];
  out.push("## 總結", "");
  out.push(`- 結果：${report.blocking ? "**擋下交件**（有未豁免的大段重複）" : "通過（沒有未豁免的大段重複）"}`);
  out.push(`- 未豁免的重複區塊：${report.duplicates.length} 筆`);
  out.push(`- 已豁免的重複區塊：${report.waived.length} 筆`);
  out.push(`- 掃描檔案數：${report.scannedFiles}`);
  const { minRun, testMinRun, minChars } = report.options;
  out.push(`- 門檻：連續 ${minRun} 行（測試檔 ${testMinRun} 行）、至少 ${minChars} 字元`);
  out.push(`- 是否截斷：${report.truncated ? `是（${report.truncatedReason ?? "已達掃描上限"}），結果可能不完整` : "否"}`);
  if (report.skippedChanged.length > 0) {
    out.push(`- 略過的改動檔案（不存在、二進位、過大、被排除或自動產生）：${report.skippedChanged.map((f) => `\`${f}\``).join("、")}`);
  }
  out.push("");
  if (report.duplicates.length > 0) {
    out.push("## 未豁免的重複區塊", "");
    report.duplicates.forEach((b, i) => out.push(blockLine(b, i + 1)));
    out.push("", "### 修正建議", "");
    out.push("- 先找專案裡既有的共用方法或模組，改成呼叫它，不要複製貼上。");
    out.push("- 若沒有可用的共用方法，把重複的部分抽成共用方法，兩處都改成呼叫它。");
    out.push("- 確有正當理由必須保留（例如兩邊刻意獨立演進）：在「重用檢查紀錄」對該筆寫明理由，由驗證師審查後放行。");
    out.push("");
  }
  if (report.waived.length > 0) {
    out.push("## 已豁免的重複區塊（需驗證師審查理由）", "");
    report.waived.forEach((b, i) => {
      out.push(blockLine(b, i + 1));
      out.push(`   - 豁免理由：${b.reason}`);
    });
    out.push("");
  }
  if (report.invalidWaivers.length > 0) {
    out.push("## 無效的豁免（理由太短，至少 4 個字元）", "");
    for (const w of report.invalidWaivers) {
      out.push(`- \`${w.file}\`${w.otherFile ? ` ⇄ \`${w.otherFile}\`` : ""}：理由「${(w.reason ?? "").trim()}」`);
    }
    out.push("");
  }
  return out.join("\n");
}
