/**
 * 批次上傳的「快速路徑」：這次上傳的檔案**全部都是遠端還沒有的新檔案**時，改用 `svnmucc` 一次送出，不建立工作副本。
 *
 * 為什麼：SVN 的工作副本每個檔案都要做好幾次檔案改名（`rename`），資安軟體（例如 Trend Micro）會攔截每一次改名，
 * 一次要好幾秒；上傳六萬個檔案光改名就要幾十個小時。`svnmucc` 直接把檔案內容送到伺服器、同一個 commit 完成，
 * 不經過工作副本，沒有這些改名；實測比工作副本快 8～12 倍。
 *
 * 限制（都有對應的處理）：
 * - `svnmucc` 讀參數檔與說明檔時一律當成「系統內碼頁」（繁體 Windows 是 Big5），不是 UTF-8。所以參數檔只放純英數
 *   （本機來源用我們自己取的英數檔名，遠端網址用百分比編碼），提交說明改用系統內碼頁寫成檔案；
 *   說明裡有系統內碼頁表示不了的字元時就不走快速路徑，由呼叫端退回工作副本的做法。
 * - `svnmucc put` 對內容完全相同的既有檔案也會產生新版本，所以只用在「全部都是新檔案」的情況。
 * - 找不到 `svnmucc`、或它不能用，丟 MuccUnavailableError，呼叫端退回工作副本的做法。
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { SvnConnection } from "./svn-client.js";
import { decodeSvnText } from "./svn-text.js";
import { errorMessage, parseRevision } from "./util.js";

/** svnmucc 不能用（找不到、版本太舊不認得參數…）：呼叫端應該退回別的做法，不是上傳失敗。 */
export class MuccUnavailableError extends Error {}

const IS_WINDOWS = process.platform === "win32";
let svnmuccPath: string | null | undefined;

/**
 * 找 svnmucc：跟 PATH 裡的 svn 放在同一個資料夾（TortoiseSVN 的 bin 裡就有）。
 * `SVN_EDIT_DISABLE_MUCC=1` 關閉快速路徑；`SVN_EDIT_MUCC_PATH` 指定路徑（測試用，指到不存在的檔案就是找不到）。
 */
export function findSvnmucc(): string | null {
  if (process.env.SVN_EDIT_DISABLE_MUCC === "1") return null;
  const override = process.env.SVN_EDIT_MUCC_PATH?.trim();
  if (override) return existsSync(override) ? override : null;
  if (svnmuccPath !== undefined) return svnmuccPath;
  svnmuccPath = null;
  const [svnName, muccName] = IS_WINDOWS ? ["svn.exe", "svnmucc.exe"] : ["svn", "svnmucc"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !existsSync(path.join(dir, svnName))) continue;
    const candidate = path.join(dir, muccName);
    if (existsSync(candidate)) {
      svnmuccPath = candidate;
      break;
    }
  }
  return svnmuccPath;
}

// ---- 系統內碼頁編碼（提交說明檔要用）----

export type MessageEncoder = (text: string) => { bytes: Buffer; unsupported: string[] };

/** Windows ANSI 內碼頁 → TextDecoder 的名稱。 */
const ACP_LABELS: Record<number, string> = {
  950: "big5",
  936: "gbk",
  932: "shift_jis",
  949: "euc-kr",
  874: "windows-874",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  65001: "utf-8",
};

function readAnsiCodePage(): number | null {
  if (!IS_WINDOWS) return null;
  try {
    const out = execFileSync("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "ACP"], { encoding: "utf-8", windowsHide: true, timeout: 5000 });
    const match = /ACP\s+REG_SZ\s+(\d+)/.exec(out);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * 用 TextDecoder 反推出「字元 → 位元組」的對照表（Node 內建只能解碼、不能編成 Big5／GBK 等，這樣不需要額外套件）。
 * 先找單位元組（0x80–0xFF），再找雙位元組；只有「解碼剛好是一個字元」的組合才收進來。
 */
export function buildEncoder(label: string): MessageEncoder {
  const decoder = new TextDecoder(label, { fatal: false });
  const map = new Map<string, number[]>();
  const add = (bytes: number[]): void => {
    const s = decoder.decode(Uint8Array.from(bytes));
    if (s.length === 1 && s !== "�" && !map.has(s)) map.set(s, bytes);
  };
  for (let b = 0x80; b <= 0xff; b++) add([b]);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail !== 0x7f) add([lead, trail]);
    }
  }
  return (text) => {
    const out: number[] = [];
    const unsupported: string[] = [];
    for (const ch of text) {
      if (ch.codePointAt(0)! < 0x80) out.push(ch.codePointAt(0)!);
      else {
        const bytes = map.get(ch);
        if (bytes) out.push(...bytes);
        else unsupported.push(ch);
      }
    }
    return { bytes: Buffer.from(out), unsupported };
  };
}

let cachedEncoder: MessageEncoder | null | undefined;

/** 這台電腦「系統內碼頁」的編碼器；讀不到內碼頁或不支援就回 null（呼叫端退回別的做法）。 */
export function systemMessageEncoder(): MessageEncoder | null {
  if (cachedEncoder !== undefined) return cachedEncoder;
  const acp = readAnsiCodePage();
  const label = acp === null ? undefined : ACP_LABELS[acp];
  if (!label) return (cachedEncoder = null);
  cachedEncoder = label === "utf-8" ? (text) => ({ bytes: Buffer.from(text, "utf-8"), unsupported: [] }) : buildEncoder(label);
  return cachedEncoder;
}

