// 批次 1P：專案層級文件資料層。固定白名單檔名、原子寫入、版本比對、重用規則檔的歷史快照。全部用暫存目錄隔離。
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { isRuleFilePath, listSnapshots, readSnapshot } from "../dist/rule-history.js";
import { PROJECT_DOCS_DIR, PROJECT_DOC_NAMES, MAX_PROJECT_DOC_BYTES, ProjectDocConflictError, isProjectDocName, listProjectDocs, projectDocRelPath, readProjectDoc, writeProjectDoc } from "../dist/project-docs-store.js";

const newProject = () => mkdtemp(path.join(os.tmpdir(), "pd-proj-"));
const DOC = "architecture-decisions.md";

test("白名單：固定檔名才接受，含路徑、上層目錄、未知名稱一律拒絕", () => {
  for (const n of PROJECT_DOC_NAMES) assert.equal(isProjectDocName(n), true, n);
  for (const bad of ["../x.md", "a/b.md", "a\\b.md", "unknown.md", "", "architecture-decisions.md/", ".dev-pipeline/project-docs/architecture-decisions.md"]) assert.equal(isProjectDocName(bad), false, bad);
  assert.ok(PROJECT_DOC_NAMES.includes("architecture-decisions.md") && PROJECT_DOC_NAMES.includes("permission-codes.md"));
});

test("相對路徑：.dev-pipeline/project-docs/<檔名>；路徑屬於規則檔歷史可追蹤的範圍", () => {
  assert.equal(PROJECT_DOCS_DIR, ".dev-pipeline/project-docs");
  assert.equal(projectDocRelPath(DOC), ".dev-pipeline/project-docs/architecture-decisions.md");
  assert.equal(isRuleFilePath(projectDocRelPath(DOC)), true);
  assert.equal(isRuleFilePath(".dev-pipeline/work-items/x/status.json"), false);
  assert.equal(isRuleFilePath(".dev-pipeline/project-docs/../x.md"), false);
});

test("讀寫來回：不存在時回 exists=false；寫入後讀得到，並回傳內容雜湊", async () => {
  const dir = await newProject();
  const none = await readProjectDoc(dir, DOC);
  assert.deepEqual([none.exists, none.content, none.sha256], [false, "", null]);
  const w = await writeProjectDoc(dir, DOC, "# 架構決策書\n");
  assert.match(w.sha256, /^[0-9a-f]{64}$/);
  const r = await readProjectDoc(dir, DOC);
  assert.deepEqual([r.exists, r.content, r.sha256], [true, "# 架構決策書\n", w.sha256]);
  assert.equal(await readFile(path.join(dir, ".dev-pipeline", "project-docs", DOC), "utf-8"), "# 架構決策書\n");
});

test("未知檔名、超過大小上限都拒絕，不寫任何檔案", async () => {
  const dir = await newProject();
  await assert.rejects(writeProjectDoc(dir, "../evil.md", "x"), /不允許/);
  await assert.rejects(readProjectDoc(dir, "nope.md"), /不允許/);
  await assert.rejects(writeProjectDoc(dir, DOC, "x".repeat(MAX_PROJECT_DOC_BYTES + 1)), /太大/);
  assert.deepEqual(await listProjectDocs(dir), []);
});

test("版本比對：帶 expectedSha256 且與目前不符就拒絕（有人先改過）；相符才寫入", async () => {
  const dir = await newProject();
  const a = await writeProjectDoc(dir, DOC, "v1");
  const b = await writeProjectDoc(dir, DOC, "v2", { expectedSha256: a.sha256 });
  await assert.rejects(writeProjectDoc(dir, DOC, "v3", { expectedSha256: a.sha256 }), (e) => e instanceof ProjectDocConflictError && /重新讀取/.test(e.message));
  assert.equal((await readProjectDoc(dir, DOC)).content, "v2");
  await writeProjectDoc(dir, DOC, "v3", { expectedSha256: b.sha256 });
  assert.equal((await readProjectDoc(dir, DOC)).content, "v3");
});

test("檔案還不存在卻帶了 expectedSha256 也算衝突", async () => {
  const dir = await newProject();
  await assert.rejects(writeProjectDoc(dir, DOC, "x", { expectedSha256: "a".repeat(64) }), ProjectDocConflictError);
});

test("同時寫入：兩個寫入帶同一個版本，只有一個成功，另一個衝突", async () => {
  const dir = await newProject();
  const base = await writeProjectDoc(dir, DOC, "base");
  const results = await Promise.allSettled([
    writeProjectDoc(dir, DOC, "A", { expectedSha256: base.sha256 }),
    writeProjectDoc(dir, DOC, "B", { expectedSha256: base.sha256 }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
});

test("歷史：覆寫前把舊內容存快照（內容相同不重複存），可用規則檔的快照機制讀回", async () => {
  const dir = await newProject();
  await writeProjectDoc(dir, DOC, "v1");
  assert.equal((await listSnapshots(dir, projectDocRelPath(DOC))).length, 0, "第一次寫入沒有舊內容可存");
  await writeProjectDoc(dir, DOC, "v2");
  await writeProjectDoc(dir, DOC, "v2");
  const snaps = await listSnapshots(dir, projectDocRelPath(DOC));
  assert.equal(snaps.length, 1);
  assert.equal(await readSnapshot(dir, projectDocRelPath(DOC), snaps[0].name), "v1");
});

test("listProjectDocs：只列實際存在的專案層文件，附大小", async () => {
  const dir = await newProject();
  await writeProjectDoc(dir, DOC, "abc");
  await writeProjectDoc(dir, "permission-codes.md", "x");
  await mkdir(path.join(dir, ".dev-pipeline", "project-docs"), { recursive: true });
  await writeFile(path.join(dir, ".dev-pipeline", "project-docs", "stray.txt"), "不在白名單，不列");
  const list = await listProjectDocs(dir);
  assert.deepEqual(list.map((d) => d.name).sort(), ["architecture-decisions.md", "permission-codes.md"]);
  assert.equal(list.find((d) => d.name === DOC).bytes, 3);
});
