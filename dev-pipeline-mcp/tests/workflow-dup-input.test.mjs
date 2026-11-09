// S12a：實作說明的「## 改動檔案」與「## 重複豁免」解析。
import test from "node:test";
import assert from "node:assert/strict";
import { parseDupInput } from "../dist/workflow/dup-input.js";
import { checkSdReuseDesign } from "../dist/workflow/reuse-record-check.js";
import { parseProjectFlowOverride } from "../dist/workflow/schema.js";

test("改動檔案：條列、純文字、反引號、編號、反斜線與 ./ 都能解析並去重", () => {
  const t = "# impl\n## 改動檔案\n- src/a.js\n* `src/b.js`\n3. .\\src\\c.js\nsrc/a.js\n\n## 其他\n- x.js\n";
  assert.deepEqual(parseDupInput(t).changedFiles, ["src/a.js", "src/b.js", "src/c.js"]);
});

test("缺節或空內容不拋例外，回空陣列", () => {
  assert.deepEqual(parseDupInput("沒有任何章節"), { changedFiles: [], waivers: [] });
  assert.deepEqual(parseDupInput("## 改動檔案\n\n## 重複豁免\n無\n"), { changedFiles: [], waivers: [] });
  assert.deepEqual(parseDupInput(""), { changedFiles: [], waivers: [] });
});

test("重複豁免：三欄表格、相似檔案可空、理由含直線、欄位不足", () => {
  const t = "## 重複豁免\n| 檔案 | 相似檔案 | 理由 |\n| --- | --- | --- |\n| `a.js` | b.js | 兩邊刻意獨立演進 |\n| c.js | | 樣板碼 |\n| d.js | e.js | 理由 | 含直線 |\n| f.js |\n";
  const w = parseDupInput(t).waivers;
  assert.equal(w.length, 4);
  assert.deepEqual(w[0], { file: "a.js", otherFile: "b.js", reason: "兩邊刻意獨立演進" });
  assert.deepEqual(w[1], { file: "c.js", reason: "樣板碼" });
  assert.equal(w[2].reason, "理由|含直線");
  assert.equal(w[3].reason, "");
});

test("C3 擴充：只有無、N/A、none 不通過，有實質內容通過", () => {
  for (const v of ["無", "- 無", "N/A", "n/a。", "None", "沒有"]) {
    assert.match(checkSdReuseDesign(`## 重用與共用設計\n${v}\n`)[0], /不能只寫「無」/, v);
  }
  assert.deepEqual(checkSdReuseDesign("## 重用與共用設計\n無共用項目，已檢查 util 目錄\n"), []);
});

test("schema dup：合法值通過，既有範例仍合法；非法值被拒", () => {
  assert.equal(parseProjectFlowOverride({ schemaVersion: 1 }).ok, true);
  assert.equal(parseProjectFlowOverride({ schemaVersion: 1, dup: {} }).ok, true);
  assert.equal(parseProjectFlowOverride({ schemaVersion: 1, dup: { minRun: 4, testMinRun: 20, minChars: 50, extraExcludes: ["gen", "*.pb.js"] } }).ok, true);
  for (const dup of [{ minRun: 3 }, { minRun: 101 }, { minRun: 8.5 }, { testMinRun: 3 }, { minChars: 5 }, { minChars: 9999 }, { extraExcludes: [""] }, { extraExcludes: "gen" }, { maxFiles: 10 }, { minRun: "8" }]) {
    assert.equal(parseProjectFlowOverride({ schemaVersion: 1, dup }).ok, false, JSON.stringify(dup));
  }
  assert.equal(parseProjectFlowOverride({ schemaVersion: 1, dup: null }).ok, false);
});
