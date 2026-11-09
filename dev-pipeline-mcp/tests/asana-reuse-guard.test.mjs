// S12b：Asana 流程推進到 implemented 的重用防線。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tmp = await mkdtemp(path.join(os.tmpdir(), "asana-reuse-"));
process.env.ASANA_PIPELINE_DATA_DIR = path.join(tmp, "data");

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { registerTicketLifecycleTools } = await import("../dist/ticket-lifecycle-tools.js");
const store = await import("../dist/pipeline-store.js");
const { getRolePrompt } = await import("../dist/prompts.js");

let client;
before(async () => {
  const server = new McpServer({ name: "t", version: "0" });
  registerTicketLifecycleTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function call(args) {
  const r = await client.callTool({ name: "advance_ticket_stage", arguments: args });
  const json = JSON.parse(r.content[0].text);
  return { isError: !!r.isError, json };
}

const body = (tag) => Array.from({ length: 14 }, (_, i) => `  const value_${tag}_${i} = computeSomething(sharedInput, ${i}) + offsetValue_${i};`);
const jsSource = (tag) => ["function demo() {", ...body(tag), "}", ""].join("\n");
const TABLE = "| 搜尋關鍵字 | 找到的候選 | 決定 | 理由 |\n|---|---|---|---|\n| computeSomething | 無 | 新建 | 專案沒有同類方法 |\n";

// 每張票一個獨立的 git 專案目錄，避免互相的未追蹤檔案被當成改動。
async function ticket(gid, impl, files = {}) {
  const projectDir = path.join(tmp, "proj-" + gid);
  await mkdir(path.join(projectDir, "src"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: projectDir });
  await writeFile(path.join(projectDir, ".gitignore"), [".gitignore", "CLAUDE.md", ""].join("\n")); // assignTicketDir 會寫 CLAUDE.md 備註，排除以免被當成改動
  await store.assignTicketDir(projectDir, gid, "Proj", "T-" + gid);
  await store.advanceStage(gid, "snapshot", {});
  for (const [rel, text] of Object.entries(files)) await writeFile(path.join(projectDir, rel), text);
  if (impl !== null) await store.writeArtifact(gid, "02-implementation.md", impl);
  return { taskGid: gid, stage: "implemented", project_dir: projectDir };
}

test("缺重用檢查紀錄被擋", async () => {
  const args = await ticket("g1", "## 改動檔案\n- src/a.js\n", { "src/a.js": jsSource("x") });
  const r = await call(args);
  assert.equal(r.isError, true);
  assert.match(r.json.message, /重用檢查紀錄/);
  assert.equal((await store.readStatus("g1")).stage, "snapshot");
});

test("沒有改動檔案資訊要求補「## 改動檔案」", async () => {
  const r = await call(await ticket("g2", `## 重用檢查紀錄\n${TABLE}`));
  assert.equal(r.isError, true);
  assert.match(r.json.message, /## 改動檔案/);
});

test("有重複被擋並寫出 dup-report.md", async () => {
  const impl = `## 重用檢查紀錄\n${TABLE}\n## 改動檔案\n- src/new.js\n`;
  const args = await ticket("g3", impl, { "src/old.js": jsSource("o"), "src/new.js": jsSource("o") });
  const r = await call(args);
  assert.equal(r.isError, true);
  assert.match(r.json.message, /src\/new\.js 第 \d+～\d+ 行/);
  assert.match(r.json.message, /dup-report\.md/);
  const report = await store.readArtifact("g3", "dup-report.md");
  assert.match(report, /擋下交件/);
  assert.equal((await store.readStatus("g3")).stage, "snapshot");
});

test("有效豁免通過", async () => {
  const impl = `## 重用檢查紀錄\n${TABLE}\n## 改動檔案\n- src/new.js\n\n## 重複豁免\n| 檔案 | 相似檔案 | 理由 |\n|---|---|---|\n| src/new.js | src/old.js | 兩邊刻意獨立演進 |\n`;
  const r = await call(await ticket("g4", impl, { "src/old.js": jsSource("o"), "src/new.js": jsSource("o") }));
  assert.equal(r.json.success !== false && !r.isError, true);
  assert.equal((await store.readStatus("g4")).stage, "implemented");
  assert.match(await store.readArtifact("g4", "dup-report.md"), /已豁免/);
});

test("無效豁免被擋", async () => {
  const impl = `## 重用檢查紀錄\n${TABLE}\n## 改動檔案\n- src/new.js\n\n## 重複豁免\n| 檔案 | 相似檔案 | 理由 |\n|---|---|---|\n| src/new.js | src/old.js | 略 |\n`;
  const r = await call(await ticket("g5", impl, { "src/old.js": jsSource("o"), "src/new.js": jsSource("o") }));
  assert.equal(r.isError, true);
  assert.match(r.json.message, /重複/);
});

test("乾淨通過，status.json 沒有新欄位", async () => {
  const impl = `## 重用檢查紀錄\n${TABLE}\n## 改動檔案\n- src/clean.js — 新增\n`;
  const args = await ticket("g6", impl, { "src/clean.js": jsSource("unique") });
  const before = Object.keys(await store.readStatus("g6")).sort();
  const r = await call(args);
  assert.equal(r.isError, false);
  const st = await store.readStatus("g6");
  assert.equal(st.stage, "implemented");
  assert.deepEqual(Object.keys(st).sort(), before);
});

test("其他階段不受影響", async () => {
  await store.assignTicketDir(tmp, "g7", "Proj", "T-g7");
  await store.advanceStage("g7", "snapshot", {});
  await store.writeArtifact("g7", "01-analysis.md", "分析");
  const r = await call({ taskGid: "g7", stage: "analyzed" });
  assert.equal(r.isError, false);
});

test("engineer／verifier 提示詞含新規則，analyst／tester 不含", () => {
  for (const sdMode of [undefined, "external", "self", "self-generated", "unregistered"]) {
    for (const specOrder of [undefined, "spec_first", "code_first"]) {
      for (const testCapabilityMode of [undefined, "modern", "none"]) {
        const o = { sdMode, specOrder, testCapabilityMode };
        const eng = getRolePrompt("engineer", o);
        assert.match(eng, /## 重用檢查紀錄/);
        assert.match(eng, /## 改動檔案/);
        assert.match(eng, /## 重複豁免/);
        const ver = getRolePrompt("verifier", o);
        assert.match(ver, /重複與重用/);
        assert.match(ver, /dup-report\.md/);
        assert.match(ver, /重複檢查結果/);
        for (const role of ["analyst", "tester", "spec-writer"]) {
          const text = getRolePrompt(role, o);
          assert.doesNotMatch(text, /重用防線|重複與重用/);
        }
      }
    }
  }
});
