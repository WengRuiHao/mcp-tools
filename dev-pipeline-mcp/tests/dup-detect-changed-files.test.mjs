import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mod, makeTmp, cleanup, write } from "./helpers/dup-helpers.mjs";

const { getChangedFiles } = mod;

function hasCmd(cmd) {
  try { execFileSync(cmd, ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });

test("非版本控制目錄回傳 null", async () => {
  const root = makeTmp();
  try {
    write(root, "a.js", "x");
    // 暫存目錄可能位於某個上層 git 工作樹內：用 GIT_CEILING_DIRECTORIES 讓 git 不往上找
    process.env.GIT_CEILING_DIRECTORIES = fs.realpathSync.native(path.dirname(root));
    assert.equal(await getChangedFiles(root), null);
  } finally { delete process.env.GIT_CEILING_DIRECTORIES; cleanup(root); }
});

test("git 工作樹：已修改、未追蹤列入；已刪除、二進位、被排除不列入", { skip: !hasCmd("git") && "本機沒有 git，略過" }, async () => {
  const root = makeTmp();
  try {
    git(root, "init", "-q");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    write(root, "keep.js", "a");
    write(root, "gone.js", "a");
    write(root, "sub/mod.js", "a");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "init");
    write(root, "keep.js", "b");
    write(root, "sub/new dir/un tracked.js", "c");
    write(root, "pic.png", Buffer.from([0, 1, 2]));
    write(root, "node_modules/x/y.js", "d");
    write(root, "bin.js", Buffer.from([0, 9, 9]));
    execFileSync("node", ["-e", "require('fs').unlinkSync('gone.js')"], { cwd: root });
    const files = await getChangedFiles(root);
    assert.deepEqual(files, ["keep.js", "sub/new dir/un tracked.js"]);
    // 子目錄當作 projectDir：只列該目錄內的檔案，路徑相對於子目錄
    const sub = await getChangedFiles(root + "/sub");
    assert.deepEqual(sub, ["new dir/un tracked.js"]);
  } finally { cleanup(root); }
});

test("svn 工作副本：A／M／? 列入", { skip: !(hasCmd("svn") && hasCmd("svnadmin")) && "本機沒有 svn／svnadmin，略過" }, async () => {
  const root = makeTmp();
  const repo = makeTmp();
  try {
    execFileSync("svnadmin", ["create", repo]);
    const url = "file:///" + repo.replace(/\\/g, "/").replace(/^\//, "");
    const wc = root + "/wc";
    execFileSync("svn", ["checkout", "-q", url, wc]);
    write(wc, "a.js", "1");
    execFileSync("svn", ["add", "-q", "a.js"], { cwd: wc });
    execFileSync("svn", ["commit", "-q", "-m", "init"], { cwd: wc });
    write(wc, "a.js", "2");
    write(wc, "added.js", "x");
    execFileSync("svn", ["add", "-q", "added.js"], { cwd: wc });
    write(wc, "dir/unv.js", "y");
    assert.deepEqual(await getChangedFiles(wc), ["a.js", "added.js", "dir/unv.js"]);
  } finally { cleanup(root); cleanup(repo); }
});
