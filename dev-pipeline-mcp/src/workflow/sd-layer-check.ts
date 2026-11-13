// 步驟 F：後端實作要照 SD 宣告的三層（Controller／Service／Repository）落地。後端工程師交件時檢查：
// 1. impl-be.md 的「## API 落地清單」逐支 API 列出實際落地的三層檔案與方法，且與 SD 宣告一致（檔案層級＋方法名稱比對）；
// 2. 有專案目錄時，另檢查 SD 宣告的檔案真的存在於專案目錄、且檔案內有宣告的方法名稱。
//    取不到專案目錄時只做第 1 項（impl 說明與 SD 比對），無法證明檔案真的存在，由驗證師對照程式碼把關。
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseTable } from "./md-table.js";
import { extractSection } from "./reuse-record-check.js";
import { LAYER_NAMES, parseSdApis, type LayerDecl, type SdApi } from "./sd-api-parse.js";

export const IMPL_LAYER_HEADING = "API 落地清單";
export const IMPL_LAYER_HEADER: readonly string[] = ["API", ...LAYER_NAMES];

const clean = (c: string): string => c.replace(/[`*]/g, "").trim();
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const hasWord = (text: string, word: string): boolean => new RegExp(`(?<![\\w$])${escapeRe(word)}(?![\\w$])`).test(text);

/** SD 宣告得出的三層（格式不對的層由 sd-structure-check 回報，這裡略過）。 */
function declaredLayers(api: SdApi): { layer: string; decl: LayerDecl }[] {
  return LAYER_NAMES.flatMap((layer) => {
    const d = api.layers[layer];
    return d && d !== "invalid" ? [{ layer, decl: d }] : [];
  });
}

export function insideProject(projectDir: string, file: string): string | null {
  const base = path.resolve(projectDir);
  const full = path.resolve(base, file);
  const rel = path.relative(base, full);
  return path.isAbsolute(file) || /^[A-Za-z]:/.test(file) || rel.startsWith("..") || path.isAbsolute(rel) ? null : full;
}

/** SD 宣告的檔案要存在於專案目錄，且包含宣告的方法名稱。 */
export function checkSdLayersInProject(sdText: string, projectDir: string, sdFile = "03-sd.md"): string[] {
  const out: string[] = [];
  for (const api of parseSdApis(sdText) ?? []) {
    for (const { layer, decl } of declaredLayers(api)) {
      const w = `${sdFile} API「${api.title}」的 ${layer}（${decl.file}）`;
      const full = insideProject(projectDir, decl.file);
      if (full === null) out.push(`${w}路徑超出專案目錄，只能寫相對於專案目錄的路徑`);
      else if (!existsSync(full) || !statSync(full).isFile()) out.push(`${w}檔案不存在於專案目錄：實作要落在 SD 宣告的檔案，或先改 SD 再實作`);
      else {
        const text = readFileSync(full, "utf-8");
        const missing = decl.methods.filter((m) => !hasWord(text, m));
        if (missing.length > 0) out.push(`${w}找不到宣告的方法：${missing.join("、")}`);
      }
    }
  }
  return out;
}

function findRow(rows: string[][], api: SdApi): string[] | undefined {
  const url = api.url ? new RegExp(`(?:^|\\s)${escapeRe(api.url)}(?=\\s|$)`) : null;
  return rows.find((r) => (url ? url.test(clean(r[0] ?? "")) : false) || clean(r[0] ?? "") === clean(api.title));
}

/** impl-be.md 的 API 落地清單要涵蓋 SD 每支 API，三層的檔案與方法與 SD 宣告一致。 */
export function checkImplLayerList(implText: string, sdText: string, implFile = "impl-be.md"): string[] {
  const apis = parseSdApis(sdText) ?? [];
  if (apis.length === 0) return [];
  const body = extractSection(implText, IMPL_LAYER_HEADING);
  if (body === null) return [`${implFile} 缺少「## ${IMPL_LAYER_HEADING}」一節：每支 API 列出實際落地的三層檔案與方法，表頭「${IMPL_LAYER_HEADER.join("｜")}」`];
  const table = parseTable(body);
  if (table === null || table.header.map(clean).join("|") !== IMPL_LAYER_HEADER.join("|")) return [`${implFile}「${IMPL_LAYER_HEADING}」必須是表格，表頭固定為：${IMPL_LAYER_HEADER.join("｜")}`];
  const out: string[] = [];
  for (const api of apis) {
    const row = findRow(table.rows, api);
    if (!row) {
      out.push(`${implFile}「${IMPL_LAYER_HEADING}」沒有列出 API「${api.title}」（API 欄寫 ${api.method ?? ""} ${api.url ?? ""}）`);
      continue;
    }
    LAYER_NAMES.forEach((layer, i) => {
      const d = api.layers[layer];
      if (!d || d === "invalid") return;
      const cell = clean(row[i + 1] ?? "");
      const wrongFile = !new RegExp(`(?<![\\w./-])${escapeRe(d.file)}(?![\\w./-])`).test(cell);
      const missing = d.methods.filter((m) => !hasWord(cell, m));
      if (wrongFile) out.push(`${implFile} API「${api.title}」的 ${layer} 落地檔案與 SD 不同：SD 宣告 ${d.file}（實作要照 SD 的檔案，或先改 SD 再實作）`);
      else if (missing.length > 0) out.push(`${implFile} API「${api.title}」的 ${layer} 沒有列出 SD 宣告的方法：${missing.join("、")}`);
    });
  }
  return out;
}

/** 後端工程師交件：實作說明與 SD 比對，有專案目錄再檢查實際檔案。 */
export function checkSdLayers(sdText: string, implText: string, projectDir: string | null): string[] {
  const problems = checkImplLayerList(implText, sdText);
  return projectDir ? [...problems, ...checkSdLayersInProject(sdText, projectDir)] : problems;
}
