/**
 * 憑證/連線字串偵測的共用 pattern。manualActions 檢查（pipeline-store.detectSensitiveManualActions）與
 * 測試證據文字檔掃描（test-evidence-store）共用同一份基礎 pattern，不各自複製一份。
 */

/** 基礎憑證/連線字串 pattern（原本內嵌在 detectSensitiveManualActions）。 */
export const CREDENTIAL_PATTERN =
  /(jdbc:|mongodb:\/\/|postgres(?:ql)?:\/\/|mysql:\/\/|password\s*=\s*\S+|pwd\s*=\s*\S+|api[_-]?key\s*[=:]\s*\S+|secret\s*[=:]\s*\S+|Server\s*=[^;]*;\s*.*Password\s*=)/i;

/** 已遮蔽的值（****、<redacted> 等），視為安全。 */
const MASKED = String.raw`(?:\*{2,}|<redacted>|\[redacted\]|\[masked\]|REDACTED)`;

/** 「key: ****」「key=****」整段先移除，避免被基礎 pattern 的 \S+ 誤判成未遮蔽。 */
const MASKED_PAIR = new RegExp(String.raw`[\w-]+["']?\s*[=:]\s*["']?${MASKED}["']?`, "gi");

const EVIDENCE_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "疑似未遮蔽的 Authorization 標頭", re: new RegExp(String.raw`Authorization["']?\s*[=:]\s*["']?(?:Bearer|Basic|Token)\s+(?!${MASKED})\S{6,}`, "i") },
  { label: "疑似未遮蔽的 Authorization 標頭", re: new RegExp(String.raw`Authorization["']?\s*[=:]\s*["']?(?!(?:Bearer|Basic|Token)\b|${MASKED})[^\s"']{6,}`, "i") },
  { label: "疑似未遮蔽的 Bearer token", re: new RegExp(String.raw`\bBearer\s+(?!${MASKED})[A-Za-z0-9._~+/=-]{16,}`, "i") },
  { label: "疑似 JWT", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/ },
  {
    label: "疑似未遮蔽的 password/secret/api key/token 值",
    re: new RegExp(
      String.raw`\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token)["']?\s*[=:]\s*["']?(?!${MASKED}|null\b|true\b|false\b)[^\s"',;&}]+`,
      "i"
    ),
  },
  { label: "疑似連線字串內含帳密", re: new RegExp(String.raw`\b[a-z][a-z0-9+.-]*://[^\s:@/]+:(?!${MASKED})[^\s@/]+@`, "i") },
];

/** 回傳這一行命中的原因標籤（不含任何內容本身）；沒命中回傳空陣列。 */
export function scanLineForSecrets(line: string): string[] {
  const cleaned = line.replace(MASKED_PAIR, "");
  const reasons = new Set<string>();
  if (CREDENTIAL_PATTERN.test(cleaned)) reasons.add("疑似憑證/連線字串");
  for (const { label, re } of EVIDENCE_PATTERNS) {
    if (re.test(cleaned)) reasons.add(label);
  }
  return [...reasons];
}

export interface SecretHit {
  line: number;
  reasons: string[];
}

/** 掃整份文字，回傳命中的行號與原因標籤（最多 maxHits 筆）。刻意不回傳命中的內容。 */
export function scanTextForSecrets(text: string, maxHits = 10): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
    const reasons = scanLineForSecrets(lines[i]);
    if (reasons.length > 0) hits.push({ line: i + 1, reasons });
  }
  return hits;
}
