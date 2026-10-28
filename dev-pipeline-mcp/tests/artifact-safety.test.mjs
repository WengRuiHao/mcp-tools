// read/write_ticket_artifact 的路徑逃逸防護、讀取失敗原因、summary 強制與寫入失敗順序。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir, isolateDataDir, connectClient, callTool } from "./helpers/support.mjs";

const iso = isolateDataDir();
const tmp = makeTmpDir("dpm-artsafe-");
const projectDir = path.join(tmp, "proj");

const store = await import("../dist/pipeline-store.js");
const { registerTicketArtifactTools } = await import("../dist/ticket-artifact-tools.js");

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
async function newTicket(gid) {
  await store.assignTicketDir(projectDir, gid, "Proj", `T-${gid}`);
  await store.advanceStage(gid, "snapshot", {});
  return path.join(projectDir, ".asana-pipeline", "Proj", `T-${gid}`);
}

test("resolveArtifactPath rejects .., absolute paths and accepts plain names", () => {
  const dir = path.join(tmp, "d");
  assert.equal(store.resolveArtifactPath(dir, "ticket.md"), path.resolve(dir, "ticket.md"));
  for (const bad of ["../x.md", "a/../../x.md", "..\\x.md", "/etc/passwd", "C:\\Windows\\win.ini", "C:foo", "\\\\srv\\share\\f", "", "  ", "a\u0000b", "."]) {
    assert.throws(() => store.resolveArtifactPath(dir, bad), store.ArtifactPathError, JSON.stringify(bad));
  }
});

test("read_ticket_artifact: path escape is refused with reason invalid_path and secret not leaked", async () => {
  const gid = "sec1";
  const dir = await newTicket(gid);
  const secret = path.join(path.dirname(dir), "secret.txt");
  fs.writeFileSync(secret, "TOPSECRET");
  for (const fname of ["../secret.txt", secret, "..\\secret.txt"]) {
    const r = await call("read_ticket_artifact", { taskGid: gid, filename: fname });
    assert.equal(r.isError, true, fname);
    assert.equal(r.json.success, false);
    assert.equal(r.json.content, null);
    assert.equal(r.json.reason, "invalid_path");
    assert.ok(!r.text.includes("TOPSECRET"));
  }
});

test("read_ticket_artifact: distinguishes missing file / no ticket dir / ok", async () => {
  const gid = "rd1";
  const dir = await newTicket(gid);
  const missing = await call("read_ticket_artifact", { taskGid: gid, filename: "01-analysis.md" });
  assert.equal(missing.json.success, false);
  assert.equal(missing.json.reason, "not_found");
  assert.match(missing.json.message, /01-analysis\.md/);

  const nodir = await call("read_ticket_artifact", { taskGid: "never-snapshotted", filename: "ticket.md" });
  assert.equal(nodir.json.success, false);
  assert.equal(nodir.json.reason, "no_ticket_dir");
  assert.match(nodir.json.message, /get_ticket_snapshot/);

  fs.writeFileSync(path.join(dir, "ticket.md"), "hello");
  const ok = await call("read_ticket_artifact", { taskGid: gid, filename: "ticket.md" });
  assert.equal(ok.isError, false);
  assert.deepEqual([ok.json.success, ok.json.content], [true, "hello"]);
});

test("write_ticket_artifact: missing or blank summary is rejected and nothing is written", async () => {
  const gid = "sum1";
  const dir = await newTicket(gid);
  for (const summary of [undefined, null, "", "   "]) {
    const r = await call("write_ticket_artifact", { taskGid: gid, filename: "03-verification.md", content: "x", summary, syncNote: "NO_SYNC_NEEDED", manualActions: [] });
    assert.equal(r.isError, true);
    assert.match(r.json.message, /summary/);
  }
  assert.ok(!fs.existsSync(path.join(dir, "03-verification.md")));
});

test("write_ticket_artifact: record failure after file write reports fileWritten + resync hint", async () => {
  const gid = "ord1";
  const dir = await newTicket(gid);
  // 讓 status.json 變成壞掉的 JSON，recordArtifactHash 會失敗，但檔案先寫入。
  const upstream = path.join(dir, "02-implementation.md");
  fs.writeFileSync(upstream, "impl");
  const statusFile = fs.readdirSync(dir).find((f) => f === "status.json");
  assert.ok(statusFile, "status.json expected in ticket dir");
  const statusPath = path.join(dir, statusFile);
  const original = fs.readFileSync(statusPath, "utf-8");
  // 先通過 readStatus（無需讀的路徑）：03 不需要任何前置 gate，直接破壞 status 檔。
  fs.writeFileSync(statusPath, "{not json");
  const r = await call("write_ticket_artifact", { taskGid: gid, filename: "03-verification.md", content: "verified", summary: "s", syncNote: "NO_SYNC_NEEDED", manualActions: [] });
  fs.writeFileSync(statusPath, original);
  assert.equal(r.isError, true);
  assert.equal(r.json.fileWritten, true);
  assert.match(r.json.message, /resync_ticket_artifact/);
  assert.equal(fs.readFileSync(path.join(dir, "03-verification.md"), "utf-8"), "verified");
});

test("write_ticket_artifact: file write failure leaves status untouched and says so", async () => {
  const gid = "wf1";
  const dir = await newTicket(gid);
  fs.mkdirSync(path.join(dir, "03-verification.md")); // 同名目錄 → writeFile 會 EISDIR
  const before = (await store.readStatus(gid)).sync;
  const r = await call("write_ticket_artifact", { taskGid: gid, filename: "03-verification.md", content: "v", summary: "s", syncNote: "NO_SYNC_NEEDED", manualActions: [] });
  assert.equal(r.isError, true);
  assert.match(r.json.message, /沒有變動/);
  assert.deepEqual((await store.readStatus(gid)).sync, before);
});
