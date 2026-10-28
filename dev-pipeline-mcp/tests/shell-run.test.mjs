import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.DEV_PIPELINE_TEST_DIST ? path.resolve(process.env.DEV_PIPELINE_TEST_DIST) : path.resolve("dist");
const { runShell } = await import(pathToFileURL(path.join(dist, "shell-tools.js")).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shell-run-"));

test("success keeps shape (no exitCode/timedOut)", async () => {
  const r = await runShell(tmp, "node -e \"console.log('hi')\"", null);
  assert.equal(r.ok, true);
  assert.equal(r.stdout.trim(), "hi");
  assert.equal(r.exitCode, undefined);
  assert.equal(r.timedOut, undefined);
});

test("non-zero exit returns stdout/stderr/exitCode", async () => {
  const r = await runShell(tmp, "node -e \"console.log('out1');console.error('err1');process.exit(3)\"; exit $LASTEXITCODE", null);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.stdout, /out1/);
  assert.match(r.stderr, /err1/);
  assert.ok(!/Command failed/.test(r.message));
});

test("timeout kills and returns partial output with timedOut", async () => {
  const startupBegin = Date.now();
  await runShell(tmp, "node -e \"1\"", null);
  const startupMs = Date.now() - startupBegin;
  const timeoutMs = Math.min(600000, startupMs * 2 + 4000);

  const t0 = Date.now();
  const r = await runShell(tmp, "node -e \"console.log('partial');setTimeout(()=>{},120000)\"", null, timeoutMs);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(r.stdout, /partial/);
  assert.match(r.message, new RegExp(`逾時 ${timeoutMs} ms，已中止`));
  assert.ok(Date.now() - t0 < timeoutMs + Math.max(10000, startupMs));
});

test("timeoutMs is clamped to 600000 (huge value still runs normally)", async () => {
  const r = await runShell(tmp, "node -e \"console.log(1)\"", null, 99999999);
  assert.equal(r.ok, true);
});

test("blocked git behaviour unchanged", async () => {
  for (const c of ["git push origin main", "git reset --hard", "git clean -fd", "git checkout -- .", "git restore x", "git branch -D x", "git status --force"]) {
    const r = await runShell(tmp, c, [{ label: "a", path: tmp }]);
    assert.equal(r.blocked, true, c);
    assert.equal(r.stdout, "");
  }
  const none = await runShell(tmp, "git status", null);
  assert.equal(none.blocked, true);
  assert.match(none.message, /還沒有登記/);
});

test("git root mismatch message explains checked directory", async () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "shell-root-"));
  const r = await runShell(tmp, "git status", [{ label: "x", path: other }]);
  assert.equal(r.blocked, true);
  assert.ok(r.message.includes(tmp) || /找不到有效的 git repo/.test(r.message));
  assert.match(r.message, /驗證實際檢查的目錄是/);
  assert.match(r.message, /沒有 `Set-Location/);
  const sub = path.join(tmp, "sub");
  fs.mkdirSync(sub, { recursive: true });
  const r2 = await runShell(tmp, "Set-Location sub; git status", [{ label: "x", path: other }]);
  assert.equal(r2.blocked, true);
  assert.match(r2.message, /取自指令開頭的 Set-Location/);
  assert.ok(r2.message.includes(sub));
  fs.rmSync(other, { recursive: true, force: true });
});
