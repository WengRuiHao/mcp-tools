import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir } from "node:fs/promises";
import {
  readStatus,
  resolveTicketDir,
  updateStatus,
  type TestEvidenceKind,
  type TestEvidenceRecord,
  type TestLevel,
  type TicketStatus,
} from "./pipeline-store.js";
import { scanTextForSecrets } from "./sensitive-patterns.js";

/** 測試用了假資料時，檔案本身要標註的固定文字。 */
export const FAKE_DATA_LABEL = "【測試假資料，非正式資料】";
export const EVIDENCE_DIR = "test-evidence";
/** 假資料證據：資料夾前綴與檔名後綴，讓使用者一眼看出不是真實資料。 */
export const FAKE_DIR_PREFIX = "【假資料】";
export const FAKE_NAME_SUFFIX = "_假資料";
/** 自動產生的「待使用者截圖」待辦固定開頭（寫 04-test.md 時用它辨識、合併、清除）。 */
export const PENDING_SCREENSHOT_ACTION_PREFIX = "請用 Excel 開啟 ";

export const EVIDENCE_KINDS = ["excel", "pdf", "api-call", "test-report", "db-state"] as const;
export const TEST_LEVELS = ["unit-mock", "integration-db", "live-api"] as const;

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FEATURE_NAME_LEN = 60;
const MAX_STEM_LEN = 80;
const KIND_EXTS: Record<TestEvidenceKind, string[]> = {
  excel: [".xlsx", ".xls"],
  pdf: [".pdf"],
  "api-call": [".json", ".txt", ".http", ".md"],
  "test-report": [".xml", ".html", ".txt", ".json"],
  "db-state": [".csv", ".json", ".txt", ".md"],
};
const SCREENSHOT_EXTS = [".png", ".jpg", ".jpeg"];
const OFFICE_KINDS: TestEvidenceKind[] = ["excel", "pdf"];
/** 文字類證據：寫入前掃描有沒有未遮蔽的機密。 */
const SECRET_SCANNED_KINDS: TestEvidenceKind[] = ["api-call", "test-report", "db-state"];
/** 假資料時，檔案第一個非空白行必須是標註文字的類型（存的就是這個檔案本身）。 */
const FAKE_FIRST_LINE_KINDS: TestEvidenceKind[] = ["api-call", "db-state"];
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export class EvidenceInputError extends Error {}

export function isOfficeKind(kind: TestEvidenceKind): boolean {
  return OFFICE_KINDS.includes(kind);
}

/** 功能名稱／檔名片段的安全化：去控制字元、`..`、路徑分隔符、Windows 不合法字元，限制長度；安全化後是空字串就丟錯。 */
export function safeSegment(raw: string, maxLen: number, label: string): string {
  let s = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\.{2,}/g, "_")
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_");
  const trim = (v: string) => v.replace(/^[._\s]+|[._\s]+$/g, "");
  s = trim(trim(s).slice(0, maxLen));
  if (!s) throw new EvidenceInputError(`${label}安全化後是空字串，請改用有意義的文字（不能只含路徑符號、點或不合法字元）。`);
  return RESERVED_NAMES.test(s) ? `_${s}` : s;
}

/** 回傳 level 較高者；用來算證據中的最高測試層級。 */
export function highestTestLevel(records: Pick<TestEvidenceRecord, "testLevel">[]): TestLevel | null {
  let best = -1;
  for (const r of records) best = Math.max(best, TEST_LEVELS.indexOf(r.testLevel));
  return best < 0 ? null : TEST_LEVELS[best];
}

