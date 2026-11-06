// 專案目錄裡的流程設定（.pipeline/settings.json 的 flow.profiles）：讀取優先序、寫入位置、壞檔不悄悄退回。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir, isolateDataDir } from "./helpers/support.mjs";
import {
  registerProjectDir, resolveProjectDir, registerSasdConfig, resolveSasdConfig,
  registerTestCapability, resolveTestCapability, registerLegacyTestProfile, resolveLegacyTestProfile,
  resolveUniformTestCapabilityMode,
} from "../dist/project-registry.js";
import { readFlowProfile, upsertFlowProfile } from "../dist/project-flow-settings.js";

const SETTINGS = path.join(".pipeline", "settings.json");
const SASD_EXTERNAL = { saRoot: "2-SA/spec", sdMode: "external", sdRoot: "3-SD/api", sdOutputPath: null, svnConnectionId: "conn-1", specOrder: null };
const SASD_SELF_GEN = { saRoot: "2-SA/spec", sdMode: "self-generated", sdRoot: null, sdOutputPath: "doc/spec", svnConnectionId: "conn-1", specOrder: "spec_first" };

function withEnv(fn) {
  return async () => {
    const data = isolateDataDir();
    const dir = makeTmpDir("dpm-flow-");
    try {
      await fn(dir, data);
    } finally {
      removeDir(dir);
      data.cleanup();
    }
  };
}
const settingsOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, SETTINGS), "utf-8"));
const writeSettings = (dir, text) => {
  fs.mkdirSync(path.join(dir, ".pipeline"), { recursive: true });
  fs.writeFileSync(path.join(dir, SETTINGS), typeof text === "string" ? text : JSON.stringify(text));
};

test("register：專案目錄可用時寫進 .pipeline/settings.json，不寫 MCP data，且保留既有欄位", withEnv(async (dir, data) => {
  writeSettings(dir, { onlyAssignedToMe: true });
  await registerProjectDir("P1", dir);
  assert.equal(await registerSasdConfig("P1", SASD_SELF_GEN), "project");
  assert.equal(await registerTestCapability("P1", { mode: "modern", note: null }), "project");
  assert.equal(await registerLegacyTestProfile("P1", true), "project");

  const s = settingsOf(dir);
  assert.equal(s.onlyAssignedToMe, true);
  assert.equal(s.flow.profiles.length, 1);
  assert.deepEqual(s.flow.profiles[0], { match: { projectGid: "P1" }, sasd: SASD_SELF_GEN, testCapability: { mode: "modern", note: null }, legacyTestProfile: true });
  assert.equal(fs.existsSync(path.join(data.dir, "sasd-config.json")), false);

  assert.deepEqual(await resolveSasdConfig("P1"), SASD_SELF_GEN);
  assert.equal(await resolveLegacyTestProfile("P1"), true);
}));

test("register：沒登記專案目錄（或目錄不存在）時退回寫 MCP data", withEnv(async (dir, data) => {
  assert.equal(await registerSasdConfig("P2", SASD_EXTERNAL), "mcp-data");
  await registerProjectDir("P3", path.join(dir, "not-there"));
  assert.equal(await registerSasdConfig("P3", SASD_EXTERNAL), "mcp-data");
  assert.equal(fs.existsSync(path.join(dir, SETTINGS)), false);
  assert.deepEqual(await resolveSasdConfig("P2"), SASD_EXTERNAL);
}));

test("resolve：專案目錄的 profile 優先於 MCP data；沒有 profile 時沿用舊資料", withEnv(async (dir, data) => {
  await registerSasdConfig("P4", SASD_EXTERNAL); // 先寫進 data（此時還沒登記目錄）
  await registerProjectDir("P4", dir);
  assert.deepEqual(await resolveSasdConfig("P4"), SASD_EXTERNAL); // 目錄沒有 profile → 舊資料
  await upsertFlowProfile(dir, "P4", { sasd: SASD_SELF_GEN });
  assert.deepEqual(await resolveSasdConfig("P4"), SASD_SELF_GEN); // 目錄有 → 以目錄為準
  assert.equal(await resolveTestCapability("P4"), null);
}));

