// SA 轉 Word（步驟 G）：範本轉出檢查圖片／表格數、無 Python 只警告、轉換失敗擋交件；沒有 python-docx 時略過實際轉換類測試。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { STANDARD_DIR, SA_TEMPLATE } from "./helpers/sasd-standard.mjs";
import { setupEnv, fulfil, runUntil } from "./helpers/work-item-env.mjs";

const sa = await import("../dist/export/sa-docx.js");
const realPython = await (async () => { delete process.env.DEV_PIPELINE_PYTHON; const ok = await sa.isSaDocxAvailable(); process.env.DEV_PIPELINE_PYTHON = "none"; return ok; })();
const skipReal = realPython ? false : "本機沒有 Python 3 + python-docx，略過實際轉換";
const useRealPython = () => { delete process.env.DEV_PIPELINE_PYTHON; };
const noPython = () => { process.env.DEV_PIPELINE_PYTHON = "none"; };
const env = await setupEnv("wi-docx-");
after(async () => { noPython(); sa.setSaDocxHooks(null); await env.cleanup(); });

async function readySa() {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-analyst");
  await fulfil(dir, "sa-analyst");
  return { id, dir };
}
const done = (id) => env.call({ action: "done", workItemId: id, roleId: "sa-analyst" });

test("候選順序：Windows 為 py -3、python、python3；其他為 python3、python；環境變數可指定或停用", () => {
  assert.deepEqual(sa.pythonCandidates({}, "win32").map((c) => [c.command, ...c.args].join(" ")), ["py -3", "python", "python3"]);
  assert.deepEqual(sa.pythonCandidates({}, "linux").map((c) => c.command), ["python3", "python"]);
  assert.equal(sa.pythonCandidates({ DEV_PIPELINE_PYTHON: "none" }, "win32"), "none");
  assert.deepEqual(sa.pythonCandidates({ DEV_PIPELINE_PYTHON: "/x/py" }, "linux"), [{ command: "/x/py", args: [] }]);
});

test("SA 範本轉 Word：圖片數與 md 引用一致、表格數一致", { skip: skipReal }, async () => {
  useRealPython();
  const dir = await mkdtemp(path.join(os.tmpdir(), "sa-tpl-"));
  try {
    await writeFile(path.join(dir, "01-sa.md"), SA_TEMPLATE());
    await cp(path.join(STANDARD_DIR, "sa-images"), path.join(dir, "sa-images"), { recursive: true });
    const r = await sa.convertSaToDocx(dir);
    assert.equal(r.status, "ok", JSON.stringify(r));
    const buf = await readFile(path.join(dir, "01-sa.docx"));
    assert.equal(sa.countDocxImages(buf), sa.countMdImages(SA_TEMPLATE()));
    assert.ok(sa.countDocxImages(buf) >= 1);
    assert.equal(sa.countDocxTables(buf), r.tables);
    await assert.rejects(stat(path.join(dir, "01-sa.docx.tmp")));
  } finally { noPython(); await rm(dir, { recursive: true, force: true }); }
});

test("圖片找不到：明確報錯、不產生 docx、不留暫存檔", { skip: skipReal }, async () => {
  useRealPython();
  const dir = await mkdtemp(path.join(os.tmpdir(), "sa-miss-"));
  try {
    await writeFile(path.join(dir, "01-sa.md"), "# t\n\n![x](sa-images/none.png)\n");
    const r = await sa.convertSaToDocx(dir);
    assert.equal(r.status, "failed");
    assert.match(r.message, /找不到圖片/);
    await assert.rejects(stat(path.join(dir, "01-sa.docx")));
    await assert.rejects(stat(path.join(dir, "01-sa.docx.tmp")));
  } finally { noPython(); await rm(dir, { recursive: true, force: true }); }
});

test("done sa-analyst（有 Python）：自動轉出 01-sa.docx；write 不能直接寫 docx", { skip: skipReal }, async () => {
  useRealPython();
  try {
    const { id, dir } = await readySa();
    const r = await done(id);
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.warnings, undefined);
    assert.ok((await stat(path.join(dir, "01-sa.docx"))).size > 0);
    const w = await env.call({ action: "write", workItemId: id, filename: "01-sa.docx", content: "x" });
    assert.equal(w.isError, true);
  } finally { noPython(); }
});

test("done sa-analyst（有 Python、圖檔損壞導致轉換失敗）：被擋且不標記完成", { skip: skipReal }, async () => {
  useRealPython();
  try {
    const { id, dir } = await readySa();
    await writeFile(path.join(dir, "sa-images", "a.png"), Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    const r = await done(id);
    assert.equal(r.isError, true);
    assert.match(r.json.message, /SA 轉 Word 失敗/);
    assert.equal((await env.call({ action: "get", workItemId: id })).text.includes('"doneRoles":["baseline-survey","sa-analyst"'), false);
    assert.equal((await done(id)).isError, true);
  } finally { noPython(); }
});

test("done sa-analyst（沒有 Python）：只警告、放行，沒有 docx；render docx 回 ok:false", async () => {
  noPython();
  const { id, dir } = await readySa();
  const r = await done(id);
  assert.equal(r.isError, false, r.text);
  assert.match(r.json.warnings[0], /01-sa\.docx/);
  await assert.rejects(stat(path.join(dir, "01-sa.docx")));
  const rd = await env.call({ action: "render", workItemId: id, kind: "docx" });
  assert.equal(rd.isError, false);
  assert.equal(rd.json.ok, false);
  assert.equal(rd.json.reason, "python-not-available");
});

test("注入的轉換失敗（結束碼非 0）被擋並移除舊 docx；驗證圖片數不符也被擋", async () => {
  const { id, dir } = await readySa();
  await writeFile(path.join(dir, "01-sa.docx"), "old");
  sa.setSaDocxHooks({ detect: async () => ({ command: "fake", args: [] }), run: async () => ({ exitCode: 3, stdout: "", stderr: "轉換失敗：第 1 行找不到圖片" }) });
  try {
    const r = await done(id);
    assert.equal(r.isError, true);
    assert.match(r.json.message, /找不到圖片/);
    await assert.rejects(stat(path.join(dir, "01-sa.docx")));
    sa.setSaDocxHooks({ detect: async () => ({ command: "fake", args: [] }), run: async (_py, args) => { await writeFile(args[2], "not a zip"); return { exitCode: 0, stdout: "", stderr: "" }; } });
    const r2 = await done(id);
    assert.equal(r2.isError, true);
    assert.match(r2.json.message, /SA 轉 Word 失敗/);
  } finally { sa.setSaDocxHooks(null); }
});
