// 專案關卡（project-gates）：分析關卡與實作關卡。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir, writeFile, isolateDataDir } from "./helpers/support.mjs";
import { checkAnalysisGates, checkImplementationGates } from "../dist/project-gates.js";

const data = isolateDataDir();
test.after(() => data.cleanup());

const NEW_GATES = ".pipeline/gates.json";
const OLD_GATES = ".claude/pipeline-roles/gates.json";

function withProject(gates, fn, { gatesPath = NEW_GATES, raw = false } = {}) {
  return async () => {
    const dir = makeTmpDir("dpm-gates-");
    try {
      if (gates !== null) writeFile(dir, gatesPath, raw ? gates : JSON.stringify(gates));
      writeFile(dir, "legacy/src/A.java", "class A {}");
      writeFile(dir, "legacy/src/B.java", "class B {}");
      await fn(dir);
    } finally {
      removeDir(dir);
    }
  };
}

const analysisGate = (extra = {}) => ({
  analysisReferences: [{ ticketNamePattern: "^RPT", heading: "Legacy Refs", pathPrefix: "legacy/", ...extra }],
});
const analyze = (dir, content, { ticketName = "RPT01 report", hasSasd = true } = {}) =>
  checkAnalysisGates({ projectDir: dir, ticketName, analysisContent: content, hasSasd });

test("analysis: no gates.json lets everything through", withProject(null, async (dir) => {
  assert.deepEqual(await analyze(dir, "nothing"), { ok: true });
}));

test("analysis: malformed gates.json blocks and names the file", withProject("{ oops", async (dir) => {
  const res = await analyze(dir, "x");
  assert.equal(res.ok, false);
  assert.match(res.message, /gates\.json/);
}, { raw: true }));

test("analysis: ticket name that does not match the pattern is not gated", withProject(analysisGate(), async (dir) => {
  assert.deepEqual(await analyze(dir, "no section at all", { ticketName: "BUG-1 other" }), { ok: true });
}));

test("analysis: missing section is rejected", withProject(analysisGate(), async (dir) => {
  const res = await analyze(dir, "# Summary\ntext");
  assert.equal(res.ok, false);
  assert.match(res.message, /Legacy Refs/);
}));

test("analysis: section without any path under the prefix is rejected", withProject(analysisGate(), async (dir) => {
  const res = await analyze(dir, "## Legacy Refs\nI read some stuff.\n");
  assert.equal(res.ok, false);
  assert.match(res.message, /0/);
}));

test("analysis: a path that does not exist is rejected and reported", withProject(analysisGate(), async (dir) => {
  const res = await analyze(dir, "## Legacy Refs\n- legacy/src/Fake.java\n");
  assert.equal(res.ok, false);
  assert.match(res.message, /legacy\/src\/Fake\.java/);
}));

test("analysis: valid path passes, including :line suffix and backslashes", withProject(analysisGate(), async (dir) => {
  assert.deepEqual(await analyze(dir, "## Legacy Refs\n- `legacy/src/A.java:12`\n"), { ok: true });
  assert.deepEqual(await analyze(dir, "## Legacy Refs\n- legacy\\src\\A.java:12-30\n"), { ok: true });
  assert.deepEqual(await analyze(dir, "## Legacy Refs\n(see legacy/src/A.java） and more\n"), { ok: true });
  assert.deepEqual(await analyze(dir, "## Legacy Refs\nlegacy/src\n"), { ok: true }); // 目錄也算
}));

test("analysis: heading level is free and the section stops at the next heading", withProject(analysisGate(), async (dir) => {
  assert.deepEqual(await analyze(dir, "#### Legacy Refs (v2)\nlegacy/src/A.java\n"), { ok: true });
  const res = await analyze(dir, "## Legacy Refs\nnothing here\n## Other\nlegacy/src/A.java\n");
  assert.equal(res.ok, false);
}));

test("analysis: minPaths defaults to 1 and can be raised", withProject(analysisGate({ minPaths: 2 }), async (dir) => {
  const one = await analyze(dir, "## Legacy Refs\nlegacy/src/A.java\n");
  assert.equal(one.ok, false);
  assert.match(one.message, /2/);
  assert.deepEqual(await analyze(dir, "## Legacy Refs\nlegacy/src/A.java legacy/src/B.java\n"), { ok: true });
  // 重複引用同一個路徑只算一個
  const dup = await analyze(dir, "## Legacy Refs\nlegacy/src/A.java\nlegacy/src/A.java:3\n");
  assert.equal(dup.ok, false);
}));

test("analysis: a valid path plus a fake one still satisfies minPaths 1", withProject(analysisGate(), async (dir) => {
  assert.deepEqual(await analyze(dir, "## Legacy Refs\nlegacy/src/A.java legacy/src/Nope.java\n"), { ok: true });
}));

