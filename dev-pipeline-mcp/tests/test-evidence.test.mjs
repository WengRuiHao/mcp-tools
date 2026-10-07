// record_test_evidence 與 04-test.md／advance tested 的測試證據關卡。中文字用 \u 逃脫。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { makeTmpDir, removeDir, isolateDataDir, connectClient, callTool } from "./helpers/support.mjs";

const iso = isolateDataDir();
const tmp = makeTmpDir("dpm-evidence-");
const projectDir = path.join(tmp, "proj");
const srcDir = path.join(tmp, "src");
fs.mkdirSync(srcDir, { recursive: true });

const store = await import("../dist/pipeline-store.js");
const { registerTestEvidenceTools } = await import("../dist/test-evidence-tools.js");
const { setEvidenceRemoverForTest } = await import("../dist/test-evidence-store.js");
const { registerTicketArtifactTools } = await import("../dist/ticket-artifact-tools.js");
const { registerTicketLifecycleTools } = await import("../dist/ticket-lifecycle-tools.js");

const LABEL = "【測試假資料，非正式資料】";
const HEADING = "## 測試證據";
const ACTION_PREFIX = "請用 Excel 開啟 ";
const FAKE_DIR = "【假資料】";
const FAKE_SUFFIX = "_假資料";
const SHOT = "截圖";

let ctx;
before(async () => {
  ctx = await connectClient((s) => {
    registerTestEvidenceTools(s);
    registerTicketArtifactTools(s);
    registerTicketLifecycleTools(s);
  });
});
after(async () => {
  await ctx.close();
  iso.cleanup();
  removeDir(tmp);
});

const call = (name, args) => callTool(ctx.client, name, args);
let counter = 0;
async function newTicket() {
  const gid = `ev${++counter}`;
  await store.assignTicketDir(projectDir, gid, "Proj", `T-${gid}`);
  await store.advanceStage(gid, "snapshot", {});
  return gid;
}
function mk(name, content = "x") {
  const p = path.join(srcDir, name);
  fs.writeFileSync(p, content);
  return p;
}
const ticketDir = (gid) => path.join(projectDir, ".asana-pipeline", "Proj", `T-${gid}`);
const base = (gid, o = {}) => ({
  taskGid: gid,
  featureName: "report export",
  fileKind: "excel",
  testLevel: "unit-mock",
  sourceFile: mk("a.xlsx"),
  usesFakeData: false,
  ...o,
});
const rec = (gid, o) => call("record_test_evidence", base(gid, o));
const art = (gid, o = {}) =>
  call("write_ticket_artifact", {
    taskGid: gid,
    filename: "04-test.md",
    content: `PASS\n${HEADING}\nreport export unit-mock`,
    summary: "s",
    syncNote: "NO_SYNC_NEEDED",
    manualActions: [],
    producesOfficeFiles: false,
    testLevel: "unit-mock",
    ...o,
  });

test("fake data: only the marked copy is stored (<name>_假資料.<ext>) under the 【假資料】 folder, source is only recorded with sha256", async () => {
  const gid = await newTicket();
  const src = mk("real.xlsx", "real-bytes");
  const r = await rec(gid, {
    sourceFile: src,
    usesFakeData: true,
    markedFile: mk("m.xlsx", "marked"),
    fakeDataMarked: true,
    screenshotPaths: [mk("s1.png"), mk("s2.jpg")],
    testSource: "manual run",
  });
  assert.equal(r.isError, false, r.text);
  const root = path.join(ticketDir(gid), "test-evidence");
  assert.deepEqual(fs.readdirSync(root), [`${FAKE_DIR}report_export`]);
  const dir = path.join(root, `${FAKE_DIR}report_export`);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`real${FAKE_SUFFIX}.xlsx`, `real${FAKE_SUFFIX}_${SHOT}_1.png`, `real${FAKE_SUFFIX}_${SHOT}_2.jpg`].sort());
  assert.equal(fs.readFileSync(path.join(dir, `real${FAKE_SUFFIX}.xlsx`), "utf-8"), "marked");
  assert.ok(fs.existsSync(src), "source must be copied or left alone, never moved");
  const e = (await store.readStatus(gid)).test_evidence[0];
  assert.equal(e.files.file, `test-evidence/${FAKE_DIR}report_export/real${FAKE_SUFFIX}.xlsx`);
  assert.equal(e.files.original.path, src);
  assert.equal(e.files.original.sha256, crypto.createHash("sha256").update("real-bytes").digest("hex"));
  assert.equal(e.files.marked, undefined);
  assert.equal(e.files.screenshots.length, 2);
  assert.equal(e.pendingManualScreenshot, false);
  assert.equal(e.fakeDataMarked, true);
  assert.equal(e.testLevel, "unit-mock");
  assert.equal(e.testSource, "manual run");
});

