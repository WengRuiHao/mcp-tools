import { execFile } from "node:child_process";
import { lstat, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { isInside } from "../render/path-safety.js";

/** SA（01-sa.md）轉 Word（01-sa.docx）：呼叫隨套件發佈的 scripts/sa_to_docx.py。有 Python 3 與 python-docx 才轉；環境缺少回 unavailable（警告），轉換失敗回 failed（擋交件）。 */

export const SA_MD_NAME = "01-sa.md";
export const SA_DOCX_NAME = "01-sa.docx";
const DOCX_TMP_NAME = "01-sa.docx.tmp";
const PROBE_TIMEOUT_MS = 15_000;
const CONVERT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_DOCX_BYTES = 50 * 1024 * 1024;
const PROBE_CODE = "import sys, docx\nsys.exit(0 if sys.version_info[0] == 3 else 1)";
const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "sa_to_docx.py");
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);

export interface PythonCommand {
  command: string;
  /** 放在腳本路徑前面的固定參數（例如 py 的 -3）。 */
  args: string[];
}

export type SaDocxResult =
  | { status: "ok"; out: string; bytes: number; images: number; tables: number }
  | { status: "unavailable"; reason: "python-not-available"; hint: string }
  | { status: "failed"; message: string };

export interface SaDocxHooks {
  detect: () => Promise<PythonCommand | null>;
  /** 回傳腳本結束碼、stdout、stderr；逾時或無法啟動以 exitCode:null 表示。 */
  run: (py: PythonCommand, args: string[]) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

function exec(command: string, args: string[], timeout: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // 工作目錄固定在腳本目錄：python -c 會把目前目錄加進 import 路徑，不可落在 AI 可寫入的工作項目目錄。
    execFile(command, args, { cwd: SCRIPT_DIR, timeout, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } }, (err, stdout, stderr) => {
      if (!err) return resolve({ exitCode: 0, stdout, stderr });
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
      resolve({ exitCode: typeof code === "number" ? code : null, stdout: stdout ?? "", stderr: stderr || err.message });
    });
  });
}

/** 候選順序：Windows 優先 py -3，其次 python、python3；其他平台 python3、python。環境變數 DEV_PIPELINE_PYTHON 指定單一直譯器（值為 none 代表視為沒有 Python）。 */
export function pythonCandidates(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): PythonCommand[] | "none" {
  const forced = env.DEV_PIPELINE_PYTHON?.trim();
  if (forced) return forced.toLowerCase() === "none" ? "none" : [{ command: forced, args: [] }];
  const py = { command: "py", args: ["-3"] };
  const python = { command: "python", args: [] };
  const python3 = { command: "python3", args: [] };
  return platform === "win32" ? [py, python, python3] : [python3, python];
}

async function defaultDetect(): Promise<PythonCommand | null> {
  const candidates = pythonCandidates();
  if (candidates === "none") return null;
  for (const c of candidates) {
    const r = await exec(c.command, [...c.args, "-c", PROBE_CODE], PROBE_TIMEOUT_MS);
    if (r.exitCode === 0) return c;
  }
  return null;
}

const defaultHooks: SaDocxHooks = { detect: defaultDetect, run: (py, args) => exec(py.command, [...py.args, ...args], CONVERT_TIMEOUT_MS) };
let hooks: SaDocxHooks = defaultHooks;

/** 測試用：注入偵測與執行函式；傳 null 還原。 */
export function setSaDocxHooks(h: Partial<SaDocxHooks> | null): void {
  hooks = h ? { ...defaultHooks, ...h } : defaultHooks;
}

/** 這個環境是否能轉 Word（有 Python 3 與 python-docx）。 */
export async function isSaDocxAvailable(): Promise<boolean> {
  return (await hooks.detect()) !== null;
}

/** md 內的圖片引用數（與轉換腳本相同規則：![說明](路徑)）。 */
export function countMdImages(md: string): number {
  return (md.match(/!\[[^\]]*\]\([^)]*\)/g) ?? []).length;
}

