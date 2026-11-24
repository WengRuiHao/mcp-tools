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
