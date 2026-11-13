// 步驟 A：版本管控歷程檢查（以已確認範本為合格樣本）與標題編號前綴忽略。
import test from "node:test";
import assert from "node:assert/strict";
import { SA_TEMPLATE, SD_TEMPLATE, tableSchemaTemplates } from "./helpers/sasd-standard.mjs";

const { checkVersionHistory } = await import("../dist/workflow/version-history-check.js");
const { stripHeadingNumber, headingMatches, headingEquals } = await import("../dist/workflow/heading-match.js");
const { extractSection } = await import("../dist/workflow/reuse-record-check.js");

const HEAD = "| 版次 | 發行日期 | 修訂說明 | 修訂單位 | 修訂人員 |\n| --- | --- | --- | --- | --- |\n";
const doc = (rows, heading = "## 版本管控歷程") => `# 文件\n\n${heading}\n\n${HEAD}${rows}\n\n## 其他\n內容\n`;
const row = (v, d, n) => `| ${v} | ${d} | ${n} | 團隊 | 某人 |\n`;

test("範本中的版本管控歷程全部合格（SA、SD、兩份資料表文件）", () => {
  assert.deepEqual(checkVersionHistory(SA_TEMPLATE(), "SA"), []);
  assert.deepEqual(checkVersionHistory(SD_TEMPLATE(), "SD"), []);
  for (const [name, text] of Object.entries(tableSchemaTemplates())) assert.deepEqual(checkVersionHistory(text, name), [], name);
  assert.deepEqual(Object.keys(tableSchemaTemplates()), ["orders_master", "members"]);
});

test("單列初版與 1.0、1.1 遞增都合格", () => {
  assert.deepEqual(checkVersionHistory(doc(row("1.0", "2026/11/10", "初版"))), []);
  assert.deepEqual(checkVersionHistory(doc(row("1.0", "2026/11/10", "初版") + row("1.1", "2026/11/11", "新增匯出欄位"))), []);
  assert.deepEqual(checkVersionHistory(doc(row("0.9", "2026/11/10", "初版") + row("1.0", "2026/11/11", "正式版"))), []);
});

test("編號前綴的標題也算（「五、版本管控歷程」「3. 版本管控歷程」）", () => {
  for (const h of ["## 五、版本管控歷程", "## 3. 版本管控歷程", "## （一）版本管控歷程", "## 第五節 版本管控歷程"]) {
    assert.deepEqual(checkVersionHistory(doc(row("0.1", "2026/11/10", "初版"), h)), [], h);
  }
});

test("缺章節", () => {
  assert.match(checkVersionHistory("# 文件\n內容\n", "SA")[0], /缺少「## 版本管控歷程」/);
});

test("不是表格、表頭錯誤、欄位不足", () => {
  assert.match(checkVersionHistory("## 版本管控歷程\n0.1 初版\n")[0], /必須是 markdown 表格/);
  const wrongHeader = "## 版本管控歷程\n| 版本 | 日期 | 說明 | 單位 | 人員 |\n| --- | --- | --- | --- | --- |\n| 0.1 | 2026/11/10 | 初版 | a | b |\n";
  assert.match(checkVersionHistory(wrongHeader)[0], /表頭必須是/);
  const fewer = "## 版本管控歷程\n| 版次 | 發行日期 | 修訂說明 | 修訂單位 |\n| --- | --- | --- | --- |\n| 0.1 | 2026/11/10 | 初版 | a |\n";
  assert.match(checkVersionHistory(fewer)[0], /表頭必須是/);
  assert.match(checkVersionHistory(doc("| 0.1 | 2026/11/10 | 初版 |\n")).join("；"), /欄位不足/);
});

test("沒有任何資料列", () => {
  assert.match(checkVersionHistory(doc(""))[0], /至少要有一列/);
});

test("版次格式錯誤與沒有遞增", () => {
  assert.match(checkVersionHistory(doc(row("v1", "2026/11/10", "初版")))[0], /版次「v1」格式不正確/);
  assert.match(checkVersionHistory(doc(row("0.2", "2026/11/10", "初版") + row("0.1", "2026/11/11", "回頭改")))[0], /必須大於上一列/);
  assert.match(checkVersionHistory(doc(row("0.1", "2026/11/10", "初版") + row("0.1", "2026/11/11", "重複版次")))[0], /必須大於上一列/);
  assert.match(checkVersionHistory(doc(row("1.0", "2026/11/10", "正式版") + row("0.9", "2026/11/11", "降版")))[0], /必須大於上一列/);
});

test("日期格式錯誤與不存在的日期", () => {
  for (const d of ["2026-11-10", "2026/1/5", "26/11/10", "2026/02/30", "2026/13/01", ""]) {
    assert.match(checkVersionHistory(doc(row("0.1", d, "初版")))[0], /發行日期/, d);
  }
});

test("修訂說明空白或空洞詞", () => {
  for (const n of ["", "調整", "修正", "更新。", "修改", "補充", "異動"]) {
    assert.match(checkVersionHistory(doc(row("0.1", "2026/11/10", n))).join("；"), /修訂說明空白或只有/, n);
  }
  assert.deepEqual(checkVersionHistory(doc(row("0.1", "2026/11/10", "調整日期區間上限為 366 天"))), []);
});

test("一份文件的多項違規逐項回報", () => {
  const r = checkVersionHistory(doc(row("x", "bad", "更新")));
  assert.equal(r.length, 3);
});

test("stripHeadingNumber：各種編號前綴", () => {
  const cases = { "3. 規則": "規則", "3.1 規則": "規則", "3、規則": "規則", "3) 規則": "規則", "五、規則": "規則", "（一）規則": "規則", "(2) 規則": "規則", "第五節 規則": "規則", "第 3 章：規則": "規則", "一、規則": "規則", "規則": "規則" };
  for (const [from, to] of Object.entries(cases)) assert.equal(stripHeadingNumber(from), to, from);
});

test("stripHeadingNumber：不誤剝（一覽表、年度、只有編號）", () => {
  for (const s of ["一覽表", "2026年度報告", "3.", "五、", "第五節"]) assert.equal(stripHeadingNumber(s), s, s);
});

test("headingMatches／headingEquals", () => {
  assert.ok(headingMatches("五、重用與共用設計（含說明）", "重用與共用設計"));
  assert.ok(!headingMatches("附錄：重用與共用設計", "重用與共用設計"));
  assert.ok(headingEquals("2. 畫面", "畫面"));
  assert.ok(!headingEquals("畫面說明", "畫面"));
});

test("extractSection 容許編號前綴（既有的標題比對統一走共用函式）", () => {
  const t = "## 五、重用檢查紀錄\n內容\n## 六、其他\n別的\n";
  assert.equal(extractSection(t, "重用檢查紀錄").trim().endsWith("內容"), true);
  assert.equal(extractSection("## 3. 技術棧\nx\n", "技術棧") !== null, true);
});
