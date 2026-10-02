// 本機局部重建 PENDING_HUMAN_ACTIONS.html：使用者勾了「請 AI 優先處理」之後，重建不能把那張票弄丟或弄回可勾選；
// 「內容已被異動」清單只列指派人是 pipeline 帳號本人的票。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir, isolateDataDir } from "./helpers/support.mjs";
import { assignTicketDir, recordProjectContext, advanceStage, requestReanalysis } from "../dist/pipeline-store.js";
import { syncPendingActionsReport } from "../dist/pending-actions-sync.js";

const data = isolateDataDir();
// 重建流程會順手查 pipeline 帳號 gid（會 spawn 真的 asana-mcp 子行程）；指到不存在的檔案讓它立刻連線失敗，
// 這裡測的條件不需要 gid，不打網路、不碰真實 Asana。
const previousAsanaPath = process.env.ASANA_MCP_PATH;
const previousUserGid = process.env.PIPELINE_ASANA_USER_GID;
process.env.ASANA_MCP_PATH = path.join(data.dir, "no-such-asana-mcp.js");
const ME = "gid-pipeline-user";
const SOMEONE_ELSE = "gid-someone-else";
process.env.PIPELINE_ASANA_USER_GID = ME;
test.after(() => {
  if (previousAsanaPath === undefined) delete process.env.ASANA_MCP_PATH;
  else process.env.ASANA_MCP_PATH = previousAsanaPath;
  if (previousUserGid === undefined) delete process.env.PIPELINE_ASANA_USER_GID;
  else process.env.PIPELINE_ASANA_USER_GID = previousUserGid;
  data.cleanup();
});

const PROJECT_NAME = "Sync Test Project";
const PROJECT_FOLDER = "Sync_Test_Project"; // sanitizeSegment 會把空白換成底線

async function setupTicket(projectDir, gid, stage, patch = {}, assigneeGid = ME) {
  await assignTicketDir(projectDir, gid, PROJECT_NAME, null, null, `Ticket ${gid}`);
  await recordProjectContext(gid, projectDir, PROJECT_NAME, `Ticket ${gid}`, assigneeGid, false);
  await advanceStage(gid, stage, patch);
}

function readReport(projectDir) {
  return fs.readFileSync(path.join(projectDir, ".asana-pipeline", PROJECT_FOLDER, "PENDING_HUMAN_ACTIONS.html"), "utf-8");
}

test("human-requested ticket stays in the changed list as a read-only row after resync", async () => {
  const projectDir = makeTmpDir("dpm-sync-");
  try {
    // verified + needs_reanalysis=false：靠 Asana modified_at 被偵測到的票（本機重建看不到 modified_at）
    await setupTicket(projectDir, "9001", "verified", { verdict: "PASS", needs_reanalysis: false });
    await requestReanalysis("9001");
    await syncPendingActionsReport("9001");

    const html = readReport(projectDir);
    assert.match(html, /readonly-row stale/);
    assert.match(html, /已標記「請 AI 優先處理」/);
    assert.doesNotMatch(html, /data-request-reanalysis data-taskgid="9001"/);
  } finally {
    removeDir(projectDir);
  }
});

test("human-requested tested+PASS ticket is not swallowed by the awaiting-confirmation branch", async () => {
  const projectDir = makeTmpDir("dpm-sync-");
  try {
    await setupTicket(projectDir, "9002", "tested", { verdict: "PASS", needs_reanalysis: false });
    await requestReanalysis("9002");
    await syncPendingActionsReport("9002");

    const html = readReport(projectDir);
    assert.match(html, /readonly-row stale/);
    assert.doesNotMatch(html, /data-confirm-yes[^>]*data-taskgid="9002"/);
  } finally {
    removeDir(projectDir);
  }
});

test("ticket without the human request is not listed as changed", async () => {
  const projectDir = makeTmpDir("dpm-sync-");
  try {
    await setupTicket(projectDir, "9003", "verified", { verdict: "PASS", needs_reanalysis: false });
    await syncPendingActionsReport("9003");

    const html = readReport(projectDir);
    assert.doesNotMatch(html, /readonly-row stale/);
    assert.doesNotMatch(html, /data-request-reanalysis data-taskgid="9003"/);
  } finally {
    removeDir(projectDir);
  }
});

test("needs_reanalysis ticket assigned to the pipeline user is listed as a checkable changed row", async () => {
  const projectDir = makeTmpDir("dpm-sync-");
  try {
    await setupTicket(projectDir, "9004", "verified", { verdict: "PASS", needs_reanalysis: true });
    await syncPendingActionsReport("9004");

    const html = readReport(projectDir);
    assert.match(html, /data-request-reanalysis data-taskgid="9004"/);
  } finally {
    removeDir(projectDir);
  }
});

test("needs_reanalysis ticket assigned to someone else is not listed", async () => {
  const projectDir = makeTmpDir("dpm-sync-");
  try {
    await setupTicket(projectDir, "9005", "verified", { verdict: "PASS", needs_reanalysis: true }, SOMEONE_ELSE);
    await syncPendingActionsReport("9005");

    const html = readReport(projectDir);
    assert.doesNotMatch(html, /data-request-reanalysis data-taskgid="9005"/);
    assert.doesNotMatch(html, /readonly-row stale/);
  } finally {
    removeDir(projectDir);
  }
});

test("human-requested ticket reassigned to someone else drops out of the changed list", async () => {
  const projectDir = makeTmpDir("dpm-sync-");
  try {
    await setupTicket(projectDir, "9006", "verified", { verdict: "PASS", needs_reanalysis: true }, SOMEONE_ELSE);
    await requestReanalysis("9006");
    await syncPendingActionsReport("9006");

    const html = readReport(projectDir);
    assert.doesNotMatch(html, /readonly-row stale/);
    assert.doesNotMatch(html, /data-request-reanalysis data-taskgid="9006"/);
  } finally {
    removeDir(projectDir);
  }
});

test("tested+PASS ticket assigned to someone else still goes to awaiting confirmation even with the human request", async () => {
  const projectDir = makeTmpDir("dpm-sync-");
  try {
    await setupTicket(projectDir, "9007", "tested", { verdict: "PASS", needs_reanalysis: false }, SOMEONE_ELSE);
    await requestReanalysis("9007");
    await syncPendingActionsReport("9007");

    const html = readReport(projectDir);
    assert.doesNotMatch(html, /readonly-row stale/);
    assert.match(html, /data-confirm-yes[^>]*data-taskgid="9007"|data-taskgid="9007"[^>]*data-confirm-yes/);
  } finally {
    removeDir(projectDir);
  }
});
