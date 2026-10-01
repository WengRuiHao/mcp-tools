// 預設專案依工作目錄解析（project-registry）。
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { isolateDataDir, connectClient, callTool } from "./helpers/support.mjs";
import { resolveDefaultProject, registerDefaultProject } from "../dist/project-registry.js";
import { registerProjectConfigTools } from "../dist/project-config-tools.js";

const proj = (n) => ({ workspaceGid: "W", projectGid: `P-${n}`, projectName: `Project ${n}` });
const base = path.join(os.tmpdir(), "dpm-registry-fixture"); // 只當路徑字串用，不需要真的存在
const at = (...parts) => path.join(base, ...parts);

function isolated(fn) {
  return async () => {
    const data = isolateDataDir();
    try {
      await fn();
    } finally {
      data.cleanup();
    }
  };
}

test("exact directory and subdirectories resolve to the registered project", isolated(async () => {
  await registerDefaultProject(proj("A"), at("a"));
  assert.deepEqual(await resolveDefaultProject(at("a")), proj("A"));
  assert.deepEqual(await resolveDefaultProject(at("a", "src", "deep")), proj("A"));
}));

test("the nearest registered ancestor wins", isolated(async () => {
  await registerDefaultProject(proj("outer"), at("a"));
  await registerDefaultProject(proj("inner"), at("a", "b"));
  assert.deepEqual(await resolveDefaultProject(at("a", "b", "c")), proj("inner"));
  assert.deepEqual(await resolveDefaultProject(at("a", "b")), proj("inner"));
  assert.deepEqual(await resolveDefaultProject(at("a", "x")), proj("outer"));
}));

test("a directory sharing only a name prefix is not matched", isolated(async () => {
  await registerDefaultProject(proj("foo"), at("a", "foo"));
  assert.equal(await resolveDefaultProject(at("a", "foobar")), null);
  assert.equal(await resolveDefaultProject(at("a", "fo")), null);
  assert.equal(await resolveDefaultProject(at("a")), null); // 往上不會匹配到子目錄的登記
  assert.deepEqual(await resolveDefaultProject(at("a", "foo", "bar")), proj("foo"));
}));

test("trailing separators are ignored on both register and resolve", isolated(async () => {
  await registerDefaultProject(proj("T"), at("a") + path.sep);
  assert.deepEqual(await resolveDefaultProject(at("a")), proj("T"));
  assert.deepEqual(await resolveDefaultProject(at("a") + path.sep), proj("T"));
  assert.deepEqual(await resolveDefaultProject(at("a", "b") + path.sep), proj("T"));
}));

test("case handling follows the platform (case-insensitive on Windows only)", isolated(async () => {
  await registerDefaultProject(proj("C"), at("CaseDir"));
  const found = await resolveDefaultProject(at("casedir", "x"));
  if (process.platform === "win32") assert.deepEqual(found, proj("C"));
  else assert.equal(found, null);
}));

test("re-registering the same directory overwrites it", isolated(async () => {
  await registerDefaultProject(proj("old"), at("a"));
  await registerDefaultProject(proj("new"), at("a") + path.sep);
  assert.deepEqual(await resolveDefaultProject(at("a")), proj("new"));
}));

test("without cwd the legacy global value is read; with cwd it is never borrowed", isolated(async () => {
  assert.equal(await resolveDefaultProject(), null);
  assert.equal(await resolveDefaultProject(null), null);
  await registerDefaultProject(proj("global"));
  assert.deepEqual(await resolveDefaultProject(), proj("global"));
  assert.deepEqual(await resolveDefaultProject(null), proj("global"));
  assert.equal(await resolveDefaultProject(at("unregistered")), null);
  assert.deepEqual(await resolveDefaultProject(""), proj("global")); // 空字串視同沒帶 cwd
}));

test("registering with cwd does not change the global value", isolated(async () => {
  await registerDefaultProject(proj("scoped"), at("a"));
  assert.equal(await resolveDefaultProject(), null);
  await registerDefaultProject(proj("global"));
  await registerDefaultProject(proj("scoped2"), at("b"));
  assert.deepEqual(await resolveDefaultProject(), proj("global"));
  assert.deepEqual(await resolveDefaultProject(at("a")), proj("scoped"));
}));

test("tools: register_default_project / resolve_default_project round trip with cwd", isolated(async () => {
  const { client, close } = await connectClient(registerProjectConfigTools);
  try {
    const miss = await callTool(client, "resolve_default_project", { cwd: at("t") });
    assert.equal(miss.json.found, false);
    const reg = await callTool(client, "register_default_project", { ...proj("tool"), cwd: at("t") });
    assert.equal(reg.json.success, true);
    const hit = await callTool(client, "resolve_default_project", { cwd: at("t", "sub") });
    assert.equal(hit.json.found, true);
    assert.equal(hit.json.projectGid, "P-tool");
    const other = await callTool(client, "resolve_default_project", { cwd: at("elsewhere") });
    assert.equal(other.json.found, false);
    const global = await callTool(client, "resolve_default_project", {});
    assert.equal(global.json.found, false);
  } finally {
    await close();
  }
}));
