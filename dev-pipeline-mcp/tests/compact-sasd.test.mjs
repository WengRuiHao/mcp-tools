import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Temp data dir must be set before loading dist; nothing here talks to Asana.
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "compact-sasd-"));
const dataDir = path.join(tmpRoot, "data");
const projectDir = path.join(tmpRoot, "proj");
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(projectDir, { recursive: true });
process.env.ASANA_PIPELINE_DATA_DIR = dataDir;

const store = await import("../dist/pipeline-store.js");
const registry = await import("../dist/project-registry.js");
const { buildCompactStatus, sasdForStatus } = await import("../dist/stage-response.js");

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function ticketAtSdDrafted(taskGid, gid) {
  await store.assignTicketDir(projectDir, taskGid, "Proj", taskGid, null, "t");
  await store.recordProjectContext(taskGid, projectDir, "Proj", "t", null, false, gid);
  await store.advanceStage(taskGid, "sd_drafted");
  return store.readStatus(taskGid);
}

test("compact status uses the project's sdMode/specOrder when project_gid is recorded", async () => {
  await registry.registerSasdConfig("G-SF", { saRoot: "/sa", sdMode: "self-generated", sdRoot: null, sdOutputPath: "out", svnConnectionId: null, specOrder: "spec_first" });
  await registry.registerSasdConfig("G-CF", { saRoot: "/sa", sdMode: "self-generated", sdRoot: null, sdOutputPath: "out", svnConnectionId: null, specOrder: "code_first" });
  const sf = await buildCompactStatus("sf", await ticketAtSdDrafted("sf", "G-SF"));
  const cf = await buildCompactStatus("cf", await ticketAtSdDrafted("cf", "G-CF"));
  assert.ok(sf.nextAction.blockedBy.some((b) => b.includes("implemented") && !b.includes("verified")));
  assert.ok(cf.nextAction.blockedBy.some((b) => b.includes("verified") && !b.includes("implemented")));
});

test("without project_gid the compact status keeps the generic advice", async () => {
  const status = await ticketAtSdDrafted("nogid", null);
  assert.equal(await sasdForStatus(status), null);
  const compact = await buildCompactStatus("nogid", status);
  assert.ok(compact.nextAction.blockedBy.some((b) => b.includes("implemented") && b.includes("verified")));
});

test("an unregistered project_gid also falls back to the generic advice", async () => {
  const status = await ticketAtSdDrafted("unreg", "G-DOES-NOT-EXIST");
  assert.equal(await sasdForStatus(status), null);
});
