import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-crlf-scope-"));
process.env.ASANA_PIPELINE_DATA_DIR = path.join(tmp, "data");
const projectDir = path.join(tmp, "proj");
fs.mkdirSync(projectDir, { recursive: true });

const dist = process.env.DEV_PIPELINE_TEST_DIST
  ? path.resolve(process.env.DEV_PIPELINE_TEST_DIST)
  : path.resolve(import.meta.dirname, "../dist");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { registerProjectFsTools } = await import(pathToFileURL(path.join(dist, "project-fs-tools.js")).href);

let client;
before(async () => {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  registerProjectFsTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "c", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: r.isError === true, data: JSON.parse(r.content[0].text) };
}
const raw = (p) => fs.readFileSync(path.join(projectDir, p), "utf-8");
const rel = (m) => m.file.split(path.sep).join("/");
const put = (p, c) => {
  fs.mkdirSync(path.dirname(path.join(projectDir, p)), { recursive: true });
  fs.writeFileSync(path.join(projectDir, p), c);
};

test("replace: CRLF file, multi-line LF oldString succeeds and keeps CRLF", async () => {
  put("c1.txt", "a\r\nb\r\nc\r\nd\r\n");
  const r = await call("write_project_file", { projectDir, path: "c1.txt", mode: "replace", oldString: "b\nc", newString: "X\nY\nZ" });
  assert.equal(r.data.success, true);
  assert.equal(raw("c1.txt"), "a\r\nX\r\nY\r\nZ\r\nd\r\n");
  assert.equal(raw("c1.txt").replace(/\r\n/g, "").includes("\n"), false);
});

test("replace: CRLF file, duplicate multi-line LF oldString still rejected", async () => {
  const body = "x\r\ny\r\nz\r\nx\r\ny\r\n";
  put("c2.txt", body);
  const r = await call("write_project_file", { projectDir, path: "c2.txt", mode: "replace", oldString: "x\ny", newString: "Q" });
  assert.equal(r.isError, true);
  assert.equal(r.data.matchCount, 2);
  assert.equal(raw("c2.txt"), body);
});

test("replace: not found message mentions newline normalization", async () => {
  put("c3.txt", "a\r\nb\r\n");
  const r = await call("write_project_file", { projectDir, path: "c3.txt", mode: "replace", oldString: "a\n  b", newString: "Q" });
  assert.equal(r.isError, true);
  assert.match(r.data.message, /換行已自動配合/);
  assert.match(r.data.message, /縮排/);
});

test("replace: LF file unaffected", async () => {
  put("l1.txt", "a\nb\nc\n");
  const r = await call("write_project_file", { projectDir, path: "l1.txt", mode: "replace", oldString: "b\nc", newString: "X\nY" });
  assert.equal(r.data.success, true);
  assert.equal(raw("l1.txt"), "a\nX\nY\n");
});

test("search: path outside projectDir is rejected", async () => {
  const r = await call("search_project_text", { projectDir, pattern: "x", path: ".." });
  assert.equal(r.isError, true);
  assert.equal(r.data.success, false);
});

test("search: fileExtensions filter (case-insensitive, no dot)", async () => {
  put("ext/a.ts", "needleExt\n");
  put("ext/b.md", "needleExt\n");
  put("ext/C.TS", "needleExt\n");
  const r = await call("search_project_text", { projectDir, pattern: "needleExt", fileExtensions: ["ts"] });
  assert.deepEqual(r.data.matches.map((m) => m.file.split(path.sep).join("/")).sort(), ["ext/C.TS", "ext/a.ts"]);
});

test("search: path narrows scope", async () => {
  put("sc/in/a.ts", "scopeNeedle\n");
  put("sc/out/b.ts", "scopeNeedle\n");
  const r = await call("search_project_text", { projectDir, pattern: "scopeNeedle", path: "sc/in" });
  assert.deepEqual(r.data.matches.map((m) => m.file.split(path.sep).join("/")), ["sc/in/a.ts"]);
});

test("search: new SKIP_DIRS entries are skipped", async () => {
  for (const d of ["out", ".gradle", "coverage", ".next"]) put(`${d}/f.ts`, "skipNeedle\n");
  put("keep/f.ts", "skipNeedle\n");
  const r = await call("search_project_text", { projectDir, pattern: "skipNeedle" });
  assert.deepEqual(r.data.matches.map((m) => m.file.split(path.sep).join("/")), ["keep/f.ts"]);
});
