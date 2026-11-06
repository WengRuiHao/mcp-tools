import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { resolveWorkItemIdArg, workItemIdParams } from "../dist/work-item.js";

test("只給 taskGid", () => {
  assert.equal(resolveWorkItemIdArg({ taskGid: "123" }), "123");
});

test("只給 workItemId", () => {
  assert.equal(resolveWorkItemIdArg({ workItemId: "abc" }), "abc");
});

test("兩者相同值", () => {
  assert.equal(resolveWorkItemIdArg({ taskGid: "1", workItemId: "1" }), "1");
});

test("兩者衝突丟錯並提示兩個參數名", () => {
  assert.throws(() => resolveWorkItemIdArg({ taskGid: "1", workItemId: "2" }), /taskGid.*workItemId/);
});

test("都缺丟錯並提示兩個參數名", () => {
  assert.throws(() => resolveWorkItemIdArg({}), /taskGid.*workItemId/);
});

test("空字串與純空白視為未提供", () => {
  assert.throws(() => resolveWorkItemIdArg({ taskGid: "", workItemId: "  " }), /缺少必要參數/);
  assert.equal(resolveWorkItemIdArg({ taskGid: "", workItemId: "x" }), "x");
});

test("前後空白被 trim，trim 後相同不算衝突", () => {
  assert.equal(resolveWorkItemIdArg({ taskGid: "  9 " }), "9");
  assert.equal(resolveWorkItemIdArg({ taskGid: " 5", workItemId: "5 " }), "5");
});

test("workItemIdParams 可展開進 zod object 且兩欄皆選填", () => {
  const schema = z.object({ ...workItemIdParams });
  assert.deepEqual(schema.parse({}), {});
  assert.equal(schema.parse({ workItemId: "a" }).workItemId, "a");
});