async function validateFile(file: string, exts: string[], label: string): Promise<string> {
  if (!path.isAbsolute(file)) throw new EvidenceInputError(`${label} 必須是絕對路徑：${file}`);
  const abs = path.resolve(file);
  let st;
  try {
    st = await lstat(abs);
  } catch (err: any) {
    if (err.code === "ENOENT") throw new EvidenceInputError(`${label} 指向的檔案不存在：${abs}`);
    throw err;
  }
  if (st.isSymbolicLink()) throw new EvidenceInputError(`${label} 是符號連結，不接受（請給實際檔案）：${abs}`);
  if (!st.isFile()) throw new EvidenceInputError(`${label} 不是一般檔案：${abs}`);
  if (st.size > MAX_FILE_BYTES) throw new EvidenceInputError(`${label} 超過大小上限 ${MAX_FILE_BYTES / 1024 / 1024}MB：${abs}`);
  const ext = path.extname(abs).toLowerCase();
  if (!exts.includes(ext)) throw new EvidenceInputError(`${label} 副檔名 ${ext || "（無）"} 不在允許清單（${exts.join("、")}）：${abs}`);
  return abs;
}

/** 讀文字類證據並檢查：未遮蔽機密（只回報檔名與行號，不回印內容）、假資料時第一個非空白行的標註。 */
async function checkTextEvidence(abs: string, kind: TestEvidenceKind, usesFakeData: boolean): Promise<void> {
  const text = (await readFile(abs, "utf-8")).replace(/^﻿/, "");
  if (usesFakeData && FAKE_FIRST_LINE_KINDS.includes(kind)) {
    const first = text.split(/\r?\n/).find((l) => l.trim() !== "");
    if (first === undefined || first.trim() !== FAKE_DATA_LABEL) {
      throw new EvidenceInputError(
        `usesFakeData=true 的 ${kind} 證據，檔案第一個非空白行必須是「${FAKE_DATA_LABEL}」，目前檔案不符：${path.basename(abs)}。請在檔案開頭加上這一行後重新呼叫。`
      );
    }
  }
  if (SECRET_SCANNED_KINDS.includes(kind)) {
    const hits = scanTextForSecrets(text);
    if (hits.length > 0) {
      throw new EvidenceInputError(
        `${path.basename(abs)} 疑似含有未遮蔽的機密，已拒絕備份：` +
          hits.map((h) => `第 ${h.line} 行（${h.reasons.join("、")}）`).join("；") +
          "。請把 token／密碼／連線字串帳密等遮蔽成 **** 後重新呼叫（這裡不會回印疑似機密的內容）。"
      );
    }
  }
}

async function ensureEvidenceDir(ticketDir: string, safeFeature: string): Promise<string> {
  const dir = path.join(ticketDir, EVIDENCE_DIR, safeFeature);
  await mkdir(dir, { recursive: true });
  const [realDir, realTicket] = await Promise.all([realpath(dir), realpath(ticketDir)]);
  if (realDir !== realTicket && !realDir.toLowerCase().startsWith((realTicket + path.sep).toLowerCase())) {
    throw new EvidenceInputError("證據資料夾解析後不在票單追蹤目錄內（可能含符號連結），已拒絕。");
  }
  return dir;
}

