// 批次 1P：work_item 的 project_doc_read／project_doc_write 動作、記錄本工作項目動過哪些專案層文件、get 與交付摘要的呈現。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { setupEnv } from "./helpers/work-item-env.mjs";
import { listSnapshots } from "../dist/rule-history.js";

const env = await setupEnv("wi-pdoc-");
after(() => env.cleanup());
const DOC = "architecture-decisions.md";
const create = async () => (await env.call({ action: "create", projectDir: env.projectDir, title: "專案文件", requirement: "y", baseline: "greenfield", scope: "both", hasDb: true, techSource: "new-guided", styleSource: "new-guided" })).json;
const write = (id, extra) => env.call({ action: "project_doc_write", workItemId: id, filename: DOC, content: "# 架構決策書\n", ...extra });

test("工具介面：動作清單含兩個專案層文件動作，並有 expectedSha256 參數", async () => {
  const { tools } = await env.client.listTools();
  const t = tools.find((x) => x.name === "work_item");
  assert.ok(t.inputSchema.properties.action.enum.includes("project_doc_read") && t.inputSchema.properties.action.enum.includes("project_doc_write"));
  assert.equal(t.inputSchema.properties.expectedSha256.type, "string");
});

test("讀：不帶 filename 列出現有文件與可用名稱；不存在的文件 exists=false", async () => {
  const c = await create();
  const list = await env.call({ action: "project_doc_read", workItemId: c.workItemId });
  assert.equal(list.isError, false, JSON.stringify(list.json));
  assert.deepEqual(list.json.docs, []);
  assert.ok(list.json.allowedNames.includes(DOC));
  const r = await env.call({ action: "project_doc_read", workItemId: c.workItemId, filename: DOC });
  assert.deepEqual([r.json.exists, r.json.content, r.json.sha256], [false, "", null]);
});

test("寫入後讀得到，檔案落在專案目錄的 .dev-pipeline/project-docs/", async () => {
  const c = await create();
  const w = await write(c.workItemId);
  assert.equal(w.isError, false, JSON.stringify(w.json));
  assert.match(w.json.sha256, /^[0-9a-f]{64}$/);
  const r = await env.call({ action: "project_doc_read", workItemId: c.workItemId, filename: DOC });
  assert.deepEqual([r.json.exists, r.json.content, r.json.sha256], [true, "# 架構決策書\n", w.json.sha256]);
  assert.equal(await readFile(path.join(env.projectDir, ".dev-pipeline", "project-docs", DOC), "utf-8"), "# 架構決策書\n");
});

test("拒絕：不在白名單的檔名、缺少 content、缺 filename", async () => {
  const c = await create();
  const bad = await env.call({ action: "project_doc_write", workItemId: c.workItemId, filename: "../x.md", content: "x" });
  assert.equal(bad.isError, true);
  assert.match(bad.json.message, /不允許/);
  const noContent = await env.call({ action: "project_doc_write", workItemId: c.workItemId, filename: DOC });
  assert.equal(noContent.isError, true);
  assert.match(noContent.json.message, /content/);
  const noName = await env.call({ action: "project_doc_write", workItemId: c.workItemId, content: "x" });
  assert.equal(noName.isError, true);
  assert.match(noName.json.message, /filename/);
  const readBad = await env.call({ action: "project_doc_read", workItemId: c.workItemId, filename: "nope.md" });
  assert.equal(readBad.isError, true);
});

test("版本比對：帶舊的 expectedSha256 被拒絕並指出要重新讀取；帶對的才寫入", async () => {
  const c = await create();
  const a = await write(c.workItemId, { content: "v1" });
  const b = await write(c.workItemId, { content: "v2", expectedSha256: a.json.sha256 });
  assert.equal(b.isError, false);
  const stale = await write(c.workItemId, { content: "v3", expectedSha256: a.json.sha256 });
  assert.equal(stale.isError, true);
  assert.match(stale.json.message, /重新讀取/);
  assert.equal(stale.json.conflict, true);
  assert.equal((await env.call({ action: "project_doc_read", workItemId: c.workItemId, filename: DOC })).json.content, "v2");
});

