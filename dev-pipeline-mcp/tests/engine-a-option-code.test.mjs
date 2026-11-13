// 問題 4：human 確認的 reason 只有 1～3 個 ASCII 英數字（選項代號）時拒絕，明確同意詞與中文原話放行。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupEnv, runUntil } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-eng-a-opt-");
after(() => env.cleanup());
const confirm = (id, reason) => env.call({ action: "confirm", workItemId: id, gateId: "mockup-confirm", decision: "confirmed", by: "human", reason });

async function ready() {
  const { id, dir } = await env.create({ styleSource: "new-guided" });
  await runUntil(env, id, dir, "mockup-confirm");
  return id;
}

test("選項代號（A、AA、1、b2、B2C）被拒絕並說明要再問一次", async () => {
  const id = await ready();
  for (const code of ["A", "AA", "1", " b2 ", "B2C"]) {
    const r = await confirm(id, code);
    assert.equal(r.isError, true, code);
    assert.match(r.json.message, /選項代號/, code);
    assert.match(r.json.message, /再問一次/, code);
  }
  assert.equal((await env.store.readStatus(id)).work_item_progress.gates["mockup-confirm"], undefined);
});

test("明確同意詞 ok／OK／Yes 與中文原話放行", async () => {
  for (const reason of ["ok", "OK", "Yes", "確認", "同意", "A 方案，確認"]) {
    const id = await ready();
    const r = await confirm(id, reason);
    assert.equal(r.isError, false, `${reason}：${r.text}`);
  }
});

test("單字元 y 不是選項代號錯誤（仍受最少字元規則擋下）", async () => {
  const id = await ready();
  const r = await confirm(id, "y");
  assert.equal(r.isError, true);
  assert.doesNotMatch(r.json.message, /選項代號/);
});

test("超過 3 個英數字的原話不受影響", async () => {
  const id = await ready();
  const r = await confirm(id, "ABCD");
  assert.equal(r.isError, false, r.text);
});

test("既有規則維持：空白 reason 仍被拒絕", async () => {
  const id = await ready();
  const r = await confirm(id, "  ");
  assert.equal(r.isError, true);
  assert.match(r.json.message, /原話/);
});
