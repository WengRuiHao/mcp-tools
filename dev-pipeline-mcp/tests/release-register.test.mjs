// 批次 1M：放行登記（專案層文件 release-register.md）的解析、格式化與逾期判斷。
import test from "node:test";
import assert from "node:assert/strict";
import { RELEASE_FILE, DEFAULT_RELEASE_DAYS, addDays, formatReleaseLine, parseReleases, overdueReleases, isIsoDate } from "../dist/release-register.js";
import { PROJECT_DOC_NAMES } from "../dist/project-docs-store.js";

test("白名單含 release-register.md", () => assert.ok(PROJECT_DOC_NAMES.includes(RELEASE_FILE)));

test("addDays：跨月、跨年", () => {
  assert.equal(addDays("2026-11-25", 30), "2026-12-25");
  assert.equal(addDays("2026-12-20", 30), "2027-01-19");
  assert.equal(DEFAULT_RELEASE_DAYS, 30);
});

test("isIsoDate：只接受真實存在的 YYYY-MM-DD", () => {
  assert.ok(isIsoDate("2026-02-28"));
  assert.ok(!isIsoDate("2026-02-30"));
  assert.ok(!isIsoDate("2026/02/28"));
  assert.ok(!isIsoDate(""));
});

test("格式化後可解析回來；原因裡的分隔符號與換行被清掉", () => {
  const line = formatReleaseLine({ workItemId: "wi-20261125-001", problems: ["依賴 A 未完成｜還沒驗收", "系統模組「權限」未完成"], quote: "先做\n我負責", releasedAt: "2026-11-25", due: "2026-12-25" });
  assert.ok(!line.slice(2).includes("\n"));
  const [r] = parseReleases(`# 放行登記\n${line}\n`);
  assert.equal(r.workItemId, "wi-20261125-001");
  assert.equal(r.releasedAt, "2026-11-25");
  assert.equal(r.due, "2026-12-25");
  assert.match(r.reason, /依賴 A 未完成/);
  assert.match(r.reason, /先做 我負責/);
});

test("逾期：到期日早於今天才算，當天不算；沒到期日或格式錯的不算", () => {
  const text = ["- wi-20261101-001｜原因甲｜放行日：2026-11-01｜到期日：2026-11-24", "- wi-20261101-002｜原因乙｜放行日：2026-11-01｜到期日：2026-11-25", "- wi-20261101-003｜原因丙｜放行日：2026-11-01"].join("\n");
  const over = overdueReleases(parseReleases(text), "2026-11-25");
  assert.deepEqual(over.map((r) => r.workItemId), ["wi-20261101-001"]);
});