test("歷史：覆寫前存快照，沿用規則檔的快照機制可查", async () => {
  const c = await create();
  await write(c.workItemId, { content: "v1" });
  await write(c.workItemId, { content: "v2" });
  const snaps = await listSnapshots(env.projectDir, `.dev-pipeline/project-docs/${DOC}`);
  assert.ok(snaps.length >= 1);
});

test("記錄：本工作項目動過的專案層文件寫進狀態（內容沒變不記）；沒動過的工作項目沒有這個 key", async () => {
  const touched = await create();
  const untouched = await create();
  await write(touched.workItemId, { content: "a" });
  await write(touched.workItemId, { content: "a" });
  await write(touched.workItemId, { content: "b" });
  const s1 = JSON.parse(await readFile(path.join(touched.dir, "status.json"), "utf-8"));
  assert.equal(s1.project_doc_changes.length, 2);
  assert.ok(s1.project_doc_changes.every((x) => x.doc === DOC && /^[0-9a-f]{64}$/.test(x.sha256)));
  const s2 = JSON.parse(await readFile(path.join(untouched.dir, "status.json"), "utf-8"));
  assert.ok(!Object.keys(s2).includes("project_doc_changes"));
});

test("get：專案沒有文件就沒有 projectDocs 欄位；有了才列", async () => {
  const env2 = await setupEnv("wi-pdoc-empty-");
  try {
    const c = (await env2.call({ action: "create", projectDir: env2.projectDir, title: "空", requirement: "y", baseline: "greenfield", scope: "both", hasDb: true, techSource: "new-guided", styleSource: "new-guided" })).json;
    const none = (await env2.call({ action: "get", workItemId: c.workItemId })).json;
    assert.ok(!("projectDocs" in none), "沒有專案層文件時不該多出欄位");
    await env2.call({ action: "project_doc_write", workItemId: c.workItemId, filename: DOC, content: "x" });
    const some = (await env2.call({ action: "get", workItemId: c.workItemId })).json;
    assert.deepEqual(some.projectDocs, [{ name: DOC, bytes: 1 }]);
  } finally {
    await env2.cleanup();
  }
});

