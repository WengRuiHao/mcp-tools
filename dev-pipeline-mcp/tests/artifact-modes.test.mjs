// write_ticket_artifact 的 mode（append/replace）與 filePath；read_ticket_artifact 的 filePath。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeTmpDir, removeDir, isolateDataDir, connectClient, callTool } from "./helpers/support.mjs";

const iso = isolateDataDir();
const tmp = makeTmpDir("dpm-artmode-");
const projectDir = path.join(tmp, "proj");

// DEV_PIPELINE_TEST_DIST 可指向 tsc --outDir 的暫存輸出（預設 ../dist）
const dist = process.env.DEV_PIPELINE_TEST_DIST
  ? path.resolve(process.env.DEV_PIPELINE_TEST_DIST)
  : path.resolve(import.meta.dirname, "../dist");
const load = (f) => import(pathToFileURL(path.join(dist, f)).href);
const store = await load("pipeline-store.js");
const { registerTicketArtifactTools } = await load("ticket-artifact-tools.js");

let ctx;
before(async () => {
  ctx = await connectClient((s) => registerTicketArtifactTools(s));
});
after(async () => {
  await ctx.close();
  iso.cleanup();
  removeDir(tmp);
});

const call = (name, args) => callTool(ctx.client, name, args);
const SYNC = { syncNote: "NO_SYNC_NEEDED", manualActions: [] };

async function newTicket(gid, { project = "Proj", name = `T-${gid}`, sasd = true } = {}) {
  await store.assignTicketDir(projectDir, gid, project, name);
  await store.advanceStage(gid, "snapshot", { project_dir: projectDir, name, sasd_checked: sasd });
  return path.join(projectDir, ".asana-pipeline", project.replace(/\s+/g, "_"), name);
}
const write = (gid, filename, args) => call("write_ticket_artifact", { taskGid: gid, filename, ...args });

test("filePath: write and read return the absolute path, even when the project name has spaces", async () => {
  const dir = await newTicket("fp1", { project: "Demo 專案", name: "PROJ-1234" });
  const w = await write("fp1", "03-verification.md", { content: "hi", summary: "s", ...SYNC });
  assert.equal(w.isError, false, w.text);
  assert.ok(path.isAbsolute(w.json.filePath));
  assert.equal(path.resolve(w.json.filePath), path.resolve(dir, "03-verification.md"));
  assert.ok(w.json.filePath.includes("Demo_專案"));
  assert.equal(fs.readFileSync(w.json.filePath, "utf-8"), "hi");
  const r = await call("read_ticket_artifact", { taskGid: "fp1", filename: "03-verification.md" });
  assert.equal(r.json.filePath, w.json.filePath);
  assert.equal(r.json.content, "hi");
  const bad = await call("read_ticket_artifact", { taskGid: "fp1", filename: "nope.md" });
  assert.equal(bad.json.reason, "not_found");
  assert.equal(bad.json.filePath, undefined);
});

test("append: adds a newline only when needed; summary optional and existing summary kept", async () => {
  const gid = "ap1";
  const dir = await newTicket(gid);
  const f = path.join(dir, "03-verification.md");
  const first = await write(gid, "03-verification.md", { mode: "append", content: "A", summary: "first-summary", ...SYNC });
  assert.equal(first.isError, false, first.text);
  assert.equal(fs.readFileSync(f, "utf-8"), "A"); // 檔案不存在 → 等同建立
  const second = await write(gid, "03-verification.md", { mode: "append", content: "B", ...SYNC });
  assert.equal(second.isError, false, second.text);
  assert.equal(fs.readFileSync(f, "utf-8"), "A\nB");
  await write(gid, "03-verification.md", { mode: "append", content: "C\n", ...SYNC });
  await write(gid, "03-verification.md", { mode: "append", content: "D", ...SYNC });
  assert.equal(fs.readFileSync(f, "utf-8"), "A\nB\nC\nD");
  assert.match(JSON.stringify(await store.readStatus(gid)), /first-summary/);
  // 帶 summary 就更新
  await write(gid, "03-verification.md", { mode: "append", content: "E", summary: "updated-summary", ...SYNC });
  assert.match(JSON.stringify(await store.readStatus(gid)), /updated-summary/);
});

