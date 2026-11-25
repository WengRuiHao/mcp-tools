// 批次 1M：專案層文件段落式寫入——以「## 標題」為單位的切段、取代、新增與段落雜湊。
import test from "node:test";
import assert from "node:assert/strict";
import { parseSections, getSection, sectionSha256, replaceSection, singleSectionKey } from "../dist/doc-sections.js";

const DOC = "# 模組地圖\n前言\n\n## 模組：會員\n- 負責人：小王\n\n## 模組：訂單\n- 負責人：小李\n### 對外介面\n- 查訂單\n\n## 名詞表\n- 訂單：order\n";

test("切段：前言不算段落；### 與程式碼區塊內的 ## 不切；key 是 ## 後的標題", () => {
  assert.deepEqual(parseSections(DOC).map((s) => s.key), ["模組：會員", "模組：訂單", "名詞表"]);
  const fenced = "## A\n```\n## 不是標題\n```\n## B\n";
  assert.deepEqual(parseSections(fenced).map((s) => s.key), ["A", "B"]);
  assert.deepEqual(parseSections("沒有標題\n"), []);
});

test("取段：含標題到下一個 ## 之前，收尾空白不算；不存在回 undefined", () => {
  assert.equal(getSection(DOC, "模組：訂單"), "## 模組：訂單\n- 負責人：小李\n### 對外介面\n- 查訂單");
  assert.equal(getSection(DOC, "不存在"), undefined);
});

test("段落雜湊：只受該段內容影響，不受其他段落影響", () => {
  const a = sectionSha256(getSection(DOC, "模組：會員"));
  const other = DOC.replace("小李", "小張");
  assert.equal(sectionSha256(getSection(other, "模組：會員")), a);
  assert.notEqual(sectionSha256(getSection(other, "模組：訂單")), sectionSha256(getSection(DOC, "模組：訂單")));
});

test("取代：只動該段，其他段落與前言逐字不變；段落之間的空白行保留", () => {
  const out = replaceSection(DOC, "模組：會員", "## 模組：會員\n- 負責人：小王\n- 類型：系統模組");
  assert.equal(out, DOC.replace("- 負責人：小王\n", "- 負責人：小王\n- 類型：系統模組\n"));
  assert.equal(getSection(out, "模組：訂單"), getSection(DOC, "模組：訂單"));
});

test("新增：key 不存在就接在最後，與前面空一行；空文件直接成為內容", () => {
  const out = replaceSection(DOC, "模組：庫存", "## 模組：庫存\n- 負責人：小陳");
  assert.ok(out.endsWith("- 訂單：order\n\n## 模組：庫存\n- 負責人：小陳\n"));
  assert.equal(replaceSection("", "A", "## A\nx"), "## A\nx\n");
});

test("singleSectionKey：內容必須剛好是一段、標題與 key 相符，否則丟錯", () => {
  assert.equal(singleSectionKey("## 模組：庫存\n- x", "模組：庫存"), "模組：庫存");
  assert.throws(() => singleSectionKey("## A\nx\n## B\ny", "A"), /剛好一個/);
  assert.throws(() => singleSectionKey("前言\n## A\nx", "A"), /剛好一個|標題/);
  assert.throws(() => singleSectionKey("## A\nx", "B"), /不符/);
  assert.throws(() => singleSectionKey("沒有標題", "A"), /剛好一個/);
});
