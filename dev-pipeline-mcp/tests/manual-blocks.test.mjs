// 「手動貼上內容」：從 02/03/04 文件抽出帶 manual 標記的程式碼區塊，顯示在 PENDING_HUMAN_ACTIONS.html 的待辦底下。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir, isolateDataDir } from "./helpers/support.mjs";
import {
  assignTicketDir,
  recordProjectContext,
  advanceStage,
  recordManualActions,
  resolveManualAction,
  writeArtifact,
  extractManualBlocks,
} from "../dist/pipeline-store.js";
import { syncPendingActionsReport } from "../dist/pending-actions-sync.js";

const data = isolateDataDir();
// 重建流程會順手查 pipeline 帳號 gid（會 spawn 真的 asana-mcp 子行程）；指到不存在的檔案讓它立刻連線失敗，不打網路。
const previousAsanaPath = process.env.ASANA_MCP_PATH;
process.env.ASANA_MCP_PATH = path.join(data.dir, "no-such-asana-mcp.js");
test.after(() => {
  if (previousAsanaPath === undefined) delete process.env.ASANA_MCP_PATH;
  else process.env.ASANA_MCP_PATH = previousAsanaPath;
  data.cleanup();
});

const FENCE = "```";
const PROJECT_NAME = "Manual Block Project";
const PROJECT_FOLDER = "Manual_Block_Project";
const ACTION_TEXT = "SQL pending manual run";

test("extract: only fenced blocks carrying the manual marker are returned", () => {
  const content = [
    "intro",
    `${FENCE}sql manual:Add options`,
    "INSERT INTO t VALUES (1);",
    FENCE,
    `${FENCE}java`,
    "class A {}",
    FENCE,
    `${FENCE}manual`,
    "plain paste",
    FENCE,
  ].join("\n");
  assert.deepEqual(extractManualBlocks(content), [
    { lang: "sql", title: "Add options", body: "INSERT INTO t VALUES (1);" },
    { lang: "", title: "手動貼上內容", body: "plain paste" },
  ]);
});

test("extract: CRLF documents and multi-line bodies are handled", () => {
  const content = `${FENCE}sql manual:Two lines\r\nSELECT 1;\r\nSELECT 2;\r\n${FENCE}\r\n`;
  assert.deepEqual(extractManualBlocks(content), [{ lang: "sql", title: "Two lines", body: "SELECT 1;\nSELECT 2;" }]);
});

test("extract: documents without a marked block return an empty list", () => {
  assert.deepEqual(extractManualBlocks("no code here"), []);
  assert.deepEqual(extractManualBlocks(`${FENCE}sql\nSELECT 1;\n${FENCE}`), []);
});

async function setupTicket(projectDir, gid, document) {
  await assignTicketDir(projectDir, gid, PROJECT_NAME, null, null, `Ticket ${gid}`);
  await recordProjectContext(gid, projectDir, PROJECT_NAME, `Ticket ${gid}`, null, false);
  await advanceStage(gid, "implemented");
  await writeArtifact(gid, "02-implementation.md", document);
  await recordManualActions(gid, "02-implementation.md", [ACTION_TEXT]);
}

const readReport = (projectDir) =>
  fs.readFileSync(path.join(projectDir, ".asana-pipeline", PROJECT_FOLDER, "PENDING_HUMAN_ACTIONS.html"), "utf-8");

test("report: marked block shows as a collapsible, copyable, escaped block under its ticket", async () => {
  const projectDir = makeTmpDir("dpm-blocks-");
  try {
    const sql = "SELECT '<b>' FROM t WHERE x = '{{TITLE}}' AND y > 1;";
    await setupTicket(projectDir, "9101", `# impl\n${FENCE}sql manual:Run me\n${sql}\n${FENCE}\n`);
    await syncPendingActionsReport("9101");

    const html = readReport(projectDir);
    assert.match(html, /<details class="manual-block">/);
    assert.match(html, /Run me <code>sql<\/code>/);
    assert.match(html, /data-copy/);
    assert.match(html, /SELECT &#39;&lt;b&gt;&#39; FROM t WHERE x = &#39;\{\{TITLE\}\}&#39; AND y &gt; 1;/);
    assert.doesNotMatch(html, /'<b>'/);
  } finally {
    removeDir(projectDir);
  }
});

test("report: ticket without a marked block gets no manual block row", async () => {
  const projectDir = makeTmpDir("dpm-blocks-");
  try {
    await setupTicket(projectDir, "9102", `# impl\n${FENCE}java\nclass A {}\n${FENCE}\n`);
    await syncPendingActionsReport("9102");

    const html = readReport(projectDir);
    assert.match(html, new RegExp(ACTION_TEXT));
    assert.doesNotMatch(html, /<details class="manual-block">/);
  } finally {
    removeDir(projectDir);
  }
});

test("report: block disappears together with the resolved manual action", async () => {
  const projectDir = makeTmpDir("dpm-blocks-");
  try {
    await setupTicket(projectDir, "9103", `${FENCE}sql manual:Run me\nSELECT 1;\n${FENCE}\n`);
    await syncPendingActionsReport("9103");
    assert.match(readReport(projectDir), /<details class="manual-block">/);

    await resolveManualAction("9103", "02-implementation.md", ACTION_TEXT);
    await syncPendingActionsReport("9103");
    assert.doesNotMatch(readReport(projectDir), /<details class="manual-block">/);
  } finally {
    removeDir(projectDir);
  }
});
