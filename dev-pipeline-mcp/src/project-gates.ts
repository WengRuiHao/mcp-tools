import path from "node:path";
import { stat } from "node:fs/promises";
import { GATES_FILE_CANDIDATES, readFirstExisting, type FoundRuleFile } from "./project-rule-files.js";

const MAX_REPORTED_PATHS = 5;

/** A project opts in by shipping this config in its own repo; a project without it is never gated. */
export interface AnalysisReferenceGate {
  /** Regex source tested against the ticket name; only matching tickets are gated. */
  ticketNamePattern: string;
  /** Heading text the analysis must contain (any heading level), e.g. "舊碼參考". */
  heading: string;
  /** The analysis section must cite at least `minPaths` existing files/dirs under this prefix (relative to projectDir). */
  pathPrefix: string;
  minPaths?: number;
  /** When true, the ticket must have a real SA/SD spec recorded (record_sasd_check hasSasd:true). */
  requireSasd?: boolean;
}

/** 實作文件必須有一節（標題含 heading）且去空白後字數達標；heading 語意由專案自訂。 */
export interface ImplementationSectionGate {
  ticketNamePattern: string;
  heading: string;
  /** 預設 DEFAULT_MIN_SECTION_CHARS */
  minChars?: number;
}

interface GatesConfig {
  analysisReferences?: AnalysisReferenceGate[];
  implementationSections?: ImplementationSectionGate[];
}

export type GateResult = { ok: true } | { ok: false; message: string };

const DEFAULT_MIN_SECTION_CHARS = 40;

async function loadGates(
  projectDir: string,
  writeTarget = "分析文件"
): Promise<GatesConfig | { error: string } | null> {
  let found: FoundRuleFile | null;
  try {
    found = await readFirstExisting(projectDir, GATES_FILE_CANDIDATES);
  } catch (err: any) {
    return { error: `讀取 gates.json 失敗（${err?.code ?? err?.message}）` };
  }
  if (!found) return null;
  try {
    return JSON.parse(found.content) as GatesConfig;
  } catch {
    return { error: `${found.relPath} 不是合法的 JSON，請修正後再寫入${writeTarget}` };
  }
}

function normalize(text: string): string {
  return text.replace(/\\/g, "/");
}

/** Text of the section whose heading contains `heading`, up to the next heading of any level. */
function extractSection(content: string, heading: string): string | null {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s/.test(line) && line.includes(heading));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6}\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Every substring that starts at `prefix` and runs until whitespace/quote/bracket/CJK punctuation, minus trailing `:行號` and punctuation. */
function extractPathsUnderPrefix(sectionText: string, prefix: string): string[] {
  const text = normalize(sectionText);
  const lowerText = text.toLowerCase();
  const lowerPrefix = normalize(prefix).toLowerCase();
  const found = new Set<string>();
  let from = 0;
  while (true) {
    const idx = lowerText.indexOf(lowerPrefix, from);
    if (idx === -1) break;
    const tail = text.slice(idx);
    const token = tail.match(/^[^\s`'"|()（）,，、;；<>]+/)?.[0] ?? "";
    const cleaned = token.replace(/:\d+(-\d+)?$/, "").replace(/[.:。]+$/, "");
    if (cleaned.length >= lowerPrefix.length) found.add(cleaned);
    from = idx + lowerPrefix.length;
  }
  return [...found];
}

async function existsUnder(projectDir: string, relPath: string): Promise<boolean> {
  const root = path.resolve(projectDir);
  const target = path.resolve(root, relPath);
  if (target !== root && !target.startsWith(root + path.sep)) return false;
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function checkAnalysisGates(params: {
  projectDir: string;
  ticketName: string;
  analysisContent: string;
  hasSasd: boolean;
}): Promise<GateResult> {
  const { projectDir, ticketName, analysisContent, hasSasd } = params;
  const config = await loadGates(projectDir);
  if (config === null) return { ok: true };
  if ("error" in config) return { ok: false, message: config.error };

  for (const gate of config.analysisReferences ?? []) {
    if (!new RegExp(gate.ticketNamePattern).test(ticketName)) continue;

    if (gate.requireSasd && !hasSasd) {
      return {
        ok: false,
        message: `這個專案規定「${ticketName}」這類票一定要有對應的 SA/SD 規格，但 record_sasd_check 記錄的是找不到。請先在規格位置找到對應規格（或停下來問使用者），再重新呼叫 record_sasd_check。`,
      };
    }

    const section = extractSection(analysisContent, gate.heading);
    if (section === null) {
      return {
        ok: false,
        message: `這個專案規定這類票的分析文件必須包含一節「${gate.heading}」（markdown 標題），列出實際讀過的檔案路徑（${gate.pathPrefix} 底下）。請先讀完相關檔案、補上這一節再寫入。`,
      };
    }

    const cited = extractPathsUnderPrefix(section, gate.pathPrefix);
    const existing: string[] = [];
    const missing: string[] = [];
    for (const rel of cited) ((await existsUnder(projectDir, rel)) ? existing : missing).push(rel);

    const minPaths = gate.minPaths ?? 1;
    if (existing.length < minPaths) {
      const missingNote = missing.length
        ? `；以下路徑不存在或寫錯：${missing.slice(0, MAX_REPORTED_PATHS).join("、")}`
        : "";
      return {
        ok: false,
        message: `「${gate.heading}」這一節必須列出至少 ${minPaths} 個實際存在、位於 ${gate.pathPrefix} 底下的檔案路徑，目前只有 ${existing.length} 個有效${missingNote}。請先實際讀取舊系統檔案再補上路徑。`,
      };
    }
  }
  return { ok: true };
}

export async function checkImplementationGates(params: {
  projectDir: string;
  ticketName: string;
  implementationContent: string;
}): Promise<GateResult> {
  const { projectDir, ticketName, implementationContent } = params;
  const config = await loadGates(projectDir, "實作文件");
  if (config === null) return { ok: true };
  if ("error" in config) return { ok: false, message: config.error };

  for (const gate of config.implementationSections ?? []) {
    if (!new RegExp(gate.ticketNamePattern).test(ticketName)) continue;

    const minChars = gate.minChars ?? DEFAULT_MIN_SECTION_CHARS;
    const hint = "請依該專案對這一節的要求，寫清楚做了什麼檢查、找到什麼、最後的決定與理由";
    const section = extractSection(implementationContent, gate.heading);
    if (section === null) {
      return {
        ok: false,
        message: `這個專案規定這類票的實作文件必須包含一節「${gate.heading}」（markdown 標題），內容至少 ${minChars} 字。${hint}，補上這一節再寫入。`,
      };
    }
    const length = section.replace(/\s/g, "").length;
    if (length < minChars) {
      return {
        ok: false,
        message: `實作文件的「${gate.heading}」這一節太短（目前 ${length} 字，至少要 ${minChars} 字）。${hint}，補完再寫入。`,
      };
    }
  }
  return { ok: true };
}