test("analysis: path escaping the project dir does not count", withProject(analysisGate({ pathPrefix: "../" }), async (dir) => {
  const sibling = path.join(path.dirname(dir), `${path.basename(dir)}-sibling.txt`);
  fs.writeFileSync(sibling, "outside");
  try {
    const res = await analyze(dir, `## Legacy Refs\n../${path.basename(sibling)}\n`);
    assert.equal(res.ok, false); // 檔案真的存在，但在專案目錄外
  } finally {
    fs.rmSync(sibling, { force: true });
  }
}));

test("analysis: requireSasd blocks when no SA/SD was found", withProject(analysisGate({ requireSasd: true }), async (dir) => {
  const content = "## Legacy Refs\nlegacy/src/A.java\n";
  const blocked = await analyze(dir, content, { hasSasd: false });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /record_sasd_check/);
  assert.deepEqual(await analyze(dir, content, { hasSasd: true }), { ok: true });
}));

test("analysis: legacy gates.json location is still honoured", withProject(analysisGate(), async (dir) => {
  const res = await analyze(dir, "# nothing");
  assert.equal(res.ok, false);
}, { gatesPath: OLD_GATES }));

// ---- 實作關卡 ----

const implGate = (extra = {}) => ({
  implementationSections: [{ ticketNamePattern: "^RPT", heading: "Duplicate Check", ...extra }],
});
const implement = (dir, content, ticketName = "RPT01 report") =>
  checkImplementationGates({ projectDir: dir, ticketName, implementationContent: content });
const chars = (n) => "x".repeat(n);

test("implementation: no gates.json / unrelated ticket pass", withProject(null, async (dir) => {
  assert.deepEqual(await implement(dir, "anything"), { ok: true });
}));

test("implementation: ticket name mismatch is not gated", withProject(implGate(), async (dir) => {
  assert.deepEqual(await implement(dir, "no section", "BUG-9"), { ok: true });
}));

test("implementation: missing section is rejected", withProject(implGate(), async (dir) => {
  const res = await implement(dir, "# Done\nstuff");
  assert.equal(res.ok, false);
  assert.match(res.message, /Duplicate Check/);
}));

test("implementation: default minChars is 40 (whitespace not counted)", withProject(implGate(), async (dir) => {
  const short = await implement(dir, `## Duplicate Check\n${chars(39)}\n`);
  assert.equal(short.ok, false);
  assert.match(short.message, /39/);
  assert.match(short.message, /40/);
  assert.deepEqual(await implement(dir, `## Duplicate Check\n${chars(40)}\n`), { ok: true });
  assert.deepEqual(await implement(dir, `## Duplicate Check\n${chars(20)} \n\n ${chars(20)}\n`), { ok: true });
  const spaced = await implement(dir, `## Duplicate Check\n${"x ".repeat(30)}\n`);
  assert.equal(spaced.ok, false); // 30 個非空白字元
}));

test("implementation: custom minChars", withProject(implGate({ minChars: 5 }), async (dir) => {
  assert.equal((await implement(dir, "## Duplicate Check\nabcd\n")).ok, false);
  assert.deepEqual(await implement(dir, "## Duplicate Check\nabcde\n"), { ok: true });
}));

test("implementation: any heading level and substring matching", withProject(implGate({ minChars: 5 }), async (dir) => {
  assert.deepEqual(await implement(dir, "###### 3. Duplicate Check (second pass)\nabcdef\n"), { ok: true });
  assert.deepEqual(await implement(dir, "# Duplicate Check\nabcdef\n"), { ok: true });
  // 不是標題行就不算
  assert.equal((await implement(dir, "Duplicate Check\nabcdef\n")).ok, false);
}));

test("implementation: section ends at the next heading", withProject(implGate({ minChars: 10 }), async (dir) => {
  const res = await implement(dir, "## Duplicate Check\nabc\n## Next\n" + chars(50));
  assert.equal(res.ok, false);
}));

test("implementation: malformed gates.json blocks", withProject("not json", async (dir) => {
  const res = await implement(dir, "## Duplicate Check\n" + chars(80));
  assert.equal(res.ok, false);
  assert.match(res.message, /gates\.json/);
}, { raw: true }));

test("implementation: legacy gates.json location works", withProject(implGate(), async (dir) => {
  assert.equal((await implement(dir, "nothing")).ok, false);
  assert.deepEqual(await implement(dir, "## Duplicate Check\n" + chars(60)), { ok: true });
}, { gatesPath: OLD_GATES }));

test("implementation gates ignore analysisReferences and vice versa", withProject({ ...analysisGate(), ...implGate() }, async (dir) => {
  assert.deepEqual(await implement(dir, "## Duplicate Check\n" + chars(60)), { ok: true });
  assert.deepEqual(await analyze(dir, "## Legacy Refs\nlegacy/src/A.java"), { ok: true });
}));
