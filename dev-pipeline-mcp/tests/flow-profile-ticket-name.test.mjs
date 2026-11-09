// 同一個 Asana 專案依票名切換 profile（match.ticketNamePattern）：選擇規則、驗證規則、向下相容。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir, isolateDataDir } from "./helpers/support.mjs";
import {
  registerProjectDir, resolveSasdConfig, resolveTestCapability, resolveLegacyTestProfile,
  registerSasdConfig, resolveUniformTestCapabilityMode,
} from "../dist/project-registry.js";
import { readFlowProfile } from "../dist/project-flow-settings.js";

const GID = "p-test-1";
const REPORT_PATTERN = "RPT|a_report_";
const SASD_CODE_FIRST = { saRoot: "N/A-sa", sdMode: "self-generated", sdRoot: null, sdOutputPath: "doc/sd", svnConnectionId: null, specOrder: "code_first" };
const SASD_SPEC_FIRST = { ...SASD_CODE_FIRST, specOrder: "spec_first" };
const TWO_PROFILES = [
  { match: { projectGid: GID, ticketNamePattern: REPORT_PATTERN }, sasd: SASD_CODE_FIRST, testCapability: { mode: "none", note: "report" }, legacyTestProfile: true },
  { match: { projectGid: GID }, sasd: SASD_SPEC_FIRST, testCapability: { mode: "modern", note: null } },
];

