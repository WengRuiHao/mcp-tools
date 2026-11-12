// 問題 62：done 與最終驗收摘要檢查工作項目目錄與專案目錄根的 *.stackdump，只警告不擋交件。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, runUntil, fulfil } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-eng-a-dump-");
after(() => env.cleanup());

test("沒有 stackdump：done 沒有相關警告", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "mockup-designer");
  await fulfil(dir, "mockup-designer");
  const r = await env.call({ action: "done", workItemId: id, roleId: "mockup-designer" });
  assert.equal(r.isError, false);
  assert.ok(!(r.json.warnings ?? []).some((w) => w.includes("stackdump")));
});

test("工作項目目錄與專案根有 stackdump：done 成功且警告列出路徑；node_modules 內的不算", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "mockup-designer");
  const itemDump = path.join(dir, "bash.exe.stackdump");
  const projDump = path.join(env.projectDir, "sh.exe.stackdump");
  const nested = path.join(env.projectDir, "node_modules", "x", "deep.stackdump");
  await mkdir(path.dirname(nested), { recursive: true });
  await Promise.all([writeFile(itemDump, "x"), writeFile(projDump, "x"), writeFile(nested, "x")]);
  try {
    await fulfil(dir, "mockup-designer");
    const r = await env.call({ action: "done", workItemId: id, roleId: "mockup-designer" });
    assert.equal(r.isError, false);
    const w = r.json.warnings.find((x) => x.includes("stackdump"));
    assert.ok(w.includes(itemDump) && w.includes(projDump));
    assert.ok(!w.includes("deep.stackdump"));
    assert.ok((await env.store.readStatus(id)).work_item_progress.roles["mockup-designer"].done);
  } finally {
    await Promise.all([rm(projDump, { force: true }), rm(path.join(env.projectDir, "node_modules"), { recursive: true, force: true })]);
  }
});

test("最終驗收摘要列出 stackdump；沒有時不出現該節", async () => {
  const clean = await env.create();
  await runUntil(env, clean.id, clean.dir, "final-acceptance-none");
  const ok = await env.call({ action: "confirm", workItemId: clean.id, gateId: "final-acceptance", decision: "confirmed", by: "human", reason: "使用者說驗收通過" });
  assert.equal(ok.json.stackdumpWarning, undefined);
  assert.doesNotMatch(await readFile(ok.json.summaryFile, "utf-8"), /stackdump/);

  const dirty = await env.create();
  await runUntil(env, dirty.id, dirty.dir, "final-acceptance-none");
  const dump = path.join(dirty.dir, "bash.exe.stackdump");
  await writeFile(dump, "x");
  const r = await env.call({ action: "confirm", workItemId: dirty.id, gateId: "final-acceptance", decision: "confirmed", by: "human", reason: "使用者說驗收通過" });
  assert.equal(r.isError, false);
  assert.match(r.json.stackdumpWarning, /bash\.exe\.stackdump/);
  const text = await readFile(r.json.summaryFile, "utf-8");
  assert.ok(text.includes("殘留的 stackdump") && text.includes(dump));
});
