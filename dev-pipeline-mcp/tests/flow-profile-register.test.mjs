// 多筆 profile 時 register 不得誤覆寫別筆；單筆 profile 帶 pattern 時保留 pattern。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir, isolateDataDir } from "./helpers/support.mjs";
import { registerProjectDir, registerSasdConfig } from "../dist/project-registry.js";

const GID = "p-test-1";
const SASD = { saRoot: "N/A-sa", sdMode: "self-generated", sdRoot: null, sdOutputPath: "doc/sd", svnConnectionId: null, specOrder: "spec_first" };

async function withDir(profiles, fn) {
  const data = isolateDataDir();
  const dir = makeTmpDir("dpm-flowreg-");
  try {
    await registerProjectDir(GID, dir);
    fs.mkdirSync(path.join(dir, ".pipeline"), { recursive: true });
    const file = path.join(dir, ".pipeline", "settings.json");
    const original = JSON.stringify({ flow: { profiles } });
    fs.writeFileSync(file, original);
    await fn(file, original);
  } finally {
    removeDir(dir);
    data.cleanup();
  }
}

test("同一 projectGid 有多筆 profile：register 明確拒絕、檔案不變", () =>
  withDir(
    [{ match: { projectGid: GID, ticketNamePattern: "RPT" }, sasd: SASD }, { match: { projectGid: GID }, sasd: SASD }],
    async (file, original) => {
      await assert.rejects(() => registerSasdConfig(GID, SASD), /手動編輯/);
      assert.equal(fs.readFileSync(file, "utf-8"), original);
    }
  ));

test("單筆 profile 帶 ticketNamePattern：register 更新時保留 pattern", () =>
  withDir([{ match: { projectGid: GID, ticketNamePattern: "RPT" }, sasd: SASD }], async (file) => {
    await registerSasdConfig(GID, { ...SASD, specOrder: "code_first" });
    const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.deepEqual(saved.flow.profiles[0].match, { projectGid: GID, ticketNamePattern: "RPT" });
    assert.equal(saved.flow.profiles[0].sasd.specOrder, "code_first");
  }));
