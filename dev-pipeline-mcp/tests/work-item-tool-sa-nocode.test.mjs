// work_item done sa-analyst：S14 SA 不寫程式檢查接進交件檢查，與 SA 截圖檢查並列回報。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, fulfil, runUntil } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-sanocode-");
after(() => env.cleanup());
const done = (id) => env.call({ action: "done", workItemId: id, roleId: "sa-analyst" });

test("done sa-analyst：含程式碼區塊或 SQL 被擋，修正後通過；mermaid 放行", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-analyst");
  await fulfil(dir, "sa-analyst");
  const sa = path.join(dir, "01-sa.md");
  await writeFile(sa, "## 功能：登入\n![畫面](sa-images/a.png)\n```java\nint x;\n```\nSELECT * FROM users\n");
  const bad = await done(id);
  assert.equal(bad.isError, true);
  const nc = bad.json.problems.filter((p) => p.includes("SA 不寫程式檢查未通過"));
  assert.equal(nc.length, 2);
  assert.ok(nc.some((p) => p.includes("第 3 行") && p.includes("程式碼區塊")));
  assert.ok(nc.some((p) => p.includes("第 6 行") && p.includes("SQL")));
  await writeFile(sa, "## 功能：登入\n![畫面](sa-images/a.png)\n```mermaid\nflowchart TD\nA-->B\n```\n");
  assert.equal((await done(id)).isError, false);
});

test("done sa-analyst：缺圖與含程式碼兩種違規一併回報，圖片檢查行為不變", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-analyst");
  await fulfil(dir, "sa-analyst");
  await writeFile(path.join(dir, "01-sa.md"), "## 功能：登入\nDROP TABLE t\n");
  const bad = await done(id);
  assert.equal(bad.isError, true);
  assert.ok(bad.json.problems.some((p) => p.includes("SA 截圖檢查未通過") && p.includes("缺圖引用")));
  assert.ok(bad.json.problems.some((p) => p.includes("SA 不寫程式檢查未通過")));
});
