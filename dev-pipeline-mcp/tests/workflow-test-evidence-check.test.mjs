// S8 B2：test.md 測試證據檢查（重用 sa-image-check 的路徑規則）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkTestEvidence, checkTestEvidenceText } from "../dist/workflow/test-evidence-check.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "te-check-"));
after(() => rm(dir, { recursive: true, force: true }));
await mkdir(path.join(dir, "evidence"), { recursive: true });
await writeFile(path.join(dir, "evidence", "a.png"), Buffer.from("89504e47", "hex"));
await writeFile(path.join(dir, "evidence", "empty.png"), "");
await writeFile(path.join(dir, "evidence", "n.txt"), "x");

const doc = (...items) => `## 白箱\n白箱結果\n## 黑箱\n黑箱結果\n${items.join("\n")}\n`;
const run = (text) => checkTestEvidenceText(text, dir);

test("合法：白箱在黑箱前，每個測試項目引用存在的圖", () => {
  const r = run(doc("## 測試：登入\n![畫面](evidence/a.png)", "### 測試：登出\n![畫面](evidence/a.png)"));
  assert.deepEqual(r.violations, []);
  assert.equal(r.testCount, 2);
});

test("缺白箱／黑箱、順序顛倒、沒有測試項目", () => {
  assert.ok(run("## 黑箱\n## 測試：x\n![a](evidence/a.png)").violations.some((v) => v.includes("## 白箱")));
  assert.ok(run("## 白箱\n## 測試：x\n![a](evidence/a.png)").violations.some((v) => v.includes("## 黑箱")));
  assert.ok(run("## 黑箱\n## 白箱\n## 測試：x\n![a](evidence/a.png)").violations.some((v) => v.includes("之前")));
  assert.ok(run("## 白箱\n## 黑箱\n").violations.some((v) => v.includes("找不到任何測試項目")));
});

test("測試項目缺圖、圖不存在、空檔、副檔名不合、穿越、絕對路徑、外部網址", () => {
  const bad = ["evidence/none.png", "evidence/empty.png", "evidence/n.txt", "evidence/../x.png", "/etc/a.png", "http://x/a.png", "sa-images/a.png"];
  for (const ref of bad) {
    const r = run(doc(`## 測試：x\n![a](${ref})`));
    assert.equal(r.ok, false, ref);
  }
  assert.ok(run(doc("## 測試：x\n沒有圖")).violations.some((v) => v.includes("缺證據圖")));
});

test("程式碼區塊內的標題與圖不算", () => {
  const r = run(doc("```\n## 測試：假的\n```\n## 測試：真的\n![a](evidence/a.png)"));
  assert.equal(r.testCount, 1);
  assert.equal(r.ok, true);
});

test("checkTestEvidence 讀 test.md；檔案不存在丟錯", async () => {
  assert.throws(() => checkTestEvidence(dir), /找不到 test\.md/);
  await writeFile(path.join(dir, "test.md"), doc("## 測試：登入\n![畫面](evidence/a.png)"));
  assert.equal(checkTestEvidence(dir).ok, true);
});
