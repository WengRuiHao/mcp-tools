import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "output-limit-"));
process.env.ASANA_PIPELINE_DATA_DIR = path.join(tmp, "data");
const projectDir = path.join(tmp, "proj");
fs.mkdirSync(projectDir, { recursive: true });

const { truncateHeadTail, sliceFileContent } = await import("../dist/output-limit.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { registerProjectFsTools } = await import("../dist/project-fs-tools.js");

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

test("truncateHeadTail: boundaries", () => {
  assert.deepEqual(truncateHeadTail("", { head: 3, tail: 3 }), { text: "", truncated: false, originalChars: 0 });
  const exact = "a".repeat(6);
  assert.equal(truncateHeadTail(exact, { head: 3, tail: 3 }).truncated, false);
  const over = truncateHeadTail("a".repeat(7), { head: 3, tail: 3 });
  assert.equal(over.truncated, true);
  assert.equal(over.originalChars, 7);
  assert.match(over.text, /7/);
  assert.ok(over.text.startsWith("aaa"));
  assert.ok(over.text.endsWith("aaa"));
});

test("truncateHeadTail: head/tail zero and CJK", () => {
  const r = truncateHeadTail("0123456789", { head: 0, tail: 2 });
  assert.ok(r.text.endsWith("89"));
  assert.ok(!r.text.startsWith("0"));
  const r2 = truncateHeadTail("\u4e2d".repeat(20), { head: 2, tail: 0 });
  assert.ok(r2.text.startsWith("\u4e2d\u4e2d"));
  assert.equal(r2.truncated, true);
});

test("truncateHeadTail: does not split surrogate pairs", () => {
  const emoji = "\ud83d\ude00";
  const text = emoji.repeat(10);
  const r = truncateHeadTail(text, { head: 3, tail: 3 });
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(r.text));
  assert.ok(!/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(r.text));
});

test("sliceFileContent: validation", () => {
  const c = "a\nb\nc\n";
  assert.equal(sliceFileContent(c, { startLine: 4 }).ok, false);
  assert.equal(sliceFileContent(c, { startLine: 3, endLine: 2 }).ok, false);
  assert.equal(sliceFileContent(c, { startLine: 0 }).ok, false);
  assert.equal(sliceFileContent(c, { startLine: 1.5 }).ok, false);
  const r = sliceFileContent(c, { startLine: 2, endLine: 3 });
  assert.equal(r.ok && r.content, "b\nc\n");
});

test("read_project_file: small file unchanged shape", async () => {
  fs.writeFileSync(path.join(projectDir, "small.txt"), "hello\nworld\n");
  const { data } = await call("read_project_file", { projectDir, path: "small.txt" });
  assert.deepEqual(data, { success: true, content: "hello\nworld\n" });
});

test("read_project_file: large file truncated on line boundary with note", async () => {
  const lines = Array.from({ length: 5000 }, (_, i) => "line-" + i + "-" + "x".repeat(20));
  fs.writeFileSync(path.join(projectDir, "big.txt"), lines.join("\n") + "\n");
  const { data } = await call("read_project_file", { projectDir, path: "big.txt" });
  assert.equal(data.truncated, true);
  assert.equal(data.totalLines, 5000);
  assert.ok(data.content.length <= 40000);
  assert.ok(data.content.endsWith("\n") || data.content.split("\n").pop().startsWith("line-"));
  assert.equal(data.content.split("\n").length - 1, data.returnedLines);
  assert.ok(data.truncatedNote.includes("startLine"));
  const rest = await call("read_project_file", { projectDir, path: "big.txt", startLine: data.returnedLines + 1, endLine: data.returnedLines + 2 });
  assert.equal(rest.data.content, lines[data.returnedLines] + "\n" + lines[data.returnedLines + 1] + "\n");
});

test("read_project_file: line range and invalid ranges", async () => {
  fs.writeFileSync(path.join(projectDir, "r.txt"), "1\n2\n3\n4\n");
  const ok = await call("read_project_file", { projectDir, path: "r.txt", startLine: 2, endLine: 3 });
  assert.equal(ok.data.content, "2\n3\n");
  assert.equal(ok.data.startLine, 2);
  assert.equal(ok.data.endLine, 3);
  assert.equal(ok.data.totalLines, 4);
  assert.equal(ok.data.truncated, undefined);
  assert.equal((await call("read_project_file", { projectDir, path: "r.txt", startLine: 9 })).isError, true);
  assert.equal((await call("read_project_file", { projectDir, path: "r.txt", startLine: 3, endLine: 1 })).isError, true);
  assert.equal((await call("read_project_file", { projectDir, path: "r.txt", startLine: -1 })).isError, true);
});

test("run_project_shell: short output keeps shape", async () => {
  const { data } = await call("run_project_shell", { projectDir, command: "node -e \"console.log('hi')\"" });
  assert.equal(data.ok, true);
  assert.equal(data.stdout.trim(), "hi");
  assert.equal(data.truncated, undefined);
  assert.equal(data.originalChars, undefined);
});

test("run_project_shell: long output keeps the tail", async () => {
  const cmd = "node -e \"process.stdout.write('A'.repeat(30000)+'\\nFINAL_ERROR_LINE')\"";
  const { data } = await call("run_project_shell", { projectDir, command: cmd });
  assert.ok(data.stdout.includes("FINAL_ERROR_LINE"));
  assert.ok(data.stdout.includes("30017"));
  assert.deepEqual(data.truncated, { stdout: true, stderr: false });
  assert.equal(data.originalChars.stdout, 30017);
  assert.ok(data.stdout.length < 12500);
});