test("同一個目錄的兩個 Asana 專案可以各自不同模式，互不影響", withEnv(async (dir) => {
  await registerProjectDir("PA", dir);
  await registerProjectDir("PB", dir);
  await registerSasdConfig("PA", SASD_EXTERNAL);
  await registerSasdConfig("PB", SASD_SELF_GEN);
  await registerTestCapability("PA", { mode: "modern", note: null });
  await registerTestCapability("PB", { mode: "none", note: "不寫自動化測試" });
  assert.equal((await resolveSasdConfig("PA")).sdMode, "external");
  assert.equal((await resolveSasdConfig("PB")).sdMode, "self-generated");
  assert.equal(settingsOf(dir).flow.profiles.length, 2);
  // 兩個專案測試能力不同 → 依目錄反查不出唯一模式；一致時才回傳
  assert.equal(await resolveUniformTestCapabilityMode(dir), null);
  await registerTestCapability("PB", { mode: "modern", note: null });
  assert.equal(await resolveUniformTestCapabilityMode(dir), "modern");
}));

test("upsert：只覆寫有帶的欄位，同一個專案不會長出第二筆", withEnv(async (dir) => {
  await upsertFlowProfile(dir, "PU", { sasd: SASD_EXTERNAL });
  await upsertFlowProfile(dir, "PU", { testCapability: { mode: "none", note: "n" } });
  await upsertFlowProfile(dir, "PU", { sasd: SASD_SELF_GEN });
  const s = settingsOf(dir);
  assert.equal(s.flow.profiles.length, 1);
  assert.deepEqual(s.flow.profiles[0].sasd, SASD_SELF_GEN);
  assert.deepEqual(s.flow.profiles[0].testCapability, { mode: "none", note: "n" });
}));

test("壞掉的 settings.json：讀取與登記都丟錯，且不覆蓋原檔", withEnv(async (dir) => {
  writeSettings(dir, "{ not json");
  await registerProjectDir("PX", dir);
  await assert.rejects(() => resolveSasdConfig("PX"), /不是合法的 JSON/);
  await assert.rejects(() => registerSasdConfig("PX", SASD_EXTERNAL), /不是合法的 JSON/);
  assert.equal(fs.readFileSync(path.join(dir, SETTINGS), "utf-8"), "{ not json");
}));

test("不合法的 profile 內容一律丟錯（不悄悄當成沒設定）", withEnv(async (dir) => {
  const bad = [
    [{ match: { projectGid: "B1" }, sasd: { ...SASD_EXTERNAL, sdMode: "whatever" } }, /sdMode/],
    [{ match: { projectGid: "B2" }, sasd: { ...SASD_SELF_GEN, specOrder: null } }, /self-generated/],
    [{ match: { projectGid: "B3" }, testCapability: { mode: "fast" } }, /testCapability\.mode/],
    [{ match: { projectGid: "B4" }, legacyTestProfile: "yes" }, /legacyTestProfile/],
    [{ sasd: SASD_EXTERNAL }, /match\.projectGid/],
  ];
  for (const [profile, pattern] of bad) {
    writeSettings(dir, { flow: { profiles: [profile] } });
    const gid = profile.match?.projectGid ?? "B5";
    await assert.rejects(() => readFlowProfile(dir, gid), pattern);
  }
  writeSettings(dir, { flow: { profiles: [{ match: { projectGid: "D" }, sasd: SASD_EXTERNAL }, { match: { projectGid: "D" } }] } });
  await assert.rejects(() => readFlowProfile(dir, "D"), /不只一筆/);
  writeSettings(dir, { flow: [] });
  await assert.rejects(() => readFlowProfile(dir, "D"), /flow 必須是/);
}));

test("settings.json 沒有 flow 或沒有該專案的 profile：回傳 null", withEnv(async (dir) => {
  assert.equal(await readFlowProfile(dir, "none"), null);
  writeSettings(dir, { onlyAssignedToMe: false });
  assert.equal(await readFlowProfile(dir, "none"), null);
  assert.equal(await resolveProjectDir("none"), null);
}));
