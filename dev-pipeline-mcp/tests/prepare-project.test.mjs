// prepare_project：開工準備一次查完預設專案、程式碼目錄、規格設定、git 根目錄；缺項列在 missing。
import test from "node:test";
import assert from "node:assert/strict";
import { makeTmpDir, removeDir, isolateDataDir, connectClient, callTool } from "./helpers/support.mjs";
import { registerProjectConfigTools } from "../dist/project-config-tools.js";
import { SETUP_DEFAULT_PROJECT, SETUP_GIT_ROOTS, SETUP_PROJECT_DIR, SETUP_SASD_CONFIG } from "../dist/overview-prompts.js";

function withPrepare(fn) {
  return async () => {
    const data = isolateDataDir();
    const dir = makeTmpDir("dpm-prep-");
    const conn = await connectClient(registerProjectConfigTools);
    const config = (args) => callTool(conn.client, "project_config", args);
    const prepare = (args) => callTool(conn.client, "prepare_project", args);
    try {
      await fn({ config, prepare, dir });
    } finally {
      await conn.close();
      removeDir(dir);
      data.cleanup();
    }
  };
}

test("prepare_project: 什麼都沒登記時只回報缺預設專案，並帶設定問答說明", withPrepare(async ({ prepare, dir }) => {
  const res = await prepare({ cwd: dir });
  assert.equal(res.isError, false);
  assert.equal(res.json.ready, false);
  assert.equal(res.json.projectGid, null);
  assert.deepEqual(res.json.missing.map((m) => m.kind), ["default_project"]);
  assert.equal(res.json.missing[0].instructions, SETUP_DEFAULT_PROJECT);
  assert.match(res.json.nextStep, /default_project/);
}));

test("prepare_project: 缺項依序列出，project_dir 沒登記時不查 git_roots", withPrepare(async ({ config, prepare, dir }) => {
  await config({ kind: "default_project", action: "register", workspaceGid: "W1", projectGid: "P1", projectName: "Demo 專案", cwd: dir });
  const res = await prepare({ cwd: dir });
  assert.equal(res.json.ready, false);
  assert.equal(res.json.projectGid, "P1");
  assert.equal(res.json.projectName, "Demo 專案");
  assert.deepEqual(res.json.missing.map((m) => m.kind), ["project_dir", "sasd_config"]);
  assert.equal(res.json.missing[0].instructions, SETUP_PROJECT_DIR);
  assert.equal(res.json.missing[1].instructions, SETUP_SASD_CONFIG);
  assert.equal(res.json.projectDir, null);
  assert.equal(res.json.gitRoots, null);
}));

test("prepare_project: 有 projectDir 才檢查 git_roots，缺少時帶說明", withPrepare(async ({ config, prepare, dir }) => {
  await config({ kind: "default_project", action: "register", workspaceGid: "W1", projectGid: "P1", projectName: "Demo 專案", cwd: dir });
  await config({ kind: "project_dir", action: "register", projectGid: "P1", projectDir: dir });
  await config({ kind: "sasd_config", action: "register", projectGid: "P1", saRoot: "N/A-無SA文件", sdMode: "unregistered" });
  const res = await prepare({ cwd: dir });
  assert.equal(res.json.ready, false);
  assert.deepEqual(res.json.missing.map((m) => m.kind), ["git_roots"]);
  assert.equal(res.json.missing[0].instructions, SETUP_GIT_ROOTS);
  assert.equal(res.json.sasd.sdMode, "unregistered");
  assert.ok(res.json.projectDir);
}));

test("prepare_project: 四項都登記後 ready，並回傳設定值", withPrepare(async ({ config, prepare, dir }) => {
  await config({ kind: "default_project", action: "register", workspaceGid: "W1", projectGid: "P1", projectName: "Demo 專案", cwd: dir });
  await config({ kind: "project_dir", action: "register", projectGid: "P1", projectDir: dir });
  await config({ kind: "sasd_config", action: "register", projectGid: "P1", saRoot: "N/A-無SA文件", sdMode: "unregistered" });
  await config({ kind: "git_roots", action: "register", projectDir: dir, gitRoots: [{ label: "後端", path: dir }] });
  const res = await prepare({ cwd: dir });
  assert.equal(res.json.ready, true);
  assert.deepEqual(res.json.missing, []);
  assert.equal(res.json.projectName, "Demo 專案");
  assert.equal(res.json.workspaceGid, "W1");
  assert.equal(res.json.gitRoots[0].label, "後端");
  assert.match(res.json.nextStep, /list_pending_tickets/);
}));

test("prepare_project: 帶 projectGid 時略過預設專案查詢（projectName 為 null）", withPrepare(async ({ config, prepare }) => {
  await config({ kind: "sasd_config", action: "register", projectGid: "P9", saRoot: "N/A-無SA文件", sdMode: "unregistered" });
  const res = await prepare({ projectGid: "P9" });
  assert.equal(res.json.projectGid, "P9");
  assert.equal(res.json.projectName, null);
  assert.deepEqual(res.json.missing.map((m) => m.kind), ["project_dir"]);
  assert.equal(res.json.sasd.sdMode, "unregistered");
}));

test("prepare_project: 只讀，不會因為查詢而登記任何設定", withPrepare(async ({ config, prepare, dir }) => {
  await prepare({ cwd: dir });
  const res = await config({ kind: "default_project", action: "resolve", cwd: dir });
  assert.equal(res.json.found, false);
}));