test("real data: a single file named <name>.<ext> with no suffix, in a plain folder", async () => {
  const gid = await newTicket();
  const r = await rec(gid, { screenshotPaths: [mk("s1.png")] });
  assert.equal(r.isError, false, r.text);
  const dir = path.join(ticketDir(gid), "test-evidence", "report_export");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["a.xlsx", `a_${SHOT}_1.png`]);
  assert.equal((await store.readStatus(gid)).test_evidence[0].files.file, "test-evidence/report_export/a.xlsx");
});

test("text kinds with fake data are stored as <name>_假資料.<ext> in the 【假資料】 folder; test-report content is untouched", async () => {
  const gid = await newTicket();
  const fake = { usesFakeData: true, testLevel: "live-api" };
  const call1 = await rec(gid, { ...fake, fileKind: "api-call", featureName: "orders", sourceFile: mk("call.txt", `${LABEL}\nPOST /x\n`) });
  assert.equal(call1.isError, false, call1.text);
  assert.equal(call1.json.evidence.files.file, `test-evidence/${FAKE_DIR}orders/call${FAKE_SUFFIX}.txt`);
  const rep1 = await rec(gid, { ...fake, fileKind: "test-report", featureName: "orders", sourceFile: mk("t.xml", "<testsuite/>") });
  assert.equal(rep1.json.evidence.files.file, `test-evidence/${FAKE_DIR}orders/t${FAKE_SUFFIX}.xml`);
  assert.equal(fs.readFileSync(path.join(ticketDir(gid), rep1.json.evidence.files.file), "utf-8"), "<testsuite/>");
  const real = await rec(gid, { fileKind: "api-call", featureName: "orders", sourceFile: mk("call2.txt", "POST /y"), testLevel: "live-api" });
  assert.equal(real.json.evidence.files.file, "test-evidence/orders/call2.txt");
});

test("toggling usesFakeData on the same feature + file name moves the evidence and removes the old files and folder", async () => {
  const gid = await newTicket();
  const first = await rec(gid, { screenshotPaths: [mk("s1.png")] });
  assert.equal(first.isError, false, first.text);
  const root = path.join(ticketDir(gid), "test-evidence");
  assert.deepEqual(fs.readdirSync(root), ["report_export"]);
  const fake = await rec(gid, { usesFakeData: true, markedFile: mk("m.xlsx", "m"), fakeDataMarked: true });
  assert.equal(fake.isError, false, fake.text);
  assert.deepEqual(fs.readdirSync(root), [`${FAKE_DIR}report_export`], "old plain folder removed");
  assert.deepEqual(fs.readdirSync(path.join(root, `${FAKE_DIR}report_export`)).sort(), [`a${FAKE_SUFFIX}.xlsx`, `a${FAKE_SUFFIX}_${SHOT}_1.png`].sort(), "screenshots follow the new naming");
  const st = await store.readStatus(gid);
  assert.equal(st.test_evidence.length, 1, "same record, not a second one");
  assert.equal(st.test_evidence[0].usesFakeData, true);
  const back = await rec(gid, {});
  assert.equal(back.isError, false, back.text);
  assert.deepEqual(fs.readdirSync(root), ["report_export"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "report_export")).sort(), ["a.xlsx", `a_${SHOT}_1.png`]);
});

