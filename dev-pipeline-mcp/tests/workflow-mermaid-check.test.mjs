// S8 B1：flow.mmd 基本格式檢查。
import test from "node:test";
import assert from "node:assert/strict";
import { checkMermaidText, MERMAID_MAX_BYTES } from "../dist/workflow/mermaid-check.js";

test("合法：flowchart／graph／sequenceDiagram／stateDiagram-v2，前面可有註解、空白行與 frontmatter", () => {
  for (const t of ["flowchart TD\nA[開始]-->B(結束)", "graph LR\nA-->B", "sequenceDiagram\nA->>B: hi", "stateDiagram-v2\n[*] --> S1", "erDiagram\nA ||--o{ B : has", "pie\n\"a\": 1"]) {
    assert.deepEqual(checkMermaidText(t), [], t);
  }
  assert.deepEqual(checkMermaidText("\n\n%% 註解\n%%{init: {}}%%\n  flowchart TD\nA-->B"), []);
  assert.deepEqual(checkMermaidText("---\ntitle: x\n---\nflowchart TD\nA-->B"), []);
});

test("空檔、只有註解、沒有圖類型宣告", () => {
  assert.match(checkMermaidText("  \n")[0], /空的/);
  assert.match(checkMermaidText("%% 只有註解\n")[0], /只有註解/);
  assert.match(checkMermaidText("A-->B\n")[0], /已知的 Mermaid 圖類型/);
  assert.match(checkMermaidText("flowchartTD\nA-->B")[0], /圖類型/);
});

test("不得含 script、javascript:、iframe", () => {
  assert.ok(checkMermaidText("flowchart TD\nA[<script>x</script>]-->B").some((v) => v.includes("<script")));
  assert.ok(checkMermaidText("flowchart TD\nA-->B\nclick A \"javascript:alert(1)\"").some((v) => v.includes("javascript:")));
  assert.ok(checkMermaidText("flowchart TD\nA[<iframe src=x>]-->B").some((v) => v.includes("iframe")));
  assert.deepEqual(checkMermaidText("flowchart TD\nA[第一行<br/>第二行]-->B"), []);
});

test("括號必須成對（引號內與註解行不計）", () => {
  assert.ok(checkMermaidText("flowchart TD\nA[開始-->B").some((v) => v.includes("[]")));
  assert.ok(checkMermaidText("flowchart TD\nA(開始]-->B").length > 0);
  assert.ok(checkMermaidText("flowchart TD\nA{判斷-->B").some((v) => v.includes("{}")));
  assert.deepEqual(checkMermaidText("flowchart TD\nA[\"含(未成對\"]-->B\n%% ((("), []);
});

test("超過大小上限", () => {
  const big = `flowchart TD\n${"A-->B\n".repeat(Math.ceil(MERMAID_MAX_BYTES / 6) + 10)}`;
  assert.ok(checkMermaidText(big).some((v) => v.includes("大小上限")));
});
