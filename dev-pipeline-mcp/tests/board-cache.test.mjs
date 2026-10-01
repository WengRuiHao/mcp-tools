import test from "node:test";
import assert from "node:assert/strict";
import { createBoardFetcher } from "../dist/board-cache.js";

function setup(responses) {
  const calls = [];
  let clock = 1_000_000;
  const queue = [...responses];
  const call = async (name, args) => {
    calls.push({ name, args });
    const next = queue.length > 0 ? queue.shift() : { success: true, tasks: [] };
    if (next instanceof Error) throw next;
    return next;
  };
  const fetchBoard = createBoardFetcher({ call, now: () => clock, ttlMs: 60_000 });
  return { calls, fetchBoard, advance: (ms) => (clock += ms) };
}

test("first call refreshes", async () => {
  const { calls, fetchBoard } = setup([]);
  const r = await fetchBoard("p1");
  assert.equal(calls[0].name, "asana_board");
  assert.deepEqual(calls[0].args, { projectGid: "p1", refresh: true });
  assert.equal(r.fromCache, false);
  assert.equal(r.ageSeconds, null);
});

test("call within ttl uses cache and reports age", async () => {
  const { calls, fetchBoard, advance } = setup([]);
  await fetchBoard("p1");
  advance(15_500);
  const r = await fetchBoard("p1");
  assert.equal(calls[1].args.refresh, false);
  assert.equal(r.fromCache, true);
  assert.equal(r.ageSeconds, 15);
});

test("call after ttl refreshes again and resets the clock", async () => {
  const { calls, fetchBoard, advance } = setup([]);
  await fetchBoard("p1");
  advance(60_000);
  const r = await fetchBoard("p1");
  assert.equal(calls[1].args.refresh, true);
  assert.equal(r.fromCache, false);
  advance(1_000);
  const r2 = await fetchBoard("p1");
  assert.equal(calls[2].args.refresh, false);
  assert.equal(r2.fromCache, true);
});

test("forceRefresh always refreshes", async () => {
  const { calls, fetchBoard } = setup([]);
  await fetchBoard("p1");
  const r = await fetchBoard("p1", { forceRefresh: true });
  assert.equal(calls[1].args.refresh, true);
  assert.equal(r.fromCache, false);
});

test("projects are independent", async () => {
  const { calls, fetchBoard } = setup([]);
  await fetchBoard("p1");
  const r = await fetchBoard("p2");
  assert.equal(calls[1].args.refresh, true);
  assert.equal(r.fromCache, false);
});

test("failed refresh does not update the clock", async () => {
  const { calls, fetchBoard } = setup([{ success: false, message: "x" }]);
  const r1 = await fetchBoard("p1");
  assert.equal(r1.board.success, false);
  const r2 = await fetchBoard("p1");
  assert.equal(calls[1].args.refresh, true);
  assert.equal(r2.fromCache, false);
});

test("failed forced refresh keeps the older successful timestamp semantics", async () => {
  const { calls, fetchBoard, advance } = setup([{ success: true }, { success: false }]);
  await fetchBoard("p1");
  advance(10_000);
  await fetchBoard("p1", { forceRefresh: true });
  advance(10_000);
  const r = await fetchBoard("p1");
  assert.equal(calls[2].args.refresh, false);
  assert.equal(r.ageSeconds, 20);
});

test("thrown errors propagate and do not update the clock", async () => {
  const { calls, fetchBoard } = setup([new Error("boom")]);
  await assert.rejects(() => fetchBoard("p1"), /boom/);
  await fetchBoard("p1");
  assert.equal(calls[1].args.refresh, true);
});