/** 先全部複製到暫存資料夾再改名到定位，避免來源檔剛好就在證據資料夾內時被覆寫到一半。 */
async function placeFiles(dir: string, items: { src: string; destName: string }[]): Promise<void> {
  const staging = path.join(dir, `.staging-${randomBytes(4).toString("hex")}`);
  await mkdir(staging, { recursive: true });
  try {
    for (const { src, destName } of items) await copyFile(src, path.join(staging, destName));
    for (const { destName } of items) {
      const dest = path.join(dir, destName);
      try {
        if ((await lstat(dest)).isSymbolicLink()) throw new EvidenceInputError(`備份目的地是符號連結，已拒絕：${destName}`);
      } catch (err: any) {
        if (err.code !== "ENOENT") throw err;
      }
      await rename(path.join(staging, destName), dest);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export interface RecordEvidenceInput {
  taskGid: string;
  featureName: string;
  fileKind: TestEvidenceKind;
  testLevel: TestLevel;
  testSource?: string | null;
  sourceFile: string;
  usesFakeData: boolean;
  markedFile?: string | null;
  fakeDataMarked?: boolean | null;
  screenshotPaths?: string[] | null;
  note?: string | null;
}

export interface RecordEvidenceResult {
  record: TestEvidenceRecord;
  backupDir: string;
  /** 舊備份清理失敗的項目（登記本身已成功）；空陣列代表清理乾淨。 */
  cleanupWarnings: CleanupWarning[];
}

function nowText(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 驗證所有輸入（全部通過才開始複製）。回傳已驗證的絕對路徑。 */
async function validateInput(input: RecordEvidenceInput) {
  const { fileKind, usesFakeData } = input;
  const exts = KIND_EXTS[fileKind];
  const source = await validateFile(input.sourceFile, exts, "sourceFile");
  const office = isOfficeKind(fileKind);

  let marked: string | null = null;
  if (office && usesFakeData) {
    if (!input.markedFile) {
      throw new EvidenceInputError(
        `usesFakeData=true 時必須提供 markedFile（已標註「${FAKE_DATA_LABEL}」的副本）。規則：用假資料測試時，要在副本檔案本身標註（Excel 在空白儲存格加紅字粗體；PDF 每頁加斜向浮水印），原始檔另外原封不動保留。做法見 get_test_engineer_guide 第五章。`
      );
    }
    if (input.fakeDataMarked !== true) {
      throw new EvidenceInputError(
        `usesFakeData=true 時 fakeDataMarked 必須明確帶 true，代表你已確認 markedFile 內依規定標註了「${FAKE_DATA_LABEL}」。尚未標註就先標註再呼叫，不要直接帶 true。`
      );
    }
    marked = await validateFile(input.markedFile, exts, "markedFile");
  } else if (office && input.markedFile) {
    throw new EvidenceInputError("usesFakeData=false 卻帶了 markedFile，互相矛盾。沒用假資料就不需要標註副本；有用假資料請把 usesFakeData 設為 true。");
  }

  const shots = input.screenshotPaths ?? [];
  if (fileKind === "pdf" && shots.length === 0) {
    throw new EvidenceInputError(
      "fileKind=pdf 時 screenshotPaths 必填至少 1 張：用 PyMuPDF 把實際 PDF 逐頁轉 PNG（見 get_test_engineer_guide 第五章）。若本機裝不到 PyMuPDF，就比照 Excel 走人工截圖，不得用其他推算或重畫方式代替。"
    );
  }
  const screenshots: string[] = [];
  for (const [i, s] of shots.entries()) screenshots.push(await validateFile(s, SCREENSHOT_EXTS, `screenshotPaths[${i}]`));

  if (!office) await checkTextEvidence(source, fileKind, usesFakeData);
  return { source, marked, screenshots };
}

function insideEvidence(ticketDir: string, rel: string): boolean {
  const base = path.resolve(ticketDir, EVIDENCE_DIR) + path.sep;
  return path.resolve(ticketDir, rel).startsWith(base);
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 一筆紀錄（新舊格式皆可）目前指向的所有備份檔相對路徑。舊格式有 original（字串）與 marked。 */
function recordedRels(files: any): string[] {
  const list = [typeof files?.original === "string" ? files.original : null, files?.marked, files?.file, ...(files?.screenshots ?? [])];
  return list.filter((v): v is string => typeof v === "string" && v !== "");
}

/** 這筆證據在票單目錄內的唯一證據檔相對路徑（相容舊格式紀錄）。 */
export function evidenceFileOf(record: TestEvidenceRecord): string {
  const files: any = record.files;
  return files.file ?? files.marked ?? files.original;
}

/**
 * 備份一筆證據並在 status.json 新增或更新（同功能＋同原檔名＝同一筆，重複呼叫即更新）。
 * 每筆只存一個可直接觀察的檔案：假資料 excel/pdf 存標註副本（命名 `<原檔名>_假資料.<副檔名>`，sourceFile 不複製，只記路徑與 sha256）；
 * 其他類型存 sourceFile 本身（假資料加 `_假資料` 後綴）；假資料證據放進 `【假資料】<功能名稱>` 資料夾。
 * 舊格式備份（`_原始`、`_假資料標註`、舊資料夾名）在同一筆再次呼叫時被刪除並換成新命名。
 */
export async function recordTestEvidence(input: RecordEvidenceInput): Promise<RecordEvidenceResult> {
  const safeFeature = safeSegment(input.featureName, MAX_FEATURE_NAME_LEN, "featureName");
  const ticketDir = await resolveTicketDir(input.taskGid);
  const { source, marked, screenshots } = await validateInput(input);

  const fake = input.usesFakeData;
  const stem = safeSegment(path.parse(source).name, MAX_STEM_LEN, "原檔名");
  const evidenceSrc = isOfficeKind(input.fileKind) && fake ? marked! : source;
  const suffix = fake ? FAKE_NAME_SUFFIX : "";
  const fileName = `${stem}${suffix}${path.extname(evidenceSrc).toLowerCase()}`;
  const folderName = fake ? `${FAKE_DIR_PREFIX}${safeFeature}` : safeFeature;
  const relOf = (name: string) => `${EVIDENCE_DIR}/${folderName}/${name}`;
  const id = createHash("sha1").update(`${safeFeature}\n${stem}`).digest("hex").slice(0, 10);

  // 沒帶新截圖時沿用舊紀錄的截圖（可能在舊資料夾／舊命名，搬到新命名）。
  const before = (await readStatus(input.taskGid)).test_evidence.find((e) => e.id === id);
  let shotSources = screenshots;
  if (screenshots.length === 0 && before) {
    shotSources = [];
    for (const rel of before.files.screenshots ?? []) {
      if (!insideEvidence(ticketDir, rel)) continue;
      try {
        shotSources.push(await validateFile(path.resolve(ticketDir, rel), SCREENSHOT_EXTS, "既有截圖"));
      } catch (err) {
        if (!(err instanceof EvidenceInputError)) throw err;
      }
    }
  }
  const shotNames = shotSources.map((s, i) => `${stem}${suffix}_截圖_${i + 1}${path.extname(s).toLowerCase()}`);

  const dir = await ensureEvidenceDir(ticketDir, folderName);
  const items = [{ src: evidenceSrc, destName: fileName }, ...shotSources.map((src, i) => ({ src, destName: shotNames[i] }))];
  await placeFiles(dir, items);

  const next: TestEvidenceRecord = {
    id,
    featureName: input.featureName.trim(),
    fileKind: input.fileKind,
    testLevel: input.testLevel,
    testSource: input.testSource?.trim() || null,
    files: { file: relOf(fileName), screenshots: shotNames.map(relOf), original: { path: source, sha256: await sha256Of(source) } },
    usesFakeData: fake,
    // 文字類已由 checkTextEvidence 驗證過第一行。
    fakeDataMarked: isOfficeKind(input.fileKind) ? Boolean(marked) && input.fakeDataMarked === true : fake && FAKE_FIRST_LINE_KINDS.includes(input.fileKind),
    pendingManualScreenshot: input.fileKind === "excel" && shotNames.length === 0,
    recordedAt: nowText(),
    note: input.note?.trim() || null,
  };

  const prev: { value?: TestEvidenceRecord } = {};
  await updateStatus(input.taskGid, (status) => {
    prev.value = status.test_evidence.find((e) => e.id === id);
    const index = status.test_evidence.findIndex((e) => e.id === id);
    const list = index === -1 ? [...status.test_evidence, next] : [...status.test_evidence.slice(0, index), next, ...status.test_evidence.slice(index + 1)];
    // 補登截圖後，之前自動產生的「請截圖」待辦就沒有意義了，一併清掉。
    const manual = next.pendingManualScreenshot
      ? status.test_manual_actions
      : status.test_manual_actions.filter((a) => !(a.startsWith(PENDING_SCREENSHOT_ACTION_PREFIX) && a.endsWith(`：${next.featureName}`)));
    return { ...status, test_evidence: list, test_manual_actions: manual };
  });

  const cleanupWarnings = await cleanupStale(ticketDir, {
    stem,
    safeFeature,
    keep: new Set([next.files.file, ...next.files.screenshots]),
    oldRels: recordedRels((prev.value ?? before)?.files),
  });
  return { record: next, backupDir: dir, cleanupWarnings };
}

export interface CleanupWarning {
  path: string;
  reason: string;
}

type FileRemover = (absPath: string) => Promise<void>;
const defaultRemover: FileRemover = (abs) => rm(abs, { force: true });
let removeFile: FileRemover = defaultRemover;

/** 測試用：替換「刪檔」動作來模擬 EBUSY 等失敗；傳 null 還原。 */
export function setEvidenceRemoverForTest(fn: FileRemover | null): void {
  removeFile = fn ?? defaultRemover;
}

function describeRemoveError(err: any): string {
  if (["EBUSY", "EPERM", "EACCES"].includes(err?.code)) {
    return "檔案被其他程式（可能是 Excel）開啟，無法刪除，請關閉後再呼叫一次本工具即可完成清理";
  }
  return `無法刪除（${err?.code ?? err?.message ?? "未知錯誤"}），請確認檔案沒被占用後再呼叫一次本工具`;
}

/** 舊格式備份檔名（`<原檔名>_原始.*`、`<原檔名>_假資料標註.*`）與它們的 Office 鎖定檔（`~$` 開頭）。 */
const LEGACY_TAIL = String.raw`_(?:原始|假資料標註)\.[^.]+$`;
function legacyNamePattern(stem: string | null): RegExp {
  if (stem === null) return new RegExp(String.raw`^(?:~\$.{0,2})?.+${LEGACY_TAIL}`);
  // 鎖定檔名可能被 Office 截掉開頭幾個字，所以只有 `~$` 開頭的才容許截斷版本，避免誤刪別筆證據的舊檔。
  const lockVariants = [stem, stem.slice(1), stem.slice(2)].filter((v) => v !== "").map(escapeRegExp).join("|");
  return new RegExp(String.raw`^(?:${escapeRegExp(stem)}|~\$(?:${lockVariants}))${LEGACY_TAIL}`);
}

/**
 * 在新證據已就位、status 已更新「之後」才清理：刪除舊紀錄指向但新紀錄不再使用的備份檔，連同舊格式殘留檔
 * （含 Office 鎖定檔）；清空後的資料夾才移除。任何刪除失敗都只回傳警告，不影響已完成的登記，下次呼叫會重試（冪等）。
 */
async function cleanupStale(
  ticketDir: string,
  opts: { stem: string; safeFeature: string; keep: Set<string>; oldRels: string[] }
): Promise<CleanupWarning[]> {
  const warnings: CleanupWarning[] = [];
  const dirs = new Set<string>([opts.safeFeature, `${FAKE_DIR_PREFIX}${opts.safeFeature}`]);
  const doomed = new Set<string>();
  const tryRemove = async (rel: string) => {
    try {
      const abs = path.resolve(ticketDir, rel);
      const st = await lstat(abs).catch(() => null);
      if (st && !st.isDirectory()) await removeFile(abs);
    } catch (err: any) {
      warnings.push({ path: rel, reason: describeRemoveError(err) });
    }
  };
  try {
    for (const rel of opts.oldRels) {
      if (!opts.keep.has(rel) && insideEvidence(ticketDir, rel)) doomed.add(rel);
      dirs.add(path.posix.basename(path.posix.dirname(rel)));
    }
    const legacy = legacyNamePattern(opts.stem);
    for (const name of dirs) {
      let entries: string[] = [];
      try {
        entries = await readdir(path.join(ticketDir, EVIDENCE_DIR, name));
      } catch (err: any) {
        if (err.code !== "ENOENT") throw err;
      }
      for (const f of entries) if (legacy.test(f)) doomed.add(`${EVIDENCE_DIR}/${name}/${f}`);
    }
    for (const rel of [...doomed]) {
      // 舊檔若被 Excel 開著，旁邊會有 `~$<檔名>` 鎖定檔；不再被占用的鎖定檔一併清掉。
      const lock = `${path.posix.dirname(rel)}/~$${path.posix.basename(rel)}`;
      if (await lstat(path.resolve(ticketDir, lock)).catch(() => null)) doomed.add(lock);
    }
    for (const rel of doomed) if (!opts.keep.has(rel)) await tryRemove(rel);
    for (const name of dirs) {
      if (!name || name === "." || name === "..") continue;
      await rmdir(path.join(ticketDir, EVIDENCE_DIR, name)).catch(() => undefined); // 還有檔案（含刪不掉的舊檔）就留著
    }
  } catch (err: any) {
    warnings.push({ path: EVIDENCE_DIR, reason: `清理舊備份時發生錯誤（${err?.message ?? err}），請再呼叫一次本工具重試` });
  }
  return warnings;
}

/** 掃描這張票各筆證據所在資料夾，找出仍殘留的舊格式備份（含鎖定檔）；回傳相對路徑，最多 limit 筆。 */
export async function findStaleEvidenceBackups(status: TicketStatus, ticketDir: string, limit = 10): Promise<string[]> {
  const dirs = new Set<string>();
  for (const e of status.test_evidence) {
    const folder = path.posix.basename(path.posix.dirname(evidenceFileOf(e)));
    const plain = folder.startsWith(FAKE_DIR_PREFIX) ? folder.slice(FAKE_DIR_PREFIX.length) : folder;
    dirs.add(plain);
    dirs.add(`${FAKE_DIR_PREFIX}${plain}`);
  }
  const found: string[] = [];
  const legacy = legacyNamePattern(null);
  for (const name of dirs) {
    const entries = await readdir(path.join(ticketDir, EVIDENCE_DIR, name)).catch(() => [] as string[]);
    for (const f of entries) if (legacy.test(f) && found.length < limit) found.push(`${EVIDENCE_DIR}/${name}/${f}`);
  }
  return found;
}

/** 把票單目錄換成給人看的相對路徑（相對專案目錄，不在專案目錄底下就用絕對路徑）。 */
function ticketDirForDisplay(projectDir: string | null, ticketDir: string): string {
  if (projectDir) {
    const rel = path.relative(projectDir, ticketDir);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.replace(/\\/g, "/");
  }
  return ticketDir.replace(/\\/g, "/");
}

/** 每筆「待使用者截圖」證據對應一條固定格式待辦（證據檔就是要截圖的那個檔案）。 */
export function pendingScreenshotActions(status: TicketStatus, ticketDir: string): string[] {
  const base = ticketDirForDisplay(status.project_dir, ticketDir);
  return status.test_evidence
    .filter((e) => e.pendingManualScreenshot)
    .map(
      (e) =>
        `${PENDING_SCREENSHOT_ACTION_PREFIX}\`${base}/${evidenceFileOf(e)}\`，截圖後放進同一資料夾（或請 AI 用 record_test_evidence 補登）：${e.featureName}`
    );
}

/** 呼叫端給的 manualActions 先去掉舊的自動待辦（避免殘留已補登的），再接上目前仍待截圖的。 */
export function mergeEvidenceManualActions(callerActions: string[], status: TicketStatus, ticketDir: string): string[] {
  const own = callerActions.filter((a) => !a.startsWith(PENDING_SCREENSHOT_ACTION_PREFIX));
  return [...own, ...pendingScreenshotActions(status, ticketDir)];
}

export interface Artifact04Check {
  content: string;
  testLevel: TestLevel;
  producesOfficeFiles: boolean;
}

/** 寫 04-test.md 的測試證據關卡；回傳拒絕原因，通過回傳 null。 */
export function checkTestEvidenceForArtifact(status: TicketStatus, check: Artifact04Check): string | null {
  const evidence = status.test_evidence;
  if (evidence.length === 0) {
    return "這張票還沒有任何測試證據。請先呼叫 record_test_evidence 記錄至少 1 筆（API 呼叫原文、測試報告、DB 前後狀態、Excel/PDF 皆可），再寫 04-test.md。";
  }
  const highest = highestTestLevel(evidence)!;
  if (check.testLevel !== highest) {
    return `宣告的 testLevel「${check.testLevel}」與證據中最高層級「${highest}」不一致（unit-mock < integration-db < live-api）。請如實宣告為「${highest}」，或修正證據的 testLevel，避免灌水或低報。`;
  }
  if (check.producesOfficeFiles && !evidence.some((e) => isOfficeKind(e.fileKind))) {
    return "producesOfficeFiles=true 但證據裡沒有任何 excel／pdf 類型的紀錄。請先用 record_test_evidence（fileKind: excel 或 pdf）記錄實際產出的檔案；若其實沒有產出 Office 檔，請改帶 false。";
  }
  if (!/^#{1,6}[ \t]+.*測試證據/m.test(check.content)) {
    return "04-test.md 內文必須有一節標題含「測試證據」（例如 `## 測試證據`），以表格列出每筆證據：功能名稱｜資料來源（假資料／真實資料）｜測試層級｜檔案類型｜證據檔位置（單一檔案）｜截圖｜備註。格式見 get_test_engineer_guide 第五章。";
  }
  const missing = evidence.filter((e) => !check.content.includes(e.featureName)).map((e) => e.featureName);
  if (missing.length > 0) {
    return `04-test.md 內文沒有提及這些已記錄證據的功能名稱：${missing.map((m) => `「${m}」`).join("、")}。請把每筆證據都寫進「測試證據」一節。`;
  }
  if (evidence.some((e) => e.usesFakeData) && !check.content.includes("假資料")) {
    return "有證據使用假資料（usesFakeData=true），「測試證據」一節的「資料來源」欄必須明確寫出「假資料」（真實資料寫「真實資料」），避免被誤認為真實資料。";
  }
  if (!check.content.includes(check.testLevel)) {
    return `04-test.md 內文必須出現所宣告的測試層級字串「${check.testLevel}」（建議寫在「測試證據」一節）。`;
  }
  return null;
}

/** advance_ticket_stage 推進到 tested 的證據關卡；回傳拒絕原因，通過回傳 null。 */
export function checkTestEvidenceForTested(status: TicketStatus): string | null {
  if (status.test_evidence.length === 0) {
    return "這張票沒有任何測試證據（test_evidence 為空），不能推進到 tested。請先用 record_test_evidence 記錄證據，並在 write_ticket_artifact 寫 04-test.md 時帶 testLevel／producesOfficeFiles。";
  }
  if (!status.test_level) {
    return "尚未記錄 testLevel（寫 04-test.md 時要帶 testLevel：unit-mock｜integration-db｜live-api），不能推進到 tested。";
  }
  if (status.test_produces_office_files === true && !status.test_evidence.some((e) => isOfficeKind(e.fileKind))) {
    return "04-test.md 宣告有產出 Excel/PDF，但沒有任何 excel／pdf 證據，不能推進到 tested。請先用 record_test_evidence 記錄。";
  }
  return null;
}

/** get_ticket_status 用的精簡摘要：筆數、整體層級、每筆的重點欄位（上限 20 筆避免輸出爆量）。 */
export function summarizeTestEvidence(status: TicketStatus) {
  const MAX_ITEMS = 20;
  const items = status.test_evidence.slice(0, MAX_ITEMS).map((e) => ({
    featureName: e.featureName,
    fileKind: e.fileKind,
    testLevel: e.testLevel,
    usesFakeData: e.usesFakeData,
    pendingManualScreenshot: e.pendingManualScreenshot,
  }));
  const pending = status.test_evidence.filter((e) => e.pendingManualScreenshot).length;
  return {
    count: status.test_evidence.length,
    test_level: status.test_level,
    highest_evidence_level: highestTestLevel(status.test_evidence),
    pending_manual_screenshot: pending,
    items,
    ...(status.test_evidence.length > MAX_ITEMS ? { truncated: status.test_evidence.length - MAX_ITEMS } : {}),
  };
}

/** 寫 04-test.md 時把宣告的 producesOfficeFiles／testLevel 存進 status，供 advance_ticket_stage 把關。 */
export async function recordTestDeclaration(taskGid: string, producesOfficeFiles: boolean, testLevel: TestLevel): Promise<void> {
  await updateStatus(taskGid, (status) => ({ ...status, test_produces_office_files: producesOfficeFiles, test_level: testLevel }));
}
