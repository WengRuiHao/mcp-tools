// 報告頁上「編輯 SVN 上的規格書」連結：只組連結、只在規格書真的放在 SVN 上的專案顯示。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir, isolateDataDir } from "./helpers/support.mjs";

const data = isolateDataDir();
// 重建報告會順手查 pipeline 帳號 gid（會 spawn 真的 asana-mcp 子行程）；直接指定，不去碰真實 Asana。
process.env.PIPELINE_ASANA_USER_GID = "gid-test-user";
const BS = String.fromCharCode(92);
test.after(() => {
  delete process.env.SVN_EDIT_PORT;
  data.cleanup();
});

const { buildSvnEditLink, renderSvnEditSection, resolveSvnEditPort } = await import("../dist/svn-edit-link.js");

const cfg = (patch = {}) => ({ saRoot: "doc/sa", sdMode: "external", sdRoot: "doc/sd", sdOutputPath: null, svnConnectionId: "conn-1", specOrder: null, ...patch });

test("external／self 專案：連結帶連線與起始目錄（sdRoot 優先），預設埠 8096", () => {
  delete process.env.SVN_EDIT_PORT;
  const link = buildSvnEditLink(cfg());
  assert.equal(link.url, "http://127.0.0.1:8096/?connection=conn-1&browse=doc%2Fsd");
  assert.equal(link.connection, "conn-1");
  assert.equal(link.startDir, "doc/sd");
  assert.equal(buildSvnEditLink(cfg({ sdMode: "self" })).startDir, "doc/sd");
});

test("沒有 sdRoot 就用 saRoot；斜線與反斜線都會整理，中文會編碼", () => {
  assert.equal(buildSvnEditLink(cfg({ sdRoot: null })).startDir, "doc/sa");
  assert.equal(buildSvnEditLink(cfg({ sdRoot: `/規格書${BS}SD/` })).startDir, "規格書/SD");
  assert.match(buildSvnEditLink(cfg({ sdRoot: "規格書" })).url, /browse=%E8%A6%8F%E6%A0%BC%E6%9B%B8$/);
  assert.equal(buildSvnEditLink(cfg({ sdRoot: null, saRoot: "" })).startDir, ""); // 都沒有就從連線根目錄開始
});

test("埠號跟著 SVN_EDIT_PORT；設定不合法就退回預設", () => {
  process.env.SVN_EDIT_PORT = "9123";
  assert.equal(resolveSvnEditPort(), 9123);
  assert.match(buildSvnEditLink(cfg()).url, /^http:\/\/127\.0\.0\.1:9123\//);
  for (const bad of ["abc", "0", "-5", "70000", "80.5", ""]) {
    process.env.SVN_EDIT_PORT = bad;
    assert.equal(resolveSvnEditPort(), 8096, `SVN_EDIT_PORT=${bad}`);
  }
  delete process.env.SVN_EDIT_PORT;
});

test("不適用的專案沒有連結：self-generated（SD 在本機）、unregistered、沒登記 SVN 連線、沒有設定", () => {
  assert.equal(buildSvnEditLink(cfg({ sdMode: "self-generated", sdOutputPath: "x" })), null);
  assert.equal(buildSvnEditLink(cfg({ sdMode: "unregistered" })), null);
  assert.equal(buildSvnEditLink(cfg({ svnConnectionId: null })), null);
  assert.equal(buildSvnEditLink(null), null);
});

test("區塊 HTML：沒有連結回傳空字串；有連結時內容被跳脫、連結只用 &amp; 分隔參數", () => {
  assert.equal(renderSvnEditSection(null), "");
  const html = renderSvnEditSection({ url: "http://127.0.0.1:8096/?connection=a&browse=b", connection: "<script>x</script>", startDir: "d\"q" });
  assert.match(html, /id="svn-edit-section"/);
  assert.match(html, /dist-exe\/svn-edit\.exe/); // 路徑分隔符不能在範本字串裡被當成跳脫字元吃掉
  assert.match(html, /href="http:\/\/127\.0\.0\.1:8096\/\?connection=a&amp;browse=b"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /d&quot;q/);
  assert.match(renderSvnEditSection({ url: "http://x", connection: "c", startDir: "" }), /連線根目錄/);
});

// ---- 整合：用真實的票單資料與 SASD 設定寫出報告頁 ----
const PROJECT_NAME = "Link Test Project";
const PROJECT_FOLDER = "Link_Test_Project";
const EMPTY_INPUT = { awaitingSpecConfirmation: [], awaitingConfirmation: [], needsHumanReview: [], contentChanged: [], manualActions: [], uncommittedChanges: { registered: false, roots: [] } };
const readReport = (projectDir) => fs.readFileSync(path.join(projectDir, ".asana-pipeline", PROJECT_FOLDER, "PENDING_HUMAN_ACTIONS.html"), "utf-8");

async function setup(projectGid, config) {
  const store = await import("../dist/pipeline-store.js");
  const registry = await import("../dist/project-registry.js");
  const projectDir = makeTmpDir("dpm-link-proj-");
  await store.assignTicketDir(projectDir, `link-${projectGid ?? "none"}`, PROJECT_NAME, null, null, "Ticket");
  await store.recordProjectContext(`link-${projectGid ?? "none"}`, projectDir, PROJECT_NAME, "Ticket", null, false, projectGid);
  if (projectGid && config) await registry.registerSasdConfig(projectGid, config);
  await store.writePendingActionsReport(projectDir, PROJECT_NAME, EMPTY_INPUT);
  return projectDir;
}

test("報告頁：external 專案顯示連結，並帶 sdRoot 當起始目錄", async () => {
  const projectDir = await setup("PG-EXT", cfg());
  try {
    const html = readReport(projectDir);
    assert.match(html, /id="svn-edit-section"/);
    assert.match(html, /href="http:\/\/127\.0\.0\.1:\d+\/\?connection=conn-1&amp;browse=doc%2Fsd"/);
    assert.doesNotMatch(html, /\{\{SVN_EDIT_SECTION\}\}/); // 範本的佔位符一定被取代
  } finally {
    removeDir(projectDir);
  }
});

test("報告頁：self-generated 專案、票單還沒有 project_gid、沒有登記設定，都不顯示（且報告照常寫得出來）", async () => {
  const selfGen = await setup("PG-SELF", cfg({ sdMode: "self-generated", sdOutputPath: "SPEC.md", svnConnectionId: null }));
  const noGid = await setup(null, null);
  const noConfig = await setup("PG-NOCONF", null);
  try {
    for (const dir of [selfGen, noGid, noConfig]) {
      const html = readReport(dir);
      assert.doesNotMatch(html, /svn-edit-section/);
      assert.doesNotMatch(html, /\{\{SVN_EDIT_SECTION\}\}/);
      assert.match(html, /待確認規格草稿/); // 其餘內容完全不受影響
    }
  } finally {
    [selfGen, noGid, noConfig].forEach(removeDir);
  }
});

test("報告頁：專案底下完全沒有票單時也能寫出報告，不顯示連結", async () => {
  const store = await import("../dist/pipeline-store.js");
  const projectDir = makeTmpDir("dpm-link-empty-");
  try {
    await store.writePendingActionsReport(projectDir, PROJECT_NAME, EMPTY_INPUT);
    assert.doesNotMatch(readReport(projectDir), /svn-edit-section/);
  } finally {
    removeDir(projectDir);
  }
});