test("append: follows CRLF of an existing file", async () => {
  const gid = "ap2";
  const dir = await newTicket(gid);
  const f = path.join(dir, "03-verification.md");
  fs.writeFileSync(f, "a\r\nb");
  const r = await write(gid, "03-verification.md", { mode: "append", content: "c\nd", ...SYNC });
  assert.equal(r.isError, false, r.text);
  assert.equal(fs.readFileSync(f, "utf-8"), "a\r\nb\r\nc\r\nd");
});

test("replace: single line, multi line, deletion; existing summary kept", async () => {
  const gid = "rp1";
  const dir = await newTicket(gid);
  const f = path.join(dir, "03-verification.md");
  await write(gid, "03-verification.md", { content: "one\ntwo\nthree\nfour\n", summary: "orig-summary", ...SYNC });
  const a = await write(gid, "03-verification.md", { mode: "replace", oldString: "two", newString: "2$&", ...SYNC });
  assert.equal(a.isError, false, a.text);
  assert.equal(fs.readFileSync(f, "utf-8"), "one\n2$&\nthree\nfour\n"); // $& 不被當成替換樣式
  const b = await write(gid, "03-verification.md", { mode: "replace", oldString: "three\nfour", newString: "3\n4\n5", ...SYNC });
  assert.equal(b.isError, false, b.text);
  assert.equal(fs.readFileSync(f, "utf-8"), "one\n2$&\n3\n4\n5\n");
  assert.match(JSON.stringify(await store.readStatus(gid)), /orig-summary/);
  const r = await write(gid, "03-verification.md", { mode: "replace", oldString: "5\n", newString: "", ...SYNC });
  assert.equal(r.isError, false, r.text);
  assert.equal(fs.readFileSync(f, "utf-8"), "one\n2$&\n3\n4\n");
});

test("replace: CRLF file keeps CRLF, never mixes", async () => {
  const gid = "rp2";
  const dir = await newTicket(gid);
  const f = path.join(dir, "03-verification.md");
  fs.writeFileSync(f, "l1\r\nl2\r\nl3\r\n");
  const r = await write(gid, "03-verification.md", { mode: "replace", oldString: "l1\nl2", newString: "x\ny\nz", ...SYNC });
  assert.equal(r.isError, false, r.text);
  assert.equal(fs.readFileSync(f, "utf-8"), "x\r\ny\r\nz\r\nl3\r\n");
  // LF 檔案、oldString 帶 CRLF 也能比對
  fs.writeFileSync(f, "a\nb\n");
  const r2 = await write(gid, "03-verification.md", { mode: "replace", oldString: "a\r\nb", newString: "c\r\nd", ...SYNC });
  assert.equal(r2.isError, false, r2.text);
  assert.equal(fs.readFileSync(f, "utf-8"), "c\nd\n");
});

test("replace: 0 matches and multiple matches are refused with matchCount, file untouched", async () => {
  const gid = "rp3";
  const dir = await newTicket(gid);
  const f = path.join(dir, "03-verification.md");
  fs.writeFileSync(f, "dup dup\nx");
  const none = await write(gid, "03-verification.md", { mode: "replace", oldString: "zzz", newString: "q", ...SYNC });
  assert.equal(none.isError, true);
  assert.equal(none.json.matchCount, 0);
  const many = await write(gid, "03-verification.md", { mode: "replace", oldString: "dup", newString: "q", ...SYNC });
  assert.equal(many.isError, true);
  assert.equal(many.json.matchCount, 2);
  const empty = await write(gid, "03-verification.md", { mode: "replace", oldString: "", newString: "q", ...SYNC });
  assert.equal(empty.isError, true);
  const noNew = await write(gid, "03-verification.md", { mode: "replace", oldString: "x", ...SYNC });
  assert.equal(noNew.isError, true);
  assert.equal(fs.readFileSync(f, "utf-8"), "dup dup\nx");
});

