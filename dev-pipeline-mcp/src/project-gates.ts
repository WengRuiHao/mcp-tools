import path from "node:path";
import { readFile, stat } from "node:fs/promises";

const GATES_FILE = ".claude/pipeline-roles/gates.json";
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

interface GatesConfig {
  analysisReferences?: AnalysisReferenceGate[];
}

export type GateResult = { ok: true } | { ok: false; message: string };

async function loadGates(projectDir: string): Promise<GatesConfig | { error: string } | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(projectDir, GATES_FILE), "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    return { error: `讀取 ${GATES_FILE} 失敗（${err?.code ?? err?.message}）` };
  }
  try {
    return JSON.parse(raw) as GatesConfig;
  } catch {
    return { error: `${GATES_FILE} 不是合法的 JSON，請修正後再寫入分析文件` };
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