test("索引：專案有專案層文件才多「專案層文件」一節（附相對連結）；寫入後立即更新；沒有文件的專案索引不變", async () => {
  const env2 = await setupEnv("wi-pdoc-index-");
  try {
    const mk = async (title) => (await env2.call({ action: "create", projectDir: env2.projectDir, title, requirement: "y", baseline: "greenfield", scope: "both", hasDb: true, techSource: "new-guided", styleSource: "new-guided" })).json;
    const a = await mk("索引甲");
    const before = await readFile(path.join(a.dir, "00-索引.md"), "utf-8");
    assert.doesNotMatch(before, /專案層文件/);
    await env2.call({ action: "project_doc_write", workItemId: a.workItemId, filename: DOC, content: "# 決策\n" });
    const after = await readFile(path.join(a.dir, "00-索引.md"), "utf-8");
    assert.match(after, /## 專案層文件/);
    const rel = path.relative(a.dir, path.join(env2.projectDir, ".dev-pipeline", "project-docs", DOC)).split(path.sep).join("/");
    assert.ok(after.includes(`[${DOC}](${rel})`), after);
    const b = await mk("索引乙");
    assert.match(await readFile(path.join(b.dir, "00-索引.md"), "utf-8"), /## 專案層文件/, "同專案後建立的項目也看得到");
  } finally {
    await env2.cleanup();
  }
});

test("模組地圖：寫入有結構問題就回 moduleMapWarnings（不擋寫入）；沒問題或別的文件不回", async () => {
  const c = await create();
  const bad = await env.call({ action: "project_doc_write", workItemId: c.workItemId, filename: "module-map.md", content: "## 模組：A\n- 依賴模組：Z\n" });
  assert.equal(bad.isError, false, JSON.stringify(bad.json));
  assert.ok(bad.json.moduleMapWarnings.some((w) => w.includes("負責人")) && bad.json.moduleMapWarnings.some((w) => w.includes("Z")), JSON.stringify(bad.json));
  const ok = await env.call({ action: "project_doc_write", workItemId: c.workItemId, filename: "module-map.md", content: "## 模組：A\n- 負責人：x\n" });
  assert.equal(ok.json.moduleMapWarnings, undefined);
  const other = await write(c.workItemId, { content: "# 內容 ## 模組：A\n" });
  assert.equal(other.json.moduleMapWarnings, undefined);
});

test("模組地圖：介面升版寫入時回 interfaceChangeNotices 列出使用者；第一次寫入或沒變動不回", async () => {
  const c = await create();
  const map = (v) => `## 模組：庫存\n- 負責人：x\n### 對外介面\n- 扣庫存｜同步呼叫｜v${v}｜扣減｜使用者：訂單\n\n## 模組：訂單\n- 負責人：y\n`;
  const first = await env.call({ action: "project_doc_write", workItemId: c.workItemId, filename: "module-map.md", content: map(1) });
  assert.equal(first.json.interfaceChangeNotices, undefined);
  const up = await env.call({ action: "project_doc_write", workItemId: c.workItemId, filename: "module-map.md", content: map(2) });
  assert.equal(up.isError, false, JSON.stringify(up.json));
  assert.match(up.json.interfaceChangeNotices.join("\n"), /庫存\.扣庫存.*v1.*v2.*訂單/);
  const same = await env.call({ action: "project_doc_write", workItemId: c.workItemId, filename: "module-map.md", content: map(2) });
  assert.equal(same.json.interfaceChangeNotices, undefined);
});

test("容量假設：寫入缺到期日回 capacityWarnings；高風險的 get 回逾期提醒，非高風險不回", async () => {
  const c = await create();
  const bad = await env.call({ action: "project_doc_write", workItemId: c.workItemId, filename: "capacity-assumptions.md", content: "- 沒日期的假設\n- 舊假設｜到期日：2020-01-01\n" });
  assert.equal(bad.isError, false, JSON.stringify(bad.json));
  assert.match(bad.json.capacityWarnings.join("\n"), /沒日期的假設.*到期日/);
  const plain = (await env.call({ action: "get", workItemId: c.workItemId })).json;
  assert.equal(plain.capacityWarnings, undefined);
  const hr = await env.call({ action: "set_scope", workItemId: c.workItemId, highRisk: true });
  assert.equal(hr.isError, false, JSON.stringify(hr.json));
  const got = (await env.call({ action: "get", workItemId: c.workItemId })).json;
  assert.match(got.capacityWarnings.join("\n"), /舊假設.*逾期.*2020-01-01/);
});

test("模組地圖：跨模組情境結構問題也走 moduleMapWarnings", async () => {
  const c = await create();
  const map = "## 模組：A\n- 負責人：x\n\n## 模組：B\n- 負責人：y\n\n## 跨模組情境：下單\n- 經過模組：A → Q\n- 協調者：A\n";
  const r = await env.call({ action: "project_doc_write", workItemId: c.workItemId, filename: "module-map.md", content: map });
  assert.equal(r.isError, false, JSON.stringify(r.json));
  const w = r.json.moduleMapWarnings.join("\n");
  assert.match(w, /下單.*Q.*不在模組地圖/);
  assert.match(w, /下單.*失敗處理/);
});

test("歷史例外：白名單含 legacy-exceptions.md；寫入缺到期日回 legacyExceptionWarnings；get 回逾期提醒，未逾期不多欄位", async () => {
  const { PROJECT_DOC_NAMES } = await import("../dist/project-docs-store.js");
  assert.ok(PROJECT_DOC_NAMES.includes("legacy-exceptions.md"));
  const c = await create();
  const bad = await env.call({ action: "project_doc_write", workItemId: c.workItemId, filename: "legacy-exceptions.md", content: "- 訂單與庫存直接寫 stock 表\n- 報表直接讀 orders｜到期日：2099-01-01\n" });
  assert.equal(bad.isError, false, JSON.stringify(bad.json));
  assert.match(bad.json.legacyExceptionWarnings.join("\n"), /訂單與庫存直接寫 stock 表.*到期日/);
  assert.equal(bad.json.legacyExceptionWarnings.length, 1);
  const clean = (await env.call({ action: "get", workItemId: c.workItemId })).json;
  assert.equal(clean.legacyExceptionWarnings, undefined);
  await env.call({ action: "project_doc_write", workItemId: c.workItemId, filename: "legacy-exceptions.md", content: "- 舊例外｜到期日：2020-01-01\n- 新例外｜到期日：2099-01-01\n" });
  const got = (await env.call({ action: "get", workItemId: c.workItemId })).json;
  assert.equal(got.legacyExceptionWarnings.length, 1);
  assert.match(got.legacyExceptionWarnings[0], /舊例外.*逾期.*2020-01-01/);
});

test("段落式寫入：兩個功能改不同模組不衝突；同一段衝突被擋；既有段落要帶段落雜湊；其他段落不受影響", async () => {
  const c = await create();
  const map = "# 模組地圖\n\n## 模組：會員\n- 負責人：小王\n\n## 模組：訂單\n- 負責人：小李\n";
  const w0 = await env.call({ action: "project_doc_write", workItemId: c.workItemId, filename: "module-map.md", content: map });
  assert.equal(w0.isError, false, JSON.stringify(w0.json));
  const readSec = async (section) => (await env.call({ action: "project_doc_read", workItemId: c.workItemId, filename: "module-map.md", section })).json;
  const member = await readSec("模組：會員");
  const order = await readSec("模組：訂單");
  assert.equal(member.section, "模組：會員");
  assert.match(member.content, /小王/);
  assert.ok(member.sectionSha256 && order.sectionSha256);
  const wr = (section, content, expectedSectionSha256) => env.call({ action: "project_doc_write", workItemId: c.workItemId, filename: "module-map.md", section, content, ...(expectedSectionSha256 ? { expectedSectionSha256 } : {}) });
  // 兩人都讀了舊版：甲改會員、乙改訂單，都成功
  const a = await wr("模組：會員", "## 模組：會員\n- 負責人：小王\n- 類型：系統模組", member.sectionSha256);
  assert.equal(a.isError, false, JSON.stringify(a.json));
  const b = await wr("模組：訂單", "## 模組：訂單\n- 負責人：小李\n- 依賴模組：會員", order.sectionSha256);
  assert.equal(b.isError, false, JSON.stringify(b.json));
  const full = (await env.call({ action: "project_doc_read", workItemId: c.workItemId, filename: "module-map.md" })).json.content;
  assert.match(full, /類型：系統模組/);
  assert.match(full, /依賴模組：會員/);
  // 同一段：用舊雜湊再改會員 → 衝突
  const stale = await wr("模組：會員", "## 模組：會員\n- 負責人：別人", member.sectionSha256);
  assert.equal(stale.isError, true);
  assert.equal(stale.json.conflict, true);
  // 既有段落沒帶雜湊 → 拒絕；新段落不帶雜湊 → 成功；新段落已存在又不帶 → 拒絕
  const noSha = await wr("模組：會員", "## 模組：會員\n- 負責人：x");
  assert.equal(noSha.isError, true);
  assert.match(noSha.text, /expectedSectionSha256/);
  const fresh = await wr("模組：庫存", "## 模組：庫存\n- 負責人：小陳");
  assert.equal(fresh.isError, false, JSON.stringify(fresh.json));
  // 標題與 section 不符、內容含多段 → 拒絕
  assert.equal((await wr("模組：庫存", "## 模組：別的\n- x", (await readSec("模組：庫存")).sectionSha256)).isError, true);
  // 合併後整份結構檢查仍會回警告（庫存沒有擁有者以外的問題，這裡改成依賴不存在的模組）
  const warn = await wr("模組：庫存", "## 模組：庫存\n- 負責人：小陳\n- 依賴模組：不存在", (await readSec("模組：庫存")).sectionSha256);
  assert.equal(warn.isError, false, JSON.stringify(warn.json));
  assert.match(warn.json.moduleMapWarnings.join("\n"), /不存在/);
  // 讀不存在的段落、非 md 文件用 section 都拒絕
  assert.equal((await env.call({ action: "project_doc_read", workItemId: c.workItemId, filename: "module-map.md", section: "沒這段" })).isError, true);
  assert.equal((await env.call({ action: "project_doc_write", workItemId: c.workItemId, filename: "system-bpmn.bpmn", section: "A", content: "## A\nx" })).isError, true);
});