// ---- 參數檔 ----

export interface MuccPut {
  /** 遠端路徑（相對於連線網址，用 `/` 分隔，可以有中文）。 */
  remoteRel: string;
  /** 本機來源檔案路徑：必須是純 ASCII（參數檔不受內碼頁影響）。 */
  localPath: string;
  /** 要設定的屬性（名稱, 值）。 */
  props: Array<[string, string]>;
}

/** 路徑每一段做百分比編碼（中文、空白、括號等都變成 %XX），結果是純 ASCII。 */
export function percentEncodePath(rel: string): string {
  return rel.split("/").map(encodeURIComponent).join("/");
}

export function isAscii(text: string): boolean {
  return /^[\x00-\x7f]*$/.test(text);
}

/**
 * 組出 svnmucc 的參數檔（一行一個參數，`-X` 讀入）：先依深度由淺到深建立資料夾，再放檔案與屬性。
 * 輸出一定是純 ASCII；本機來源路徑不是 ASCII 就丟錯誤（呼叫端要先檢查）。
 */
export function buildMuccArgsFile(mkdirs: string[], puts: MuccPut[]): string {
  const lines: string[] = [];
  for (const dir of mkdirs) lines.push("mkdir", percentEncodePath(dir));
  for (const put of puts) {
    if (!isAscii(put.localPath)) throw new MuccUnavailableError(`本機來源路徑含有非英數字元，沒辦法交給 svnmucc：${put.localPath}`);
    const remote = percentEncodePath(put.remoteRel);
    lines.push("put", put.localPath, remote);
    for (const [name, value] of put.props) lines.push("propset", name, value, remote);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 設定了 svn:eol-style=native 的文字檔，SVN 在 commit 時會把 CRLF 轉成 LF 存進儲存庫；`svnmucc put` 不會自己轉，
 * 所以這裡先判斷並轉好。回傳：內容（可能已轉換）與要不要設這個屬性。
 * 換行混用（CRLF 跟單獨 LF／CR 都有）、單獨的 CR、含 NUL 位元組：不設屬性、內容不動（SVN 本來也會拒絕這種檔案）。
 */
export function prepareNativeEol(content: Buffer): { content: Buffer; setProp: boolean } {
  if (content.includes(0)) return { content, setProp: false };
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < content.length; i++) {
    const b = content[i];
    if (b === 0x0d) {
      if (content[i + 1] === 0x0a) {
        crlf++;
        i++;
      } else cr++;
    } else if (b === 0x0a) lf++;
  }
  if (cr > 0 || (crlf > 0 && lf > 0)) return { content, setProp: false };
  if (crlf === 0) return { content, setProp: true };
  const out = Buffer.alloc(content.length - crlf);
  let o = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === 0x0d && content[i + 1] === 0x0a) continue;
    out[o++] = content[i];
  }
  return { content: out, setProp: true };
}

// ---- 執行 ----

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const UNUSABLE_RE = /invalid option|unknown option|E205000|not recognized as an internal or external command/i;

export interface MuccRunParams {
  conn: SvnConnection;
  /** 連線網址（純 ASCII、已做百分比編碼）；參數檔裡的網址都是相對於它。 */
  rootUrl: string;
  /** 已經編成系統內碼頁的提交說明。 */
  messageFile: string;
  argsFile: string;
  timeoutMs: number;
}

/** 執行 svnmucc；成功回傳新版本號（讀不到是 null）。svnmucc 不能用丟 MuccUnavailableError，其他錯誤只回報 svn 自己的訊息。 */
export function runMucc(mucc: string, params: MuccRunParams): Promise<number | null> {
  const { conn } = params;
  const args = ["--non-interactive", "--no-auth-cache", "--trust-server-cert", "--username", conn.username, "--password", conn.password, "-U", params.rootUrl, "-F", params.messageFile, "-X", params.argsFile];
  return new Promise((resolve, reject) => {
    const child = execFile(mucc, args, { timeout: params.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "buffer", windowsHide: true }, (error, stdout, stderr) => {
      const stderrText = decodeSvnText(Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr ?? ""))).trim();
      if (error) {
        const e = error as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === "ENOENT") return reject(new MuccUnavailableError("找不到 svnmucc"));
        if (UNUSABLE_RE.test(stderrText)) return reject(new MuccUnavailableError(`svnmucc 不能用：${stderrText.split(/\r?\n/)[0]}`));
        // 絕不能把 error.message 往外丟：它含完整指令列，裡面有密碼；只給 svn 自己的訊息
        if (!stderrText && e.killed) return reject(new Error(`svnmucc 執行逾時（超過 ${Math.round(params.timeoutMs / 1000)} 秒被中止），檔案數量太大，請分批上傳或調高 SVN_TIMEOUT_MS`));
        if (!stderrText) console.error(`[svn-mcp] svnmucc 失敗，未回傳給呼叫端的完整錯誤：${errorMessage(error)}`);
        return reject(new Error(stderrText || `svnmucc 執行失敗（exit code: ${String(e.code ?? "unknown")}）`));
      }
      const out = Buffer.isBuffer(stdout) ? stdout.toString("utf-8") : String(stdout);
      const match = /\br(\d+) committed/.exec(out);
      resolve(match ? Number(match[1]) : parseRevision(out));
    });
    child.stdin?.end();
  });
}