test("legacy backups (_原始 / _假資料標註 / old folder name / old status shape) are migrated and removed on the next call", async () => {
  const gid = await newTicket();
  const dir = path.join(ticketDir(gid), "test-evidence", "report_export");
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ["a_原始.xlsx", "a_假資料標註.xlsx", `a_${SHOT}_1.png`]) fs.writeFileSync(path.join(dir, n), n);
  const legacyRel = (n) => `test-evidence/report_export/${n}`;
  await store.updateStatus(gid, (s) => ({
    ...s,
    test_evidence: [
      {
        id: crypto.createHash("sha1").update("report_export\na").digest("hex").slice(0, 10),
        featureName: "report export", fileKind: "excel", testLevel: "unit-mock", testSource: null,
        files: { original: legacyRel("a_原始.xlsx"), marked: legacyRel("a_假資料標註.xlsx"), screenshots: [legacyRel(`a_${SHOT}_1.png`)] },
        usesFakeData: true, fakeDataMarked: true, pendingManualScreenshot: false, recordedAt: "x", note: null,
      },
    ],
  }));
  const r = await rec(gid, { usesFakeData: true, markedFile: mk("m.xlsx", "new"), fakeDataMarked: true });
  assert.equal(r.isError, false, r.text);
  const root = path.join(ticketDir(gid), "test-evidence");
  assert.deepEqual(fs.readdirSync(root), [`${FAKE_DIR}report_export`], "old folder is gone");
  assert.deepEqual(fs.readdirSync(path.join(root, `${FAKE_DIR}report_export`)).sort(), [`a${FAKE_SUFFIX}.xlsx`, `a${FAKE_SUFFIX}_${SHOT}_1.png`].sort());
  const e = (await store.readStatus(gid)).test_evidence;
  assert.equal(e.length, 1);
  assert.equal(typeof e[0].files.original, "object");
  assert.equal(e[0].files.marked, undefined);

  // 同資料夾沿用同名（真實資料、舊格式殘留 _原始）時，殘留檔也要被清掉。
  const gid2 = await newTicket();
  const dir2 = path.join(ticketDir(gid2), "test-evidence", "report_export");
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, "a_原始.xlsx"), "old");
  assert.equal((await rec(gid2, {})).isError, false);
  assert.deepEqual(fs.readdirSync(dir2), ["a.xlsx"]);
});

test("a failing delete of an old backup (EBUSY) never fails the call; the next call retries the cleanup", async () => {
  const gid = await newTicket();
  const dir = path.join(ticketDir(gid), "test-evidence", "report_export");
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ["a_原始.xlsx", "a_假資料標註.xlsx", "~$a_原始.xlsx"]) fs.writeFileSync(path.join(dir, n), n);
  const busy = new Set(["a_原始.xlsx", "~$a_原始.xlsx"]);
  setEvidenceRemoverForTest(async (abs) => {
    if (busy.has(path.basename(abs))) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    fs.rmSync(abs, { force: true });
  });
  try {
    const r = await rec(gid, { usesFakeData: true, markedFile: mk("m.xlsx", "new"), fakeDataMarked: true });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.success, true);
    const warned = r.json.cleanupWarnings.map((w) => w.path);
    assert.ok(warned.includes("test-evidence/report_export/a_原始.xlsx"), JSON.stringify(warned));
    assert.ok(warned.includes("test-evidence/report_export/~$a_原始.xlsx"));
    assert.ok(r.json.cleanupWarnings.every((w) => /Excel/.test(w.reason)));
    assert.match(r.json.message, /已登記，但有 2 個舊檔未能刪除/);
    // 新檔就位、status 已是新結構，沒被回滾
    const st = await store.readStatus(gid);
    assert.equal(st.test_evidence.length, 1);
    assert.equal(st.test_evidence[0].files.file, `test-evidence/${FAKE_DIR}report_export/a${FAKE_SUFFIX}.xlsx`);
    assert.equal(typeof st.test_evidence[0].files.original, "object");
    assert.ok(fs.existsSync(path.join(ticketDir(gid), st.test_evidence[0].files.file)));
    // 沒被占用的舊檔已刪；被占用的還在、舊資料夾因此保留
    assert.ok(!fs.existsSync(path.join(dir, "a_假資料標註.xlsx")));
    assert.ok(fs.existsSync(path.join(dir, "a_原始.xlsx")));
    // get_ticket_status 提示有未清理的舊備份
    const status = await call("get_ticket_status", { taskGid: gid });
    assert.equal(status.json.test_evidence.stale_old_backups.count, 2);
    assert.match(status.json.test_evidence.stale_old_backups.hint, /record_test_evidence/);

    // 仍被占用：再呼叫仍成功、警告仍在（冪等）
    const again = await rec(gid, { usesFakeData: true, markedFile: mk("m.xlsx", "new"), fakeDataMarked: true });
    assert.equal(again.json.success, true);
    assert.equal(again.json.cleanupWarnings.length, 2);
    assert.equal((await store.readStatus(gid)).test_evidence.length, 1);
  } finally {
    setEvidenceRemoverForTest(null);
  }
  // 解除占用後再呼叫：舊檔、鎖定檔、空資料夾都清掉，警告消失
  const done = await rec(gid, { usesFakeData: true, markedFile: mk("m.xlsx", "new"), fakeDataMarked: true });
  assert.equal(done.json.success, true);
  assert.deepEqual(done.json.cleanupWarnings, []);
  assert.doesNotMatch(done.json.message, /舊檔未能刪除/);
  assert.deepEqual(fs.readdirSync(path.join(ticketDir(gid), "test-evidence")), [`${FAKE_DIR}report_export`]);
  const status2 = await call("get_ticket_status", { taskGid: gid });
  assert.equal(status2.json.test_evidence.stale_old_backups, undefined);
});

