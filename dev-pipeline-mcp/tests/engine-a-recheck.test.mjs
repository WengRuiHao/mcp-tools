// 問題 55：角色 done 後重寫產出檔，write 自動重跑交件內容檢查並把結果放進回傳。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, runUntil } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-eng-a-recheck-");
after(() => env.cleanup());
const write = (id, filename, content) => env.call({ action: "write", workItemId: id, filename, content });

test("角色尚未 done：write 行為不變、沒有 recheck", async () => {
  const { id } = await env.create();
  const r = await write(id, "01-sa.md", "# 草稿\n");
  assert.equal(r.isError, false);
  assert.equal(r.json.recheck, undefined);
  assert.equal(r.json.warning, undefined);
});

test("已 done 的 SA 重寫成不合格內容：write 成功但回警告與失敗清單；改回合格後 ok", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  const good = await readFile(path.join(dir, "01-sa.md"), "utf-8");
  const bad = await write(id, "01-sa.md", "# 需求\n沒有圖\n");
  assert.equal(bad.isError, false);
  assert.equal(await readFile(path.join(dir, "01-sa.md"), "utf-8"), "# 需求\n沒有圖\n");
  assert.equal(bad.json.recheck.ok, false);
  assert.ok(bad.json.recheck.failures.some((f) => f.includes("至少要有一張圖")));
  assert.match(bad.json.warning, /sa-analyst.*已經 done.*未通過/);
  const fixed = await write(id, "01-sa.md", good);
  assert.equal(fixed.isError, false);
  assert.deepEqual(fixed.json.recheck, { ok: true, failures: [] });
  assert.equal(fixed.json.warning, undefined);
});

test("已 done 角色的附屬輸出（sa-notes.md）重寫也會重跑；未 done 角色的檔案不重跑", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  assert.equal((await write(id, "sa-notes.md", "## 待確認問題\n- 無\n")).json.recheck.ok, true);
  assert.equal((await write(id, "02-db.sql", "CREATE TABLE x (id INT);")).json.recheck, undefined);
});

test("已 done 的 db-designer 重寫 TableSchema 文件：重跑資料表結構檢查", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "flow-analyst");
  const r = await write(id, "TableSchema/t.md", "# 壞掉的文件\n");
  assert.equal(r.isError, false);
  assert.equal(r.json.recheck.ok, false);
  assert.ok(r.json.recheck.failures.some((f) => f.includes("資料表結構文件檢查未通過")));
});
