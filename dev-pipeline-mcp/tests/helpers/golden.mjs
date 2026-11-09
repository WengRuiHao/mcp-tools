// 黃金快照比對：預設逐項比對，不符就失敗並指出第一個差異的組合名稱；UPDATE_GOLDEN=1 才重寫快照檔。
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "golden");

/** 以 key 排序，確保輸出與屬性建立順序無關。 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  }
  return value;
}

export function serializeGolden(data) {
  return `${JSON.stringify(stable(data), null, 1)}\n`;
}

/** actual 為 { 組合名稱: 值 }；與快照檔逐項比對。 */
export function checkGolden(fileName, actual) {
  const file = path.join(GOLDEN_DIR, fileName);
  if (process.env.UPDATE_GOLDEN === "1") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeGolden(actual), "utf-8");
    return;
  }
  assert.ok(fs.existsSync(file), `缺少快照檔 ${fileName}（以 UPDATE_GOLDEN=1 產生）`);
  const expected = JSON.parse(fs.readFileSync(file, "utf-8"));
  const expectedKeys = Object.keys(expected);
  const missing = expectedKeys.find((k) => !(k in actual));
  assert.equal(missing, undefined, `快照中的組合不見了：${missing}`);
  const extra = Object.keys(actual).find((k) => !(k in expected));
  assert.equal(extra, undefined, `出現快照中沒有的新組合：${extra}`);
  for (const key of expectedKeys) {
    const a = JSON.stringify(stable(actual[key]));
    const e = JSON.stringify(stable(expected[key]));
    if (a !== e) assert.fail(`與黃金快照不符，第一個差異的組合：${key}\n  快照：${e.slice(0, 400)}\n  目前：${a.slice(0, 400)}`);
  }
}
