import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-edit-search-"));
process.env.ASANA_PIPELINE_DATA_DIR = path.join(tmp, "data");
const projectDir = path.join(tmp, "proj");
fs.mkdirSync(projectDir, { recursive: true });

// DEV_PIPELINE_TEST_DIST 可指向 tsc --outDir 的暫存輸出（預設 ../dist）
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
const read = (p) => fs.readFileSync(path.join(projectDir, p), "utf-8");

test("write_project_file: overwrite still works and requires content", async () => {
  assert.equal((await call("write_project_file", { projectDir, path: "a.txt", content: "hello" })).data.success, true);
  assert.equal(read("a.txt"), "hello");
  assert.equal((await call("write_project_file", { projectDir, path: "a.txt" })).isError, true);
});

test("write_project_file replace: unique match replaces", async () => {
  await call("write_project_file", { projectDir, path: "b.txt", content: "foo bar $& baz" });
  const r = await call("write_project_file", { projectDir, path: "b.txt", mode: "replace", oldString: "bar", newString: "$&X" });
  assert.equal(r.data.success, true);
  assert.equal(read("b.txt"), "foo $&X $& baz");
});

test("write_project_file replace: not found / multiple / missing file / empty old do not write", async () => {
  await call("write_project_file", { projectDir, path: "c.txt", content: "aa aa" });
  const nf = await call("write_project_file", { projectDir, path: "c.txt", mode: "replace", oldString: "zz", newString: "y" });
  assert.equal(nf.isError, true);
  const multi = await call("write_project_file", { projectDir, path: "c.txt", mode: "replace", oldString: "aa", newString: "y" });
  assert.equal(multi.isError, true);
  assert.equal(multi.data.matchCount, 2);
  assert.equal((await call("write_project_file", { projectDir, path: "nope.txt", mode: "replace", oldString: "a", newString: "b" })).isError, true);
  assert.equal((await call("write_project_file", { projectDir, path: "c.txt", mode: "replace", oldString: "", newString: "b" })).isError, true);
  assert.equal((await call("write_project_file", { projectDir, path: "c.txt", mode: "replace", oldString: "aa" })).isError, true);
  assert.equal(read("c.txt"), "aa aa");
});

test("write_project_file replace: sandbox and external-modification block apply", async () => {
  const esc = await call("write_project_file", { projectDir, path: "../x.txt", mode: "replace", oldString: "a", newString: "b" });
  assert.equal(esc.isError, true);
  await call("write_project_file", { projectDir, path: "d.txt", content: "one two" });
  fs.writeFileSync(path.join(projectDir, "d.txt"), "one two EXTERNAL");
  const blocked = await call("write_project_file", { projectDir, path: "d.txt", mode: "replace", oldString: "one", newString: "1" });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.data.externally_modified, true);
  assert.equal(read("d.txt"), "one two EXTERNAL");
  const ack = await call("write_project_file", { projectDir, path: "d.txt", mode: "replace", oldString: "one", newString: "1", acknowledgeExternalChange: true });
  assert.equal(ack.data.success, true);
  assert.equal(read("d.txt"), "1 two EXTERNAL");
});

test("search_project_text: structured fields, no fake match", async () => {
  fs.writeFileSync(path.join(projectDir, "s1.ts"), "needle here\nother\n");
  const r = await call("search_project_text", { projectDir, pattern: "needle" });
  assert.equal(r.data.success, true);
  assert.equal(r.data.truncated, false);
  assert.equal(r.data.timedOut, false);
  assert.equal(r.data.limit, 200);
  assert.equal(r.data.note, undefined);
  assert.deepEqual(r.data.matches.map((m) => m.file), ["s1.ts"]);
});

test("search_project_text: match cap sets truncated + note without fake entry", async () => {
  fs.writeFileSync(path.join(projectDir, "many.ts"), Array.from({ length: 300 }, () => "zzz").join("\n"));
  const r = await call("search_project_text", { projectDir, pattern: "zzz" });
  assert.equal(r.data.matches.length, 200);
  assert.ok(r.data.matches.every((m) => m.line > 0));
  assert.equal(r.data.truncated, true);
  assert.equal(r.data.timedOut, false);
  assert.match(r.data.note, /200/);
});

test("tool descriptions mention rationale and search limits", async () => {
  const { tools } = await client.listTools();
  const d = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  for (const n of ["read_project_file", "write_project_file", "list_project_dir", "search_project_text", "run_project_shell"]) {
    assert.match(d[n], /Read\/Edit\/Grep\/Bash/, n);
  }
  assert.match(d.search_project_text, /\.ts/);
  assert.match(d.search_project_text, /200/);
});
