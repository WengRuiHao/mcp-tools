// project_config 單一入口：每個 kind 的 resolve/register 往返、缺欄位錯誤、found:false 的 instructions。
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeTmpDir, removeDir, isolateDataDir, connectClient, callTool } from "./helpers/support.mjs";
import { registerProjectConfigTools } from "../dist/project-config-tools.js";
import { registerSvnWorkCopies } from "../dist/svn-workcopy-store.js";
import { SETUP_DEFAULT_PROJECT, SETUP_GIT_ROOTS, SETUP_PROJECT_DIR, SETUP_SASD_CONFIG } from "../dist/overview-prompts.js";

function withConfig(fn) {
  return async () => {
    const data = isolateDataDir();
    const dir = makeTmpDir("dpm-pc-");
    const conn = await connectClient(registerProjectConfigTools);
    const call = (args) => callTool(conn.client, "project_config", args);
    try {
      await fn(call, dir);
    } finally {
      await conn.close();
      removeDir(dir);
      data.cleanup();
    }
  };
}

test("default_project: found:false 帶 instructions，register 後依 cwd 找到", withConfig(async (call, dir) => {
  const miss = await call({ kind: "default_project", action: "resolve", cwd: dir });
  assert.equal(miss.json.found, false);
  assert.equal(miss.json.needsInput, true);
  assert.equal(miss.json.instructions, SETUP_DEFAULT_PROJECT);
  assert.match(miss.json.instructions, /project_config\(\{ kind: "default_project", action: "register"/);
  const reg = await call({ kind: "default_project", action: "register", workspaceGid: "W1", projectGid: "P1", projectName: "Proj", cwd: dir });
  assert.deepEqual(reg.json, { success: true, workspaceGid: "W1", projectGid: "P1", projectName: "Proj", cwd: dir });
  const hit = await call({ kind: "default_project", action: "resolve", cwd: dir });
  assert.equal(hit.json.found, true);
  assert.equal(hit.json.projectGid, "P1");
}));

test("project_dir: found:false 帶 instructions，register 後往返一致", withConfig(async (call, dir) => {
  const miss = await call({ kind: "project_dir", action: "resolve", projectGid: "PD" });
  assert.deepEqual([miss.json.found, miss.json.needsInput, miss.json.instructions], [false, true, SETUP_PROJECT_DIR]);
  assert.match(miss.json.instructions, /project_config\(\{ kind: "project_dir", action: "register"/);
  const reg = await call({ kind: "project_dir", action: "register", projectGid: "PD", projectDir: dir });
  assert.equal(reg.json.success, true);
  assert.match(reg.json.gatesHint, /gates\.example\.json/);
  const hit = await call({ kind: "project_dir", action: "resolve", projectGid: "PD" });
  assert.deepEqual(hit.json, { found: true, projectDir: path.resolve(dir) });
}));

test("sasd_config: found:false 帶 instructions；unregistered/N-A 往返；self-generated 規則照舊", withConfig(async (call) => {
  const miss = await call({ kind: "sasd_config", action: "resolve", projectGid: "PS" });
  assert.deepEqual([miss.json.found, miss.json.needsInput, miss.json.instructions], [false, true, SETUP_SASD_CONFIG]);
  assert.match(miss.json.instructions, /project_config\(\{ kind: "sasd_config", action: "register"/);

  const reg = await call({ kind: "sasd_config", action: "register", projectGid: "PS", saRoot: "N/A-無SA文件", sdMode: "unregistered" });
  assert.equal(reg.json.success, true);
  const hit = await call({ kind: "sasd_config", action: "resolve", projectGid: "PS" });
  assert.equal(hit.json.found, true);
  assert.equal(hit.json.saRoot, "N/A-無SA文件");
  assert.equal(hit.json.sdMode, "unregistered");
  assert.equal(hit.json.specOrder, null);

  const noOut = await call({ kind: "sasd_config", action: "register", projectGid: "PS2", saRoot: "N/A-x", sdMode: "self-generated" });
  assert.equal(noOut.isError, true);
  assert.match(noOut.json.message, /sdOutputPath/);
  const noOrder = await call({ kind: "sasd_config", action: "register", projectGid: "PS2", saRoot: "N/A-x", sdMode: "self-generated", sdOutputPath: "docs/sd.md" });
  assert.equal(noOrder.isError, true);
  assert.match(noOrder.json.message, /specOrder/);
  const ok = await call({ kind: "sasd_config", action: "register", projectGid: "PS2", saRoot: "N/A-x", sdMode: "self-generated", sdOutputPath: "docs/sd.md", specOrder: "code_first" });
  assert.equal(ok.json.success, true);
  assert.equal((await call({ kind: "sasd_config", action: "resolve", projectGid: "PS2" })).json.specOrder, "code_first");

  const noConn = await call({ kind: "sasd_config", action: "register", projectGid: "PS3", saRoot: "doc/sa", sdMode: "external" });
  assert.equal(noConn.isError, true);
  assert.match(noConn.json.message, /svnConnectionId/);
}));

test("legacy_test_profile: 預設 false、register 往返", withConfig(async (call) => {
  assert.deepEqual((await call({ kind: "legacy_test_profile", action: "resolve", projectGid: "PL" })).json, { legacyTestProfile: false });
  const reg = await call({ kind: "legacy_test_profile", action: "register", projectGid: "PL", legacyTestProfile: true });
  assert.deepEqual(reg.json, { success: true, projectGid: "PL", legacyTestProfile: true });
  assert.deepEqual((await call({ kind: "legacy_test_profile", action: "resolve", projectGid: "PL" })).json, { legacyTestProfile: true });
}));

test("test_capability: found:false、register 往返、mode 不合法被擋", withConfig(async (call) => {
  assert.deepEqual((await call({ kind: "test_capability", action: "resolve", projectGid: "PT" })).json, { found: false });
  const reg = await call({ kind: "test_capability", action: "register", projectGid: "PT", mode: "legacy_junit4", note: "JDK7 + JUnit 4.12" });
  assert.deepEqual(reg.json, { success: true, projectGid: "PT", mode: "legacy_junit4", note: "JDK7 + JUnit 4.12" });
  const hit = await call({ kind: "test_capability", action: "resolve", projectGid: "PT" });
  assert.equal(hit.json.found, true);
  assert.equal(hit.json.mode, "legacy_junit4");
  assert.equal(hit.json.note, "JDK7 + JUnit 4.12");
  const bad = await call({ kind: "test_capability", action: "register", projectGid: "PT", mode: "weird" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /mode/);
}));

test("git_roots: found:false 帶 instructions、register 往返", withConfig(async (call, dir) => {
  const miss = await call({ kind: "git_roots", action: "resolve", projectDir: dir });
  assert.deepEqual([miss.json.found, miss.json.needsInput, miss.json.instructions], [false, true, SETUP_GIT_ROOTS]);
  assert.match(miss.json.instructions, /project_config\(\{ kind: "git_roots", action: "register"/);
  const roots = [{ label: "共用", path: dir }];
  const reg = await call({ kind: "git_roots", action: "register", projectDir: dir, gitRoots: roots });
  assert.deepEqual(reg.json, { success: true, projectDir: dir, gitRoots: roots });
  const hit = await call({ kind: "git_roots", action: "resolve", projectDir: dir });
  assert.equal(hit.json.found, true);
  assert.equal(hit.json.gitRoots.length, 1);
  assert.equal(hit.json.gitRoots[0].label, "共用");
}));

test("svn_workcopies: found:false、已登記資料可讀回、register 驗證失敗時不登記", withConfig(async (call, dir) => {
  assert.deepEqual((await call({ kind: "svn_workcopies", action: "resolve", projectDir: dir })).json, { found: false });
  const wc = [{ label: "規格書", workCopyPath: path.join(dir, "not-a-working-copy"), connectionId: "nope" }];
  const reg = await call({ kind: "svn_workcopies", action: "register", projectDir: dir, workCopies: wc });
  assert.equal(reg.isError, true);
  assert.match(reg.json.message, /沒有登記/);
  assert.deepEqual((await call({ kind: "svn_workcopies", action: "resolve", projectDir: dir })).json, { found: false });
  // 儲存格式沿用：直接用 store 登記後，resolve 讀得回來
  await registerSvnWorkCopies(dir, wc);
  const hit = await call({ kind: "svn_workcopies", action: "resolve", projectDir: dir });
  assert.equal(hit.json.found, true);
  assert.deepEqual(hit.json.workCopies, wc);
}));

test("缺欄位：錯誤訊息指出是哪個 kind／action 缺什麼", withConfig(async (call, dir) => {
  const cases = [
    [{ kind: "project_dir", action: "resolve" }, /kind="project_dir", action="resolve".*缺少欄位 projectGid/],
    [{ kind: "project_dir", action: "register", projectGid: "X" }, /kind="project_dir", action="register".*缺少欄位 projectDir/],
    [{ kind: "default_project", action: "register", projectGid: "X" }, /kind="default_project".*缺少欄位 workspaceGid.*缺少欄位 projectName/],
    [{ kind: "sasd_config", action: "register", projectGid: "X" }, /kind="sasd_config".*缺少欄位 saRoot.*缺少欄位 sdMode/],
    [{ kind: "legacy_test_profile", action: "register", projectGid: "X" }, /kind="legacy_test_profile".*缺少欄位 legacyTestProfile/],
    [{ kind: "test_capability", action: "register", projectGid: "X" }, /kind="test_capability".*缺少欄位 mode/],
    [{ kind: "git_roots", action: "register", projectDir: dir }, /kind="git_roots".*缺少欄位 gitRoots/],
    [{ kind: "git_roots", action: "register", projectDir: dir, gitRoots: [] }, /kind="git_roots".*gitRoots/],
    [{ kind: "svn_workcopies", action: "resolve" }, /kind="svn_workcopies".*缺少欄位 projectDir/],
    [{ kind: "svn_workcopies", action: "register", projectDir: dir }, /kind="svn_workcopies".*缺少欄位 workCopies/],
  ];
  for (const [args, pattern] of cases) {
    const res = await call(args);
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.equal(res.json.success, false);
    assert.match(res.json.message, pattern, JSON.stringify(args));
  }
}));