test("replace on a missing file is refused and creates nothing", async () => {
  const gid = "rp4";
  const dir = await newTicket(gid);
  const r = await write(gid, "03-verification.md", { mode: "replace", oldString: "a", newString: "b", ...SYNC });
  assert.equal(r.isError, true);
  assert.match(r.json.message, /不存在/);
  assert.ok(!fs.existsSync(path.join(dir, "03-verification.md")));
});

test("gates run on the applied full content: 02 still needs syncNote/manualActions", async () => {
  const gid = "gt1";
  const dir = await newTicket(gid);
  const f = path.join(dir, "02-implementation.md");
  fs.writeFileSync(f, "impl v1");
  const noSync = await write(gid, "02-implementation.md", { mode: "replace", oldString: "v1", newString: "v2" });
  assert.equal(noSync.isError, true);
  assert.match(noSync.json.message, /syncNote/);
  const noManual = await write(gid, "02-implementation.md", { mode: "append", content: "x", syncNote: "NO_SYNC_NEEDED" });
  assert.equal(noManual.isError, true);
  assert.match(noManual.json.message, /manualActions/);
  assert.equal(fs.readFileSync(f, "utf-8"), "impl v1");
  const ok = await write(gid, "02-implementation.md", { mode: "replace", oldString: "v1", newString: "v2", ...SYNC });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(fs.readFileSync(f, "utf-8"), "impl v2");
});

test("gates.json analysis gate is checked against the content after replace/append", async () => {
  const gid = "gt2";
  await newTicket(gid, { name: "RPT01 report" });
  fs.mkdirSync(path.join(projectDir, ".pipeline"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "legacy/src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "legacy/src/A.java"), "class A {}");
  fs.writeFileSync(
    path.join(projectDir, ".pipeline", "gates.json"),
    JSON.stringify({ analysisReferences: [{ ticketNamePattern: "^RPT", heading: "Legacy Refs", pathPrefix: "legacy/" }] })
  );
  try {
    const good = await write(gid, "01-analysis.md", { content: "## Legacy Refs\n- legacy/src/A.java\n", summary: "s" });
    assert.equal(good.isError, false, good.text);
    const f = good.json.filePath;
    const bad = await write(gid, "01-analysis.md", { mode: "replace", oldString: "legacy/src/A.java", newString: "legacy/src/Nope.java" });
    assert.equal(bad.isError, true);
    assert.match(bad.json.message, /Nope\.java/);
    assert.equal(fs.readFileSync(f, "utf-8"), "## Legacy Refs\n- legacy/src/A.java\n");
    const app = await write(gid, "01-analysis.md", { mode: "append", content: "## Other\nmore" });
    assert.equal(app.isError, false, app.text);
  } finally {
    fs.rmSync(path.join(projectDir, ".pipeline"), { recursive: true, force: true });
  }
});

test("01 append still requires record_sasd_check", async () => {
  const gid = "gt3";
  const dir = await newTicket(gid, { sasd: false });
  const r = await write(gid, "01-analysis.md", { mode: "append", content: "x" });
  assert.equal(r.isError, true);
  assert.match(r.json.message, /record_sasd_check/);
  assert.ok(!fs.existsSync(path.join(dir, "01-analysis.md")));
});

test("overwrite is unchanged: content and summary still required", async () => {
  const gid = "ow1";
  const dir = await newTicket(gid);
  const noSummary = await write(gid, "03-verification.md", { content: "x", ...SYNC });
  assert.equal(noSummary.isError, true);
  assert.match(noSummary.json.message, /summary/);
  const noContent = await write(gid, "03-verification.md", { mode: "overwrite", summary: "s", ...SYNC });
  assert.equal(noContent.isError, true);
  assert.ok(!fs.existsSync(path.join(dir, "03-verification.md")));
  await write(gid, "03-verification.md", { content: "old", summary: "s", ...SYNC });
  const r = await write(gid, "03-verification.md", { mode: "overwrite", content: "new", summary: "s", ...SYNC });
  assert.equal(r.isError, false, r.text);
  assert.equal(fs.readFileSync(path.join(dir, "03-verification.md"), "utf-8"), "new");
});
