// SD 規格文件讀寫與 fileName 參數（in-memory client）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir, connectClient, callTool, isolateDataDir } from "./helpers/support.mjs";
import { registerSdDocTools } from "../dist/sd-doc-tools.js";
import { registerSasdConfig } from "../dist/project-registry.js";

const data = isolateDataDir();
test.after(() => data.cleanup());

let counter = 0;
async function withSd(sdOutputPath, fn, { createDir = true } = {}) {
  const projectDir = makeTmpDir("dpm-sd-");
  const projectGid = `SD-${++counter}`;
  if (sdOutputPath !== null) {
    if (createDir && !path.extname(sdOutputPath)) fs.mkdirSync(path.join(projectDir, sdOutputPath), { recursive: true });
    await registerSasdConfig(projectGid, { saRoot: "x", sdMode: "self-generated", sdRoot: null, sdOutputPath, svnConnectionId: null, specOrder: "spec_first" });
  }
  const conn = await connectClient(registerSdDocTools);
  try {
    await fn({ client: conn.client, projectDir, projectGid });
  } finally {
    await conn.close();
    removeDir(projectDir);
  }
}

test("directory mode: write and read a named file; files are independent", () =>
  withSd("docs/spec", async ({ client, projectDir, projectGid }) => {
    const w1 = await callTool(client, "write_project_sd_doc", { projectGid, projectDir, content: "ONE", fileName: "A.md" });
    assert.equal(w1.json.success, true);
    await callTool(client, "write_project_sd_doc", { projectGid, projectDir, content: "TWO", fileName: "B.md" });
    assert.equal(fs.readFileSync(path.join(projectDir, "docs/spec/A.md"), "utf-8"), "ONE");

    const r1 = await callTool(client, "read_project_sd_doc", { projectGid, projectDir, fileName: "A.md" });
    assert.equal(r1.json.success, true);
    assert.equal(r1.json.content, "ONE");
    assert.ok(r1.json.sdOutputPath.endsWith("A.md"));
    const r2 = await callTool(client, "read_project_sd_doc", { projectGid, projectDir, fileName: "B.md" });
    assert.equal(r2.json.content, "TWO");
  }));

test("directory mode: reading a file that does not exist yet returns empty content", () =>
  withSd("docs/spec", async ({ client, projectDir, projectGid }) => {
    const r = await callTool(client, "read_project_sd_doc", { projectGid, projectDir, fileName: "NEW.md" });
    assert.equal(r.json.success, true);
    assert.equal(r.json.content, "");
  }));

test("directory mode: read without fileName reports an error instead of silently returning empty", () =>
  withSd("docs/spec", async ({ client, projectDir, projectGid }) => {
    const r = await callTool(client, "read_project_sd_doc", { projectGid, projectDir });
    assert.equal(r.isError, true);
    assert.equal(r.json.success, false);
    assert.match(r.json.message, /fileName/);
  }));

test("directory mode: write without fileName is refused and leaves the directory intact", () =>
  withSd("docs/spec", async ({ client, projectDir, projectGid }) => {
    const w = await callTool(client, "write_project_sd_doc", { projectGid, projectDir, content: "X" });
    assert.equal(w.isError, true);
    assert.ok(fs.statSync(path.join(projectDir, "docs/spec")).isDirectory());
  }));

test("fileName with path separators or .. is rejected for read and write", () =>
  withSd("docs/spec", async ({ client, projectDir, projectGid }) => {
    const bad = ["../x.md", "..", "a/b.md", "a\\b.md", "/abs.md", "sub/../x.md", "C:\\x.md"];
    for (const fileName of bad) {
      const w = await callTool(client, "write_project_sd_doc", { projectGid, projectDir, content: "EVIL", fileName });
      assert.equal(w.isError, true, `write ${fileName}`);
      assert.equal(w.json.success, false);
      const r = await callTool(client, "read_project_sd_doc", { projectGid, projectDir, fileName });
      assert.equal(r.isError, true, `read ${fileName}`);
    }
    assert.deepEqual(fs.readdirSync(path.join(projectDir, "docs/spec")), []);
    assert.equal(fs.existsSync(path.join(projectDir, "docs/x.md")), false);
    assert.equal(fs.existsSync(path.join(projectDir, "x.md")), false);
  }));

test("single-file mode: no fileName reads and writes the registered file", () =>
  withSd("docs/SPEC.md", async ({ client, projectDir, projectGid }) => {
    const empty = await callTool(client, "read_project_sd_doc", { projectGid, projectDir });
    assert.equal(empty.json.content, "");
    await callTool(client, "write_project_sd_doc", { projectGid, projectDir, content: "SINGLE" });
    assert.equal(fs.readFileSync(path.join(projectDir, "docs/SPEC.md"), "utf-8"), "SINGLE");
    const back = await callTool(client, "read_project_sd_doc", { projectGid, projectDir });
    assert.equal(back.json.content, "SINGLE");
  }));

test("an unregistered project (no sdOutputPath) is refused", () =>
  withSd(null, async ({ client, projectDir, projectGid }) => {
    for (const [tool, extra] of [["read_project_sd_doc", {}], ["write_project_sd_doc", { content: "x" }]]) {
      const r = await callTool(client, tool, { projectGid, projectDir, ...extra });
      assert.equal(r.isError, true, tool);
      assert.match(r.json.message, /register_sasd_config/);
    }
  }));

test("write: an externally modified file is blocked until acknowledgeExternalChange", () =>
  withSd("docs/spec", async ({ client, projectDir, projectGid }) => {
    const args = { projectGid, projectDir, fileName: "A.md" };
    await callTool(client, "write_project_sd_doc", { ...args, content: "v1" });
    fs.writeFileSync(path.join(projectDir, "docs/spec/A.md"), "edited by hand");

    const blocked = await callTool(client, "write_project_sd_doc", { ...args, content: "v2" });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.json.externally_modified, true);
    assert.equal(blocked.json.currentContent, "edited by hand");
    assert.equal(fs.readFileSync(path.join(projectDir, "docs/spec/A.md"), "utf-8"), "edited by hand");

    const forced = await callTool(client, "write_project_sd_doc", { ...args, content: "v2", acknowledgeExternalChange: true });
    assert.equal(forced.json.success, true);
    assert.equal(fs.readFileSync(path.join(projectDir, "docs/spec/A.md"), "utf-8"), "v2");
  }));