test("cleanup does not touch other evidences' files in the same folder", async () => {
  const gid = await newTicket();
  const dir = path.join(ticketDir(gid), "test-evidence", "report_export");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "other_原始.xlsx"), "keep");
  fs.writeFileSync(path.join(dir, "a_原始.xlsx"), "drop");
  assert.equal((await rec(gid, {})).json.success, true);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["a.xlsx", "other_原始.xlsx"]);
});

test("usesFakeData without markedFile or fakeDataMarked is rejected (excel)", async () => {
  const gid = await newTicket();
  assert.equal((await rec(gid, { usesFakeData: true })).isError, true);
  assert.equal((await rec(gid, { usesFakeData: true, markedFile: mk("m.xlsx") })).isError, true);
  assert.equal((await rec(gid, { usesFakeData: true, markedFile: mk("m.xlsx"), fakeDataMarked: false })).isError, true);
  assert.equal((await rec(gid, { usesFakeData: false, markedFile: mk("m.xlsx") })).isError, true);
  assert.equal((await store.readStatus(gid)).test_evidence.length, 0);
});

test("pdf requires at least one screenshot; excel does not", async () => {
  const gid = await newTicket();
  const pdf = { fileKind: "pdf", sourceFile: mk("r.pdf") };
  assert.equal((await rec(gid, pdf)).isError, true);
  assert.equal((await rec(gid, { ...pdf, screenshotPaths: [mk("p1.png")] })).isError, false);
  assert.equal((await rec(gid, { featureName: "other", screenshotPaths: [] })).isError, false);
});

test("excel without screenshot is pending, 04-test.md gets an automatic todo, supplementing clears it", async () => {
  const gid = await newTicket();
  const r = await rec(gid, {});
  assert.equal(r.json.evidence.pendingManualScreenshot, true);
  const w = await art(gid, { manualActions: ["keep me"] });
  assert.equal(w.isError, false, w.text);
  let st = await store.readStatus(gid);
  assert.equal(st.test_manual_actions[0], "keep me");
  const auto = st.test_manual_actions.filter((a) => a.startsWith(ACTION_PREFIX));
  assert.equal(auto.length, 1);
  assert.match(auto[0], new RegExp(`\\.asana-pipeline/Proj/T-ev\\d+/test-evidence/report_export/a\\.xlsx`));
  assert.ok(auto[0].endsWith("：report export"));
  const status = await call("get_ticket_status", { taskGid: gid });
  assert.equal(status.json.test_evidence.pending_manual_screenshot, 1);
  assert.match(status.json.nextAction.summary, /Excel/);

  // 再寫一次 04（帶舊的自動待辦）不會重複
  const again = await art(gid, { manualActions: st.test_manual_actions });
  assert.equal(again.isError, false);
  st = await store.readStatus(gid);
  assert.equal(st.test_manual_actions.filter((a) => a.startsWith(ACTION_PREFIX)).length, 1);

  const fix = await rec(gid, { screenshotPaths: [mk("shot.png")] });
  assert.equal(fix.json.evidence.pendingManualScreenshot, false);
  st = await store.readStatus(gid);
  assert.equal(st.test_evidence.length, 1, "same feature + same file name updates the same record");
  assert.deepEqual(st.test_manual_actions, ["keep me"]);
});

