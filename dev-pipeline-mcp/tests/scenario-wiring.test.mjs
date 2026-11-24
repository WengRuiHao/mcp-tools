// 批次 2M-g：SD 宣告所屬跨模組情境；SD 交件核對情境存在；測試交件每個情境要有端到端測試並掛需求編號。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseModuleMap, parseScenarios, parseSdScenarioNames, checkSdScenarios, checkScenarioTests } from "../dist/module-map.js";
import { sdModuleMapProblems, scenarioTestProblems } from "../dist/work-item-actions/module-map-checks.js";

const MAP = [
  "## 模組：訂單", "- 負責人：甲", "", "## 模組：庫存", "- 負責人：乙", "",
  "## 跨模組情境：下單", "- 經過模組：訂單 → 庫存", "- 協調者：訂單", "- 失敗處理：重試", "- 一致性：最終一致", "",
].join("\n");

test("解析 SD 的「## 跨模組情境」：每行情境名（冒號後是說明）；沒有該節回空", () => {
  assert.deepEqual(parseSdScenarioNames("# SD\n## 跨模組情境\n- 下單：本功能是第一步\n- 退款\n\n## 其他\n- x：y\n"), ["下單", "退款"]);
  assert.deepEqual(parseSdScenarioNames("# SD\n## API 說明\n"), []);
});

test("SD 情境必須存在於模組地圖", () => {
  const m = parseModuleMap(MAP);
  const sc = parseScenarios(MAP);
  assert.deepEqual(checkSdScenarios(sc, ["下單"]), []);
  assert.match(checkSdScenarios(sc, ["下單", "退款"]).join(), /退款.*不在模組地圖/);
  assert.ok(m.length === 2);
});

test("測試：每個情境要有名稱含情境名的測試項目且有對應需求；缺任一個回問題", () => {
  const ok = "## 測試：下單端到端\n**對應需求：** R1\n通過\n";
  assert.deepEqual(checkScenarioTests(["下單"], ok), []);
  assert.match(checkScenarioTests(["下單"], "## 測試：登入\n**對應需求：** R1\n").join(), /下單.*端到端整合測試/);
  assert.match(checkScenarioTests(["下單"], "## 測試：下單端到端\n通過\n").join(), /下單.*對應需求/);
  assert.deepEqual(checkScenarioTests([], "沒有測試"), []);
});

async function proj(multi, map) {
  const p = await mkdtemp(path.join(os.tmpdir(), "sc-proj-"));
  if (multi) {
    await mkdir(path.join(p, ".pipeline"), { recursive: true });
    await writeFile(path.join(p, ".pipeline", "flow.json"), JSON.stringify({ schemaVersion: 1, multiModule: true }));
  }
  if (map !== undefined) await (await import("../dist/project-docs-store.js")).writeProjectDoc(p, "module-map.md", map);
  return p;
}
async function wi(sd, testMd) {
  const d = await mkdtemp(path.join(os.tmpdir(), "sc-wi-"));
  if (sd !== undefined) await writeFile(path.join(d, "03-sd.md"), sd);
  if (testMd !== undefined) await writeFile(path.join(d, "test.md"), testMd);
  return d;
}

test("接線：SD 交件核對情境；測試交件核對情境測試；沒開 multiModule、沒地圖、沒宣告、SD 沒寫該節都不檢查", async () => {
  const sd = "## 跨模組情境\n- 下單：第一步\n- 退款\n";
  const on = await proj(true, MAP);
  const sdp = await sdModuleMapProblems(await wi(sd), on, ["訂單"]);
  assert.ok(sdp.some((p) => p.includes("退款")), JSON.stringify(sdp));
  assert.deepEqual(await sdModuleMapProblems(await wi("## 跨模組情境\n- 下單\n"), on, ["訂單"]), []);
  assert.deepEqual(await sdModuleMapProblems(await wi(sd), on, []), []);
  assert.deepEqual(await sdModuleMapProblems(await wi(sd), await proj(false, MAP), ["訂單"]), []);

  const bad = await scenarioTestProblems(await wi("## 跨模組情境\n- 下單\n", "## 測試：登入\n**對應需求：** R1\n"), on, ["訂單"]);
  assert.ok(bad.some((p) => p.includes("下單")), JSON.stringify(bad));
  assert.deepEqual(await scenarioTestProblems(await wi("## 跨模組情境\n- 下單\n", "## 測試：下單端到端\n**對應需求：** R1\n"), on, ["訂單"]), []);
  assert.deepEqual(await scenarioTestProblems(await wi("# SD 沒寫\n", "x"), on, ["訂單"]), []);
  assert.deepEqual(await scenarioTestProblems(await wi("## 跨模組情境\n- 下單\n", "x"), await proj(true, undefined), ["訂單"]), []);
  assert.deepEqual(await scenarioTestProblems(await wi("## 跨模組情境\n- 下單\n", "x"), on, undefined), []);
});
