// 問題 63：工程師 done 時比對 impl 改動檔案與 03-sd.md 引用的位置，差異只回 warnings、不擋交件。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, runUntil, fulfil, VALID_SD, REUSE_RECORD_OK, IMPL_LAYERS_OK } from "./helpers/work-item-env.mjs";
import { compareSdWithImpl } from "../dist/workflow/sd-impl-files-check.js";

const env = await setupEnv("wi-eng-b-sdimpl-");
after(() => env.cleanup());
const impl = (files) => `說明\n${REUSE_RECORD_OK}## 改動檔案\n${files.map((f) => `- ${f}`).join("\n")}\n`;

test("單元：前端位置一致、無差異回空；impl 沒有改動檔案清單時跳過", () => {
  assert.deepEqual(compareSdWithImpl(VALID_SD, impl(["src/ui/login-page.js"]), "frontend"), []);
  assert.deepEqual(compareSdWithImpl(VALID_SD, "沒有改動檔案這一節", "frontend"), []);
  assert.deepEqual(compareSdWithImpl(VALID_SD, "", "backend"), []);
});

test("單元：改了 SD 沒提到的新檔案，且 SD 宣告的前端位置沒被改到，兩項都警告", () => {
  const w = compareSdWithImpl(VALID_SD, impl(["src/ui/orders-page.js"]), "frontend");
  assert.equal(w.length, 2);
  assert.match(w[0], /SD 沒提到的程式檔：src\/ui\/orders-page\.js/);
  assert.match(w[0], /請更新 03-sd\.md 的位置欄，或在 impl-fe\.md 說明偏離 SD 的原因/);
  assert.match(w[1], /前端位置.*src\/ui\/login-page\.js/);
});

test("單元：測試檔、非程式檔、SD 有提到的檔名不算差異；後端比對三層檔案", () => {
  assert.deepEqual(compareSdWithImpl(VALID_SD, impl(["src/ui/login-page.js", "tests/login.test.js", "README.md", "src/ui/orders.css"]), "frontend").filter((x) => /沒提到/.test(x)).length, 1);
  assert.deepEqual(compareSdWithImpl(VALID_SD, impl(["src/api/login-controller.js", "src/api/login-service.js", "src/api/login-repository.js"]), "backend"), []);
  const w = compareSdWithImpl(VALID_SD, impl(["src/api/login-controller.js", "src/api/extra-service.js"]), "backend");
  assert.ok(w.some((x) => /extra-service\.js/.test(x)));
  assert.ok(w.some((x) => /login-service\.js/.test(x) && /login-repository\.js/.test(x)));
});

test("done：前端工程師改動與 SD 位置一致，沒有 warnings", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "frontend-engineer");
  await fulfil(dir, "frontend-engineer");
  const r = await env.call({ action: "done", workItemId: id, roleId: "frontend-engineer" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.warnings, undefined);
});

test("done：前端工程師改到 SD 沒寫的新檔案，交件成功但回 warnings", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "frontend-engineer");
  await fulfil(dir, "frontend-engineer");
  await writeFile(path.join(dir, "impl-fe.md"), impl(["src/ui/orders-page.js"]));
  const r = await env.call({ action: "done", workItemId: id, roleId: "frontend-engineer" });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.json.warnings.some((w) => /orders-page\.js/.test(w) && /03-sd\.md/.test(w)));
  assert.ok((await env.store.readStatus(id)).work_item_progress.roles["frontend-engineer"].done);
});

test("done：後端工程師三層檔案只改了一部分，warnings 列出 SD 宣告但沒改的檔案", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "backend-engineer");
  await fulfil(dir, "backend-engineer");
  const r = await env.call({ action: "done", workItemId: id, roleId: "backend-engineer" });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.json.warnings.some((w) => /login-controller\.js/.test(w) && /login-repository\.js/.test(w)));
  assert.ok(IMPL_LAYERS_OK.length > 0 && VALID_SD.length > 0);
});
