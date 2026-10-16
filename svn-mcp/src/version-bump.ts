/**
 * 檔名裡的版本號：`SPEC_MF04_營業人銷售額與稅額申報書_v0.7.docx` → 下一版是 `…_v0.8.docx`。
 *
 * 規則（照公司規格書的命名習慣）：
 * - 版本號是檔名（副檔名前）裡「最後一個」`v數字.數字…`（大小寫 V 都行，前面不能緊接英數字，避免誤抓 `rev1.2`）；
 *   `SPEC_JOB02_xxx.v0.3.docx` 這種版本號前面是點的也算。
 * - 兩段的版本（v0.7）：後面那段 +1；後面那段是 9 就進位成下一個主版本（v0.9 → v1.0）。
 *   三段以上（v1.2.3）：只把最後一段 +1，不進位。
 * - 找不到版本號：升級時把原檔當成第一版，新檔名自動加上 `_v0.2`（見 suggestUpgradeName）；nextVersionName 本身仍回傳 null。
 * 純函式、不碰檔案。
 */
export interface ParsedVersion {
  /** 版本號前面的文字（含底線或點），例如 `SPEC_MF04_營業人銷售額與稅額申報書_`。 */
  before: string;
  /** `v` 或 `V`（升級後維持原樣）。 */
  marker: string;
  /** 版本號各段，例如 [0, 7]。 */
  parts: number[];
  /** 版本號後面、副檔名前面的文字（多半是空字串）。 */
  after: string;
  /** 副檔名（含點），沒有副檔名是空字串。 */
  ext: string;
}

const EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/** 拆出檔名裡的版本號；沒有就回傳 null。 */
export function parseVersion(fileName: string): ParsedVersion | null {
  const extMatch = EXT_RE.exec(fileName);
  const ext = extMatch ? extMatch[0] : "";
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  const re = /([vV])(\d+(?:\.\d+)+)/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(base); m; m = re.exec(base)) {
    const prev = m.index > 0 ? base[m.index - 1] : "";
    if (prev === "" || !/[A-Za-z0-9]/.test(prev)) last = m;
  }
  if (!last) return null;
  return {
    before: base.slice(0, last.index),
    marker: last[1],
    parts: last[2].split(".").map((n) => Number(n)),
    after: base.slice(last.index + last[0].length),
    ext,
  };
}

/** 版本號各段 +1（規則見檔頭）。 */
export function bumpParts(parts: readonly number[]): number[] {
  const next = [...parts];
  const last = next.length - 1;
  if (next.length === 2 && next[last] === 9) return [next[0] + 1, 0];
  next[last] += 1;
  return next;
}

export function formatVersion(parsed: ParsedVersion, parts: readonly number[]): string {
  return `${parsed.before}${parsed.marker}${parts.join(".")}${parsed.after}${parsed.ext}`;
}

/** 下一版的檔名；檔名裡沒有版本號回傳 null。 */
export function nextVersionName(fileName: string): string | null {
  const parsed = parseVersion(fileName);
  return parsed ? formatVersion(parsed, bumpParts(parsed.parts)) : null;
}

/** 檔名裡顯示用的版本號（例如 `v0.7`）；沒有回傳 null。 */
export function versionLabel(fileName: string): string | null {
  const parsed = parseVersion(fileName);
  return parsed ? `${parsed.marker}${parsed.parts.join(".")}` : null;
}

/** 檔名沒有版本號時：原檔當第一版，放進 old 時自動補上的版次。 */
export const IMPLICIT_FIRST_VERSION = "v0.1";
/** 檔名沒有版本號時，升級後的新檔名自動加上的版次。 */
export const IMPLICIT_FIRST_UPGRADE_VERSION = "v0.2";

export interface UpgradeNameSuggestion {
  /** 建議的新版檔名。 */
  name: string;
  /** 原檔名沒有版本號，所以是自動加上 `_v0.2` 的。 */
  implicit: boolean;
}

/**
 * 舊版放進 old 資料夾時的檔名：
 * - 檔名裡有版本號：原檔名不變（v0.7 就是 v0.7）；
 * - 沒有版本號（有人忘了寫）：在檔名後面（副檔名前）補上 `_v0.1`，這樣 old 裡每個檔案都看得出是哪一版。
 */
export function archiveFileName(fileName: string): { name: string; implicit: boolean } {
  if (parseVersion(fileName)) return { name: fileName, implicit: false };
  const extMatch = EXT_RE.exec(fileName);
  const ext = extMatch ? extMatch[0] : "";
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  return { name: `${base}_${IMPLICIT_FIRST_VERSION}${ext}`, implicit: true };
}

/**
 * 升級版本時的新檔名：
 * - 檔名裡有版本號：版本號 +1（v0.7 → v0.8）；
 * - 沒有版本號（有些規格沒寫版次）：把原檔當成第一版，在檔名後面（副檔名前）自動加上 `_v0.2`。
 */
export function suggestUpgradeName(fileName: string): UpgradeNameSuggestion {
  const bumped = nextVersionName(fileName);
  if (bumped) return { name: bumped, implicit: false };
  const extMatch = EXT_RE.exec(fileName);
  const ext = extMatch ? extMatch[0] : "";
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  return { name: `${base}_${IMPLICIT_FIRST_UPGRADE_VERSION}${ext}`, implicit: true };
}
