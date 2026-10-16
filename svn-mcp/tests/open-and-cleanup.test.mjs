// 編輯時用哪個程式開檔、以及暫存資料夾的清理（絕不能清到進行中的編輯）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findVsCode, resolveEditorLaunch } from "../dist/os-open.js";
import { cleanupTransientDirs } from "../dist/remote-edit-client.js";

const w = path.win32;
const f = (name) => w.join("C:", "t", name);
const env = { LOCALAPPDATA: w.join("C:", "Users", "u", "AppData", "Local"), ProgramFiles: w.join("C:", "Program Files") };
const vscodeUser = w.join(env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe");
const hasUserVsCode = (p) => p === vscodeUser;

test("md：有 VS Code 就用 VS Code 開（只指定這次開檔，不改檔案關聯）", () => {
  assert.deepEqual(resolveEditorLaunch(f("a.md"), "win32", env, hasUserVsCode), { command: vscodeUser, args: [f("a.md")] });
  assert.equal(resolveEditorLaunch(f("A.MD"), "win32", env, hasUserVsCode)?.command, vscodeUser);
});

test("md：找不到 VS Code 就退回預設程式（null）", () => {
  assert.equal(resolveEditorLaunch(f("a.md"), "win32", env, () => false), null);
});

test("md：SVN_EDIT_VSCODE 可指定路徑；指到不存在的檔案視為找不到", () => {
  const custom = w.join("D:", "vs", "Code.exe");
  assert.equal(findVsCode({ SVN_EDIT_VSCODE: custom }, (p) => p === custom), custom);
  assert.equal(findVsCode({ SVN_EDIT_VSCODE: w.join("D:", "nope", "Code.exe") }, () => false), null);
});

test("csv：用記事本開；docx、xlsx、txt、pdf 維持預設程式", () => {
  assert.deepEqual(resolveEditorLaunch(f("a.csv"), "win32", env, () => false), { command: "notepad.exe", args: [f("a.csv")] });
  for (const name of ["a.docx", "a.xlsx", "a.txt", "a.pdf"]) assert.equal(resolveEditorLaunch(f(name), "win32", env, hasUserVsCode), null);
});

test("非 Windows：一律交給預設程式", () => {
  assert.equal(resolveEditorLaunch("/t/a.md", "linux", env, () => true), null);
  assert.equal(resolveEditorLaunch("/t/a.csv", "darwin", env, () => true), null);
});

test("清理：刪 view-*、batch-*、沒有 session.json 的空殼；保留進行中的編輯與 audit.log", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "svn-cleanup-test-"));
  process.env.SVN_EDIT_TEMP_DIR = base;
  try {
    const id = (n) => `${n.repeat(8)}-aaaa-bbbb-cccc-${n.repeat(12)}`;
    const mk = (name, files = { "x.bin": "1" }) => {
      fs.mkdirSync(path.join(base, name), { recursive: true });
      for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(base, name, file), content);
    };
    mk("view-1");
    mk("view-2");
    mk("batch-1", { "files.txt": "x" });
    mk(id("1"), {}); // 空殼
    mk(id("2"), { "session.json": "{}", "wc.txt": "編輯中" }); // 進行中的編輯
    fs.writeFileSync(path.join(base, "svn-edit-audit.log"), "log");

    assert.equal(cleanupTransientDirs().removed, 4);
    assert.deepEqual(fs.readdirSync(base).sort(), [id("2"), "svn-edit-audit.log"].sort());
    assert.equal(fs.readFileSync(path.join(base, id("2"), "wc.txt"), "utf-8"), "編輯中");
    assert.equal(cleanupTransientDirs().removed, 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("清理：暫存資料夾不存在也不會出錯", () => {
  process.env.SVN_EDIT_TEMP_DIR = path.join(os.tmpdir(), `svn-cleanup-not-exist-${Date.now()}`);
  assert.deepEqual(cleanupTransientDirs(), { removed: 0 });
});