test("04-test.md gates: producesOfficeFiles, testLevel, evidence, heading, feature name, level text, level consistency", async () => {
  const gid = await newTicket();
  const noFlag = await art(gid, { producesOfficeFiles: undefined });
  assert.equal(noFlag.isError, true);
  assert.match(noFlag.json.message, /producesOfficeFiles/);
  const noLevel = await art(gid, { testLevel: undefined });
  assert.equal(noLevel.isError, true);
  assert.match(noLevel.json.message, /testLevel/);
  const noEvidence = await art(gid);
  assert.equal(noEvidence.isError, true);
  assert.match(noEvidence.json.message, /record_test_evidence/);

  await rec(gid, { fileKind: "api-call", sourceFile: mk("call.txt", "POST /x\nHTTP/1.1 200 OK"), testLevel: "live-api" });
  const low = await art(gid, { testLevel: "unit-mock" });
  assert.equal(low.isError, true, "declared lower than evidence");
  assert.match(low.json.message, /live-api/);
  const live = { testLevel: "live-api" };
  const office = await art(gid, { ...live, content: `PASS\n${HEADING}\nreport export live-api`, producesOfficeFiles: true });
  assert.equal(office.isError, true, "no office evidence");
  assert.match((await art(gid, { ...live, content: "PASS\nreport export live-api" })).json.message, /測試證據/);
  assert.match((await art(gid, { ...live, content: `PASS\n${HEADING}\nlive-api` })).json.message, /report export/);
  assert.match((await art(gid, { ...live, content: `PASS\n${HEADING}\nreport export` })).json.message, /live-api/);
  const ok = await art(gid, { ...live, content: `PASS\n${HEADING}\nreport export live-api` });
  assert.equal(ok.isError, false, ok.text);
  const st = await store.readStatus(gid);
  assert.equal(st.test_level, "live-api");
  assert.equal(st.test_produces_office_files, false);
});

test("04-test.md must say 假資料 when any evidence uses fake data", async () => {
  const gid = await newTicket();
  await rec(gid, { fileKind: "api-call", sourceFile: mk("fk.txt", `${LABEL}\nPOST /x`), usesFakeData: true, testLevel: "live-api" });
  const body = `PASS\n${HEADING}\nreport export live-api`;
  const bad = await art(gid, { testLevel: "live-api", content: body });
  assert.equal(bad.isError, true);
  assert.match(bad.json.message, /假資料/);
  const ok = await art(gid, { testLevel: "live-api", content: `${body}\n資料來源：假資料` });
  assert.equal(ok.isError, false, ok.text);
});

test("a declared level higher than the evidence is rejected too (declared must equal the highest)", async () => {
  const gid = await newTicket();
  await rec(gid, { fileKind: "test-report", sourceFile: mk("t.xml", "<testsuite/>"), testLevel: "unit-mock" });
  const over = await art(gid, { testLevel: "integration-db", content: `PASS\n${HEADING}\nreport export integration-db` });
  assert.equal(over.isError, true);
});

