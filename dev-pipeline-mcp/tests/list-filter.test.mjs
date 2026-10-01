// list_pending_tickets 的過濾邏輯（純函式）。
import test from "node:test";
import assert from "node:assert/strict";
import { filterAndLimitTickets, localDateString } from "../dist/ticket-list-filter.js";

const TODAY = "2026-10-01";
const t = (id, dueOn) => ({ id, dueOn });
const ids = (r) => r.tickets.map((x) => x.id);

const sample = [t("none1", null), t("future", "2026-10-05"), t("today", TODAY), t("late", "2026-09-20"), t("none2"), t("today2", TODAY)];

test("no options: returns the same array untouched", () => {
  const r = filterAndLimitTickets(sample, { today: TODAY });
  assert.equal(r.tickets, sample);
  assert.equal(r.totalMatched, sample.length);
  assert.equal(r.truncated, false);
  const nulls = filterAndLimitTickets(sample, { dueOn: null, limit: null, today: TODAY });
  assert.equal(nulls.tickets, sample);
});

test("dueOn modes", () => {
  assert.deepEqual(ids(filterAndLimitTickets(sample, { dueOn: "today", today: TODAY })), ["today", "today2"]);
  assert.deepEqual(ids(filterAndLimitTickets(sample, { dueOn: "overdue", today: TODAY })), ["late"]);
  assert.deepEqual(ids(filterAndLimitTickets(sample, { dueOn: "today_or_overdue", today: TODAY })), ["late", "today", "today2"]);
  assert.deepEqual(ids(filterAndLimitTickets(sample, { dueOn: "2026-10-05", today: TODAY })), ["future"]);
  assert.deepEqual(ids(filterAndLimitTickets(sample, { dueOn: "2030-01-01", today: TODAY })), []);
});

test("tickets without due_on only appear when dueOn is not given, and sort last", () => {
  const r = filterAndLimitTickets(sample, { limit: 100, today: TODAY });
  assert.deepEqual(ids(r), ["late", "today", "today2", "future", "none1", "none2"]);
  for (const mode of ["today", "overdue", "today_or_overdue", "2026-10-05"]) {
    const filtered = filterAndLimitTickets(sample, { dueOn: mode, today: TODAY });
    assert.ok(!ids(filtered).includes("none1") && !ids(filtered).includes("none2"), mode);
  }
});

test("limit truncates after sorting and reports totalMatched / truncated", () => {
  const r = filterAndLimitTickets(sample, { limit: 2, today: TODAY });
  assert.deepEqual(ids(r), ["late", "today"]);
  assert.equal(r.totalMatched, 6);
  assert.equal(r.truncated, true);
  assert.match(r.truncatedNote, /6/);
  assert.match(r.truncatedNote, /2/);
});

test("limit equal to or above the match count does not truncate", () => {
  for (const limit of [6, 50]) {
    const r = filterAndLimitTickets(sample, { limit, today: TODAY });
    assert.equal(r.truncated, false);
    assert.equal(r.truncatedNote, undefined);
    assert.equal(r.totalMatched, 6);
  }
});

test("dueOn + limit: totalMatched is counted before truncation", () => {
  const r = filterAndLimitTickets(sample, { dueOn: "today_or_overdue", limit: 1, today: TODAY });
  assert.deepEqual(ids(r), ["late"]);
  assert.equal(r.totalMatched, 3);
  assert.equal(r.truncated, true);
});

test("sort is stable for equal due dates and does not mutate the input", () => {
  const input = [t("a", TODAY), t("b", TODAY), t("c", TODAY)];
  const copy = input.map((x) => ({ ...x }));
  assert.deepEqual(ids(filterAndLimitTickets(input, { limit: 10, today: TODAY })), ["a", "b", "c"]);
  assert.deepEqual(input, copy);
});

test("empty list", () => {
  const r = filterAndLimitTickets([], { dueOn: "today", limit: 3, today: TODAY });
  assert.deepEqual(r, { tickets: [], totalMatched: 0, truncated: false });
});

test("localDateString formats local date as YYYY-MM-DD", () => {
  assert.equal(localDateString(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(localDateString(new Date(2026, 11, 31, 0, 0)), "2026-12-31");
  assert.match(localDateString(), /^\d{4}-\d{2}-\d{2}$/);
});
