// 問題 63：工程師交件時，比對 impl-fe.md／impl-be.md「## 改動檔案」與 03-sd.md 引用的檔案路徑。
// 只回警告（不擋交件）：工程師改了 SD 沒提到的程式檔，或 SD 宣告的位置檔案沒被實作改到。impl 沒有可解析的改動檔案清單時整項跳過。
import { parseDupInput } from "./dup-input.js";
import { isSeparator, splitRow } from "./md-table.js";
import { LAYER_NAMES, parseSdApis } from "./sd-api-parse.js";

export type EngineerKind = "frontend" | "backend";

const FRONT_POSITION_HEADER = "前端位置";
const CODE_EXT_RE = /\.(js|jsx|ts|tsx|vue|java|kt|py|cs|go|php|rb|html|css|scss|sql|xml)$/i;
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|specs)(\/|$)|\.(test|spec)\./i;
const PATH_TOKEN_RE = /[\w\-.]+(?:\/[\w\-.]+)+\.[A-Za-z][A-Za-z0-9]{0,7}|[\w\-]+\.[A-Za-z][A-Za-z0-9]{0,7}/g;

const norm = (p: string): string => p.split("\\").join("/").replace(/^\.\//, "").trim();
const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** SD「前端功能與 API 對應表」的「前端位置」欄裡出現的檔案路徑。 */
function frontendDeclared(sd: string): string[] {
  const lines = sd.split(/\r\n|\r|\n/);
  const found = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const header = splitRow(lines[i]).map((c) => c.replace(/\s/g, ""));
    const col = header.indexOf(FRONT_POSITION_HEADER);
    if (col < 0) continue;
    for (let j = i + 1; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      const cells = splitRow(lines[j]);
      if (isSeparator(cells)) continue;
      for (const m of (cells[col] ?? "").replace(/[`*]/g, "").matchAll(PATH_TOKEN_RE)) found.add(norm(m[0]));
    }
  }
  return [...found];
}

/** SD 後端 API 宣告的三層檔案路徑。 */
function backendDeclared(sd: string): string[] {
  const out = new Set<string>();
  for (const api of parseSdApis(sd) ?? []) {
    for (const layer of LAYER_NAMES) {
      const d = api.layers[layer];
      if (d && d !== "invalid") out.add(norm(d.file));
    }
  }
  return [...out];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^$|()[\]{}\\]/g, "\\$&");
const samePath = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/** 回傳警告清單（空陣列＝沒有差異或無法比對）。 */
export function compareSdWithImpl(sdText: string, implText: string, kind: EngineerKind, sdFile = "03-sd.md", implFile = kind === "frontend" ? "impl-fe.md" : "impl-be.md"): string[] {
  const changed = parseDupInput(implText).changedFiles.map(norm);
  if (changed.length === 0) return [];
  const sdNorm = norm(sdText).split("\\").join("/");
  const declared = kind === "frontend" ? frontendDeclared(sdText) : backendDeclared(sdText);
  const mentioned = (f: string): boolean => sdNorm.includes(f) || new RegExp(`(?<![\\w./-])${escapeRe(baseName(f))}(?![\\w-])`).test(sdNorm);
  const unlisted = changed.filter((f) => CODE_EXT_RE.test(f) && !TEST_PATH_RE.test(f) && !mentioned(f));
  const untouched = declared.filter((d) => !changed.some((c) => samePath(c, d)));
  const warnings: string[] = [];
  const hint = `請更新 ${sdFile} 的位置欄，或在 ${implFile} 說明偏離 SD 的原因`;
  if (unlisted.length > 0) warnings.push(`${implFile} 的改動檔案有 SD 沒提到的程式檔：${unlisted.join("、")}（${sdFile} 未引用這些位置）。${hint}`);
  if (untouched.length > 0) warnings.push(`${sdFile} 宣告的${kind === "frontend" ? "前端位置" : "後端三層"}檔案沒有出現在 ${implFile} 的改動檔案：${untouched.join("、")}。${hint}`);
  return warnings;
}