/** 讀 docx（zip）內 word/document.xml 的內容。 */
export function readDocxDocumentXml(docx: Buffer): string {
  const eocd = docx.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("不是有效的 docx（找不到 zip 結尾記錄）");
  const total = docx.readUInt16LE(eocd + 10);
  let pos = docx.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i++) {
    if (docx.readUInt32LE(pos) !== 0x02014b50) throw new Error("docx 的 zip 目錄毀損");
    const method = docx.readUInt16LE(pos + 10);
    const compSize = docx.readUInt32LE(pos + 20);
    const nameLen = docx.readUInt16LE(pos + 28);
    const extraLen = docx.readUInt16LE(pos + 30);
    const commentLen = docx.readUInt16LE(pos + 32);
    const localOffset = docx.readUInt32LE(pos + 42);
    const name = docx.toString("utf8", pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;
    if (name !== "word/document.xml") continue;
    const dataStart = localOffset + 30 + docx.readUInt16LE(localOffset + 26) + docx.readUInt16LE(localOffset + 28);
    const raw = docx.subarray(dataStart, dataStart + compSize);
    return (method === 0 ? raw : inflateRawSync(raw)).toString("utf8");
  }
  throw new Error("docx 內沒有 word/document.xml");
}

/** 內嵌圖片數（pic:pic）；相同圖檔重複使用會被合併成一個媒體檔，所以不能數 media 檔。 */
export const countDocxImages = (docx: Buffer): number => (readDocxDocumentXml(docx).match(/<pic:pic[\s>]/g) ?? []).length;

/** 表格數（w:tbl，不含巢狀以外的其他標籤）。 */
export const countDocxTables = (docx: Buffer): number => (readDocxDocumentXml(docx).match(/<w:tbl>/g) ?? []).length;

async function assertPlainFileInside(dir: string, file: string, label: string): Promise<void> {
  const st = await lstat(file).catch(() => null);
  if (!st) throw new Error(`找不到${label}`);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${label}不是一般檔案`);
  if (!isInside(await realpath(dir), await realpath(file))) throw new Error(`${label}超出工作項目目錄`);
}

async function removeQuietly(file: string): Promise<void> {
  await rm(file, { force: true }).catch(() => undefined);
}

const UNAVAILABLE_HINT = "本機沒有 Python 3 或沒有安裝 python-docx（pip install python-docx），無法把 SA 轉成 Word；請在有 Python 的環境執行 work_item action=render kind=docx 補轉，或自行把 01-sa.md 轉成 Word 後交付。";

/** 把工作項目目錄內的 01-sa.md 轉成 01-sa.docx 並驗證（非空、內嵌圖片數與 md 圖片引用數一致）。 */
export async function convertSaToDocx(dir: string): Promise<SaDocxResult> {
  const py = await hooks.detect();
  if (!py) return { status: "unavailable", reason: "python-not-available", hint: UNAVAILABLE_HINT };
  const md = path.join(dir, SA_MD_NAME);
  const out = path.join(dir, SA_DOCX_NAME);
  const tmp = path.join(dir, DOCX_TMP_NAME);
  const fail = async (message: string): Promise<SaDocxResult> => {
    await removeQuietly(tmp);
    await removeQuietly(out); // 不留下與目前 SA 不一致的舊 Word
    return { status: "failed", message };
  };
  try {
    await assertPlainFileInside(dir, md, SA_MD_NAME);
    const outStat = await lstat(out).catch(() => null);
    if (outStat?.isSymbolicLink()) return { status: "failed", message: `${SA_DOCX_NAME} 是符號連結，拒絕覆寫` };
    const text = await readFile(md, "utf-8");
    const r = await hooks.run(py, [SCRIPT_PATH, md, tmp, "SA"]);
    if (r.exitCode !== 0) return fail(`SA 轉 Word 失敗：${(r.stderr || r.stdout).trim().slice(0, 500) || (r.exitCode === null ? "執行逾時或無法啟動 Python" : `結束碼 ${r.exitCode}`)}`);
    const buf = await readFile(tmp);
    if (buf.length === 0) return fail("SA 轉 Word 失敗：產生的 Word 檔是空的");
    if (buf.length > MAX_DOCX_BYTES) return fail(`SA 轉 Word 失敗：產生的 Word 檔過大（${buf.length} bytes）`);
    const mdImages = countMdImages(text);
    const docxImages = countDocxImages(buf);
    if (docxImages !== mdImages) return fail(`SA 轉 Word 驗證失敗：md 有 ${mdImages} 張圖片引用，Word 只嵌入 ${docxImages} 張`);
    await rename(tmp, out);
    return { status: "ok", out: SA_DOCX_NAME, bytes: buf.length, images: docxImages, tables: (text.match(/^\s*\|[\s:|-]+\|\s*$/gm) ?? []).length };
  } catch (e) {
    return fail(`SA 轉 Word 失敗：${e instanceof Error ? e.message : String(e)}`);
  }
}
