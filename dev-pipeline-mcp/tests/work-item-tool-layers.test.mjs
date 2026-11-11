// 步驟 F：後端工程師交件時的 SD 分層落地檢查（透過 work_item done）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, runUntil, fulfil, IMPL_LAYERS_OK, REUSE_RECORD_OK, CHANGED_FILES_BE, writeLayerFiles } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-layers-");
after(() => env.cleanup());
const done = (id) => env.call({ action: "done", workItemId: id, roleId: "backend-engineer" });

test("缺 API 落地清單、檔案不存在、方法找不到都擋下；補齊後通過", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "frontend-engineer");
  const impl = (layers) => writeFile(path.join(dir, "impl-be.md"), `BE\n${layers}${REUSE_RECORD_OK}${CHANGED_FILES_BE}`);
  await impl("");
  const r1 = await done(id);
  assert.equal(r1.isError, true);
  assert.ok(r1.json.problems.some((p) => p.includes("SD 分層落地檢查未通過") && p.includes("缺少「## API 落地清單」")));
  await impl(IMPL_LAYERS_OK);
  const r2 = await done(id);
  assert.ok(r2.json.problems.some((p) => p.includes("Controller（src/api/login-controller.js）檔案不存在於專案目錄")));
  await writeLayerFiles(env.projectDir);
  await writeFile(path.join(env.projectDir, "src", "api", "login-repository.js"), "export function other() {}\n");
  const r3 = await done(id);
  assert.ok(r3.json.problems.some((p) => p.includes("Repository") && p.includes("找不到宣告的方法：findAccount")));
  await rm(path.join(env.projectDir, "src", "api", "login-repository.js"));
  await writeLayerFiles(env.projectDir);
  assert.equal((await done(id)).isError, false);
});

test("fulfil 產生的合格交件（含落地清單與三層檔案）可通過", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "frontend-engineer");
  await fulfil(dir, "backend-engineer");
  assert.equal((await done(id)).isError, false);
});