function withEnv(fn) {
  return async () => {
    const data = isolateDataDir();
    const dir = makeTmpDir("dpm-flowname-");
    try {
      await registerProjectDir(GID, dir);
      await fn(dir, data);
    } finally {
      removeDir(dir);
      data.cleanup();
    }
  };
}
const writeProfiles = (dir, profiles) => {
  fs.mkdirSync(path.join(dir, ".pipeline"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pipeline", "settings.json"), JSON.stringify({ flow: { profiles } }));
};

test("舊格式（沒有 ticketNamePattern）：帶不帶票名結果相同、格式逐字不變", withEnv(async (dir) => {
  writeProfiles(dir, [{ match: { projectGid: GID }, sasd: SASD_SPEC_FIRST }]);
  assert.deepEqual(await resolveSasdConfig(GID), SASD_SPEC_FIRST);
  assert.deepEqual(await resolveSasdConfig(GID, "RPT 任意票名"), SASD_SPEC_FIRST);
  assert.deepEqual((await readFlowProfile(dir, GID)).match, { projectGid: GID });
}));

test("兩筆 profile：票名符合 pattern -> 有 pattern 那筆", withEnv(async (dir) => {
  writeProfiles(dir, TWO_PROFILES);
  assert.equal((await resolveSasdConfig(GID, "RPT-001 月報表")).specOrder, "code_first");
  assert.equal((await resolveSasdConfig(GID, "新增 a_report_x")).specOrder, "code_first");
  assert.equal((await resolveTestCapability(GID, "RPT-1")).mode, "none");
  assert.equal(await resolveLegacyTestProfile(GID, "RPT-1"), true);
}));

test("兩筆 profile：票名不符合 -> 預設那筆（區分大小寫，比照 gates.json）", withEnv(async (dir) => {
  writeProfiles(dir, TWO_PROFILES);
  assert.equal((await resolveSasdConfig(GID, "翻新功能")).specOrder, "spec_first");
  assert.equal((await resolveSasdConfig(GID, "rpt 小寫")).specOrder, "spec_first");
  assert.equal((await resolveTestCapability(GID, "翻新功能")).mode, "modern");
  assert.equal(await resolveLegacyTestProfile(GID, "翻新功能"), false);
}));

test("兩筆 profile：沒帶票名（或空票名）-> 預設那筆", withEnv(async (dir) => {
  writeProfiles(dir, TWO_PROFILES);
  assert.equal((await resolveSasdConfig(GID)).specOrder, "spec_first");
  assert.equal((await resolveSasdConfig(GID, null)).specOrder, "spec_first");
  assert.equal((await resolveSasdConfig(GID, "")).specOrder, "spec_first");
}));

test("預設 profile 排在前面或後面結果一樣（不靠陣列順序）", withEnv(async (dir) => {
  writeProfiles(dir, [...TWO_PROFILES].reverse());
  assert.equal((await resolveSasdConfig(GID, "RPT-1")).specOrder, "code_first");
  assert.equal((await resolveSasdConfig(GID, "別的")).specOrder, "spec_first");
}));

test("驗證：重複預設、重複 pattern、非法 regex、多筆同時符合都報錯", withEnv(async (dir) => {
  writeProfiles(dir, [{ match: { projectGid: GID }, sasd: SASD_SPEC_FIRST }, { match: { projectGid: GID }, sasd: SASD_CODE_FIRST }]);
  await assert.rejects(() => resolveSasdConfig(GID, "x"), /不只一筆預設 profile/);

  writeProfiles(dir, [
    { match: { projectGid: GID, ticketNamePattern: "A" }, sasd: SASD_CODE_FIRST },
    { match: { projectGid: GID, ticketNamePattern: "A" }, sasd: SASD_SPEC_FIRST },
  ]);
  await assert.rejects(() => resolveSasdConfig(GID, "A"), /ticketNamePattern「A」重複/);

  writeProfiles(dir, [{ match: { projectGid: GID, ticketNamePattern: "(" }, sasd: SASD_CODE_FIRST }, { match: { projectGid: GID }, sasd: SASD_SPEC_FIRST }]);
  await assert.rejects(() => resolveSasdConfig(GID, "x"), /不是合法的正規表示式/);
  await assert.rejects(() => resolveSasdConfig(GID), /不是合法的正規表示式/);

  writeProfiles(dir, [{ match: { projectGid: GID, ticketNamePattern: "" }, sasd: SASD_CODE_FIRST }]);
  await assert.rejects(() => resolveSasdConfig(GID), /必須是非空字串/);

  writeProfiles(dir, [
    { match: { projectGid: GID, ticketNamePattern: "RPT" }, sasd: SASD_CODE_FIRST },
    { match: { projectGid: GID, ticketNamePattern: "月報" }, sasd: SASD_SPEC_FIRST },
    { match: { projectGid: GID }, sasd: SASD_SPEC_FIRST },
  ]);
  await assert.rejects(() => resolveSasdConfig(GID, "RPT 月報"), /同時符合票名「RPT 月報」/);
  assert.equal((await resolveSasdConfig(GID, "RPT only")).specOrder, "code_first");
}));

test("全部都有 pattern、沒有預設：沒帶票名或票名都不符合都明確報錯，不退回 data/*.json", withEnv(async (dir) => {
  writeProfiles(dir, [{ match: { projectGid: GID, ticketNamePattern: REPORT_PATTERN }, sasd: SASD_CODE_FIRST }]);
  await assert.rejects(() => resolveSasdConfig(GID), /沒有預設 profile/);
  await assert.rejects(() => resolveSasdConfig(GID, "翻新"), /都不符合、也沒有預設 profile/);
  assert.equal((await resolveSasdConfig(GID, "RPT-9")).specOrder, "code_first");
}));

test("其他專案的 data fallback 不受影響", withEnv(async (dir) => {
  await registerSasdConfig("other-gid", SASD_SPEC_FIRST);
  writeProfiles(dir, TWO_PROFILES);
  assert.deepEqual(await resolveSasdConfig("other-gid", "RPT-1"), SASD_SPEC_FIRST);
}));

test("resolveUniformTestCapabilityMode：依票名切換的每一筆都算進去", withEnv(async (dir) => {
  writeProfiles(dir, TWO_PROFILES);
  assert.equal(await resolveUniformTestCapabilityMode(dir), null); // none 與 modern 不一致
  writeProfiles(dir, TWO_PROFILES.map((p) => ({ ...p, testCapability: { mode: "modern", note: null } })));
  assert.equal(await resolveUniformTestCapabilityMode(dir), "modern");
}));