test("advance to tested is blocked without evidence / testLevel / office evidence", async () => {
  const gid = await newTicket();
  await store.writeArtifact(gid, "04-test.md", "body");
  const none = await call("advance_ticket_stage", { taskGid: gid, stage: "tested", verdict: "PASS" });
  assert.equal(none.isError, true);
  assert.match(none.json.message, /record_test_evidence/);

  await rec(gid, {});
  const noLevel = await call("advance_ticket_stage", { taskGid: gid, stage: "tested", verdict: "PASS" });
  assert.equal(noLevel.isError, true);
  assert.match(noLevel.json.message, /testLevel/);

  await art(gid, { producesOfficeFiles: true });
  const pass = await call("advance_ticket_stage", { taskGid: gid, stage: "tested", verdict: "PASS" });
  assert.equal(pass.isError, false, pass.text);

  const gid2 = await newTicket();
  await rec(gid2, { fileKind: "db-state", sourceFile: mk("d.csv", "a,b\n1,2"), testLevel: "integration-db" });
  await art(gid2, { testLevel: "integration-db", content: `PASS\n${HEADING}\nreport export integration-db` });
  await store.updateStatus(gid2, (s) => ({ ...s, test_produces_office_files: true }));
  const blocked = await call("advance_ticket_stage", { taskGid: gid2, stage: "tested", verdict: "PASS" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.json.message, /excel/);
});

test("feature names are sanitized (.., separators, Windows-invalid chars, length) and stay inside the ticket dir", async () => {
  const gid = await newTicket();
  const dirs = [];
  for (const name of ["..\\..\\evil", "../../evil", 'a:b*c?d"e<f>g|h', "x".repeat(200), "CON"]) {
    const r = await rec(gid, { featureName: name });
    assert.equal(r.isError, false, `${name}: ${r.text}`);
    dirs.push(path.dirname(r.json.evidence.files.file));
  }
  const root = path.join(ticketDir(gid), "test-evidence");
  for (const d of dirs) {
    assert.doesNotMatch(d, /\.\./);
    assert.ok(path.resolve(ticketDir(gid), d).startsWith(root + path.sep), d);
  }
  assert.ok(fs.readdirSync(root).every((n) => n.length <= 60 && !/[:*?"<>|]/.test(n)));
  assert.ok(!fs.existsSync(path.join(ticketDir(gid), "evil")));
  for (const bad of ["..", "...", "  ", "/", "\\"]) assert.equal((await rec(gid, { featureName: bad })).isError, true, bad);
});

test("extension whitelist, missing file, directory, relative path, oversize and symlink are rejected", async () => {
  const gid = await newTicket();
  assert.equal((await rec(gid, { sourceFile: mk("a.csv") })).isError, true);
  assert.equal((await rec(gid, { fileKind: "pdf", sourceFile: mk("a.xlsx"), screenshotPaths: [mk("s.png")] })).isError, true);
  assert.equal((await rec(gid, { fileKind: "api-call", sourceFile: mk("a.xlsx") })).isError, true);
  assert.equal((await rec(gid, { fileKind: "db-state", sourceFile: mk("a.xml") })).isError, true);
  assert.equal((await rec(gid, { fileKind: "test-report", sourceFile: mk("a.csv") })).isError, true);
  assert.equal((await rec(gid, { screenshotPaths: [mk("s.gif")] })).isError, true);
  assert.equal((await rec(gid, { sourceFile: path.join(srcDir, "nope.xlsx") })).isError, true);
  assert.equal((await rec(gid, { sourceFile: srcDir })).isError, true);
  assert.equal((await rec(gid, { sourceFile: "a.xlsx" })).isError, true);
  const big = path.join(srcDir, "big.xlsx");
  fs.writeFileSync(big, Buffer.alloc(50 * 1024 * 1024 + 1));
  assert.equal((await rec(gid, { sourceFile: big })).isError, true);
  const link = path.join(srcDir, "link.xlsx");
  try {
    fs.symlinkSync(mk("real.xlsx"), link);
    assert.equal((await rec(gid, { sourceFile: link })).isError, true);
  } catch (err) {
    if (err.code !== "EPERM") throw err;
  }
  assert.equal((await store.readStatus(gid)).test_evidence.length, 0);
});

test("text evidence: new kinds work with their extensions and screenshots are optional (no pending flag)", async () => {
  const gid = await newTicket();
  const combos = [
    ["api-call", "c.json"], ["api-call", "c.http"], ["api-call", "c.md"],
    ["test-report", "t.html"], ["test-report", "t.json"], ["db-state", "d.txt"], ["db-state", "d.md"],
  ];
  for (const [kind, file] of combos) {
    const r = await rec(gid, { featureName: `${kind}-${file}`, fileKind: kind, sourceFile: mk(file, "ok"), testLevel: "integration-db" });
    assert.equal(r.isError, false, `${kind} ${file}: ${r.text}`);
    assert.equal(r.json.evidence.pendingManualScreenshot, false);
  }
});

test("secret scan rejects unmasked secrets with file and line only, never echoing the secret", async () => {
  const gid = await newTicket();
  const secret = "SuperSecretValue123456";
  const jwt = "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f";
  const cases = {
    bearer: `GET /x\nAuthorization: Bearer ${secret}\n`,
    jwt: `{"t":"${jwt}"}\n`,
    password: `ok\nok\n"password": "${secret}"\n`,
    pwd: `pwd=${secret}\n`,
    token: `url?token=${secret}\n`,
    conn: `postgres://user:${secret}@host/db\n`,
  };
  for (const [name, text] of Object.entries(cases)) {
    for (const kind of ["api-call", "db-state", "test-report"]) {
      const ext = kind === "db-state" ? ".csv" : ".txt";
      const r = await rec(gid, { fileKind: kind, sourceFile: mk(`${name}${ext}`, text), testLevel: "live-api" });
      assert.equal(r.isError, true, `${kind}/${name}`);
      assert.ok(r.json.message.includes(`${name}${ext}`));
      assert.match(r.json.message, /第 \d+ 行/);
      assert.ok(!r.text.includes(secret) && !r.text.includes(jwt), `${kind}/${name} leaked`);
    }
  }
  const line3 = await rec(gid, { fileKind: "api-call", sourceFile: mk("l.txt", "ok\nok\npwd=abc123\n"), testLevel: "live-api" });
  assert.match(line3.json.message, /第 3 行/);
  const masked = `Authorization: Bearer ****\n{"password": "****", "token": "<redacted>"}\nHTTP/1.1 200 OK\n`;
  const okRes = await rec(gid, { fileKind: "api-call", sourceFile: mk("masked.txt", masked), testLevel: "live-api" });
  assert.equal(okRes.isError, false, okRes.text);
  assert.equal((await store.readStatus(gid)).test_evidence.length, 1);
});

test("fake data on api-call/db-state: first non-blank line must be the label; test-report only records the flag", async () => {
  const gid = await newTicket();
  const fake = { usesFakeData: true, testLevel: "live-api" };
  const bad = await rec(gid, { ...fake, fileKind: "api-call", sourceFile: mk("f1.txt", `POST /x\n${LABEL}\n`) });
  assert.equal(bad.isError, true);
  assert.ok(bad.json.message.includes(LABEL));
  const good = await rec(gid, { ...fake, fileKind: "api-call", sourceFile: mk("f2.txt", `\n  \n${LABEL}\nPOST /x\n`) });
  assert.equal(good.isError, false, good.text);
  const dbBad = await rec(gid, { ...fake, fileKind: "db-state", featureName: "db", sourceFile: mk("f3.csv", `x\n${LABEL}\n`) });
  assert.equal(dbBad.isError, true);
  const dbGood = await rec(gid, { ...fake, fileKind: "db-state", featureName: "db", sourceFile: mk("f3.csv", `${LABEL}\na,b\n`) });
  assert.equal(dbGood.isError, false);
  const report = await rec(gid, { ...fake, fileKind: "test-report", featureName: "rep", sourceFile: mk("f4.xml", "<testsuite/>") });
  assert.equal(report.isError, false, report.text);
  const st = await store.readStatus(gid);
  const repRec = st.test_evidence.find((e) => e.featureName === "rep");
  assert.equal(repRec.usesFakeData, true);
  assert.equal(repRec.files.marked, undefined);
  assert.match(repRec.files.file, /【假資料】rep\/f4_假資料\.xml$/);
});

test("unknown fileKind / testLevel, missing testLevel and unsnapshotted tickets are rejected", async () => {
  const gid = await newTicket();
  assert.equal((await rec(gid, { fileKind: "word" })).isError, true);
  assert.equal((await rec(gid, { testLevel: "e2e" })).isError, true);
  assert.equal((await rec(gid, { testLevel: undefined })).isError, true);
  assert.equal((await rec("no-such-ticket", {})).isError, true);
});

test("get_ticket_status summarizes evidence compactly with per-item testLevel", async () => {
  const gid = await newTicket();
  for (let i = 0; i < 25; i++) {
    const level = i === 3 ? "live-api" : "unit-mock";
    await rec(gid, { featureName: `f${i}`, fileKind: "test-report", sourceFile: mk(`r${i}.xml`, "<t/>"), testLevel: level });
  }
  const s = (await call("get_ticket_status", { taskGid: gid })).json.test_evidence;
  assert.equal(s.count, 25);
  assert.equal(s.highest_evidence_level, "live-api");
  assert.equal(s.items.length, 20);
  assert.equal(s.truncated, 5);
  assert.deepEqual(Object.keys(s.items[0]).sort(), ["featureName", "fileKind", "pendingManualScreenshot", "testLevel", "usesFakeData"]);
});
