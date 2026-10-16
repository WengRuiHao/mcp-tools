// 批次上傳逾時：檔案越多、越大，給 svn 的時間越長，但有上限。
import test from "node:test";
import assert from "node:assert/strict";
import { batchTimeoutMs } from "../dist/remote-import-batch.js";

const BASE = 300_000;

test("小批次維持基本逾時附近", () => {
  assert.equal(batchTimeoutMs(BASE, 0, 0), BASE);
  assert.ok(batchTimeoutMs(BASE, 3, 1024) < BASE + 10_000);
});

test("2455 個檔案、58 MB 的逾時明顯高於基本逾時", () => {
  assert.ok(batchTimeoutMs(BASE, 2455, 58 * 1024 * 1024) > BASE * 5);
});

test("逾時上限為 24 小時；十萬個檔案的批次也不會一開始就被判逾時", () => {
  assert.equal(batchTimeoutMs(BASE, 300000, 4 * 1024 * 1024 * 1024), 24 * 60 * 60 * 1000);
  assert.ok(batchTimeoutMs(BASE, 100000, 1024 * 1024 * 1024) > 10 * 60 * 60 * 1000, "十萬檔要給十幾小時的餘裕");
  assert.ok(batchTimeoutMs(BASE, 100000, 1024 * 1024 * 1024) < 24 * 60 * 60 * 1000);
});

test("結果一定是整數（Node 的 timeout 只收整數）", () => {
  assert.ok(Number.isInteger(batchTimeoutMs(BASE, 1, 1234567)));
});
