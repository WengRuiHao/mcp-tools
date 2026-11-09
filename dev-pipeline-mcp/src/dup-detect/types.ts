// S11 自動重複程式碼偵測：型別與預設值（尚未接到任何 MCP 工具）。

/** 偵測設定。可由專案 flow.json 覆寫其中任何欄位。 */
export interface DupOptions {
  /** 一般檔案：連續相符的正規化行數門檻。 */
  minRun: number;
  /** 測試檔案（任一方是測試檔）：連續相符的正規化行數門檻。 */
  testMinRun: number;
  /** 區塊正規化後的最少字元數，少於此值不算。 */
  minChars: number;
  /** 掃描檔案數上限，超過時標示 truncated。 */
  maxFiles: number;
  /** 整體時間上限（毫秒），超過時標示 truncated。 */
  timeoutMs: number;
  /** 排除規則（目錄名、*.副檔名、含 / 的路徑前綴）；指定時取代預設。 */
  excludeGlobs: string[];
  /** 額外排除規則，附加在 excludeGlobs 之後。 */
  extraExcludes: string[];
}

export const DEFAULT_MIN_RUN = 8;
export const DEFAULT_TEST_MIN_RUN = 15;
export const DEFAULT_MIN_CHARS = 120;
export const DEFAULT_MAX_FILES = 20000;
export const DEFAULT_TIMEOUT_MS = 20000;
/** 單檔大小上限（位元組），超過者不讀。 */
export const MAX_FILE_BYTES = 300 * 1024;
/** 同一個視窗雜湊最多記錄幾處，避免大量相同樣板造成比對暴增。 */
export const MAX_BUCKET_SIZE = 20;

export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  "node_modules", "dist", "build", "target", "out", ".git", ".svn", ".idea", ".vscode",
  ".asana-pipeline", ".dev-pipeline", "vendor", "*.min.js", "*.min.css",
];

export const DEFAULT_DUP_OPTIONS: Readonly<DupOptions> = Object.freeze({
  minRun: DEFAULT_MIN_RUN,
  testMinRun: DEFAULT_TEST_MIN_RUN,
  minChars: DEFAULT_MIN_CHARS,
  maxFiles: DEFAULT_MAX_FILES,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS],
  extraExcludes: [],
});

/** 一行正規化後的結果：text 是正規化文字，line 是原始行號（1 起算）。 */
export interface NormLine {
  text: string;
  line: number;
}

export type DupKind = "existing" | "within-change";

export interface DupBlock {
  file: string;
  startLine: number;
  endLine: number;
  otherFile: string;
  otherStartLine: number;
  otherEndLine: number;
  matchedLines: number;
  kind: DupKind;
}

/** 豁免：由工程師在「重用檢查紀錄」寫明理由，驗證師審查。 */
export interface DupWaiver {
  file: string;
  otherFile?: string;
  reason: string;
}

export interface DupReport {
  /** 是否擋下交件：只看未被豁免的區塊。 */
  blocking: boolean;
  duplicates: DupBlock[];
  /** 被豁免的區塊（列在報告中，不是消失）。 */
  waived: Array<DupBlock & { reason: string }>;
  /** 理由太短而無效的豁免（呼叫端可提醒工程師補寫）。 */
  invalidWaivers: DupWaiver[];
  /** 實際參與比對的檔案數（含改動檔案）。 */
  scannedFiles: number;
  truncated: boolean;
  truncatedReason?: string;
  /** 改動清單中因不存在、二進位、過大、被排除或自動產生而略過的檔案。 */
  skippedChanged: string[];
  options: DupOptions;
}

export class DupPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DupPathError";
  }
}
