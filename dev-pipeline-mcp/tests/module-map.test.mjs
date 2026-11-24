// 批次 2M-b：模組地圖（專案層文件 module-map.md）解析與結構檢查。
import test from "node:test";
import assert from "node:assert/strict";
import { parseModuleMap, moduleMapProblems, checkModulesDeclared, checkTableOwnership, blockedByUnfinishedSystemModules } from "../dist/module-map.js";

const MAP = [
  "# 模組地圖", "",
  "## 模組：會員", "- 負責人：小王", "- 類型：系統模組", "- 狀態：已完成", "- 擁有資料表：members, member_roles", "",
  "## 模組：訂單", "- 負責人：小李", "- 擁有資料表：orders", "- 依賴模組：會員、權限", "",
  "## 模組：權限", "**負責人：** 小張", "**類型：** 系統模組", "**狀態：** 開發中", "- **擁有資料表**：perms", "",
].join("\n");

test("解析：負責人、類型、狀態、擁有資料表、依賴模組；多種寫法與分隔符", () => {
  const m = parseModuleMap(MAP);
  assert.deepEqual(m.map((x) => x.name), ["會員", "訂單", "權限"]);
  assert.deepEqual(m[0], { name: "會員", owner: "小王", system: true, finished: true, tables: ["members", "member_roles"], dependsOn: [], interfaces: [] });
  assert.deepEqual(m[1].dependsOn, ["會員", "權限"]);
  assert.equal(m[1].system, false);
  assert.equal(m[1].finished, true, "沒寫狀態視為已完成");
  assert.equal(m[2].finished, false);
  assert.deepEqual(m[2].tables, ["perms"]);
});

test("結構檢查：重名、資料表兩個擁有者、依賴不存在、沒有負責人、循環依賴", () => {
  assert.deepEqual(moduleMapProblems(parseModuleMap(MAP)), []);
  const bad = parseModuleMap(["## 模組：A", "- 擁有資料表：t1", "- 依賴模組：B", "", "## 模組：B", "- 負責人：x", "- 擁有資料表：t1", "- 依賴模組：A、Z", "", "## 模組：A", "- 負責人：y", ""].join("\n"));
  const p = moduleMapProblems(bad).join("\n");
  assert.match(p, /A.*重複/);
  assert.match(p, /t1.*(A|B).*(A|B)/);
  assert.match(p, /Z.*不存在/);
  assert.match(p, /A.*負責人/);
  const cyc = moduleMapProblems(parseModuleMap(["## 模組：A", "- 負責人：x", "- 依賴模組：B", "", "## 模組：B", "- 負責人：x", "- 依賴模組：A", ""].join("\n"))).join();
  assert.match(cyc, /循環.*A.*B.*A/);
});

test("工作項目宣告的模組都要在地圖裡", () => {
  const m = parseModuleMap(MAP);
  assert.deepEqual(checkModulesDeclared(m, ["訂單", "會員"]), []);
  assert.match(checkModulesDeclared(m, ["訂單", "報表"]).join(), /報表.*不在模組地圖/);
  assert.deepEqual(checkModulesDeclared(m, []), []);
});

test("資料表擁有權：動到別的模組擁有的表就擋；自己擁有、沒人擁有的不擋", () => {
  const m = parseModuleMap(MAP);
  assert.deepEqual(checkTableOwnership(m, ["orders", "brand_new"], ["訂單"]), []);
  const r = checkTableOwnership(m, ["orders", "members"], ["訂單"]);
  assert.equal(r.length, 1);
  assert.match(r[0], /members.*會員.*訂單/);
  assert.deepEqual(checkTableOwnership(m, ["members"], ["訂單", "會員"]), []);
});

test("依賴擋住：所屬模組依賴的系統模組還沒完成才擋；非系統模組或已完成不擋", () => {
  const m = parseModuleMap(MAP);
  const r = blockedByUnfinishedSystemModules(m, ["訂單"]);
  assert.equal(r.length, 1);
  assert.match(r[0], /訂單.*系統模組.*權限.*未完成/);
  assert.deepEqual(blockedByUnfinishedSystemModules(m, ["會員"]), []);
  assert.deepEqual(blockedByUnfinishedSystemModules(m, []), []);
});

async function project(multi, map) {
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const proj = await mkdtemp(path.join(os.tmpdir(), "mm-proj-"));
  if (multi) {
    await mkdir(path.join(proj, ".pipeline"), { recursive: true });
    await writeFile(path.join(proj, ".pipeline", "flow.json"), JSON.stringify({ schemaVersion: 1, multiModule: true }));
  }
  if (map !== undefined) await (await import("../dist/project-docs-store.js")).writeProjectDoc(proj, "module-map.md", map);
  return proj;
}

async function workItemDir(tables) {
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const wi = await mkdtemp(path.join(os.tmpdir(), "mm-wi-"));
  await mkdir(path.join(wi, "TableSchema"));
  for (const t of tables) await writeFile(path.join(wi, "TableSchema", `${t}.md`), "x");
  return wi;
}

test("接線：SD 交件核對模組與資料表擁有權（multiModule 且有地圖且宣告了模組才檢查）", async () => {
  const { sdModuleMapProblems } = await import("../dist/work-item-actions/module-map-checks.js");
  const wi = await workItemDir(["members", "orders"]);
  const on = await project(true, MAP);
  const bad = await sdModuleMapProblems(wi, on, ["訂單"]);
  assert.ok(bad.some((p) => p.includes("模組地圖檢查未通過") && p.includes("members")), JSON.stringify(bad));
  assert.ok((await sdModuleMapProblems(wi, on, ["報表"])).some((p) => p.includes("報表")));
  assert.deepEqual(await sdModuleMapProblems(wi, on, ["訂單", "會員"]), []);
  assert.deepEqual(await sdModuleMapProblems(wi, on, []), []);
  assert.deepEqual(await sdModuleMapProblems(wi, on, undefined), []);
  assert.deepEqual(await sdModuleMapProblems(wi, await project(false, MAP), ["訂單"]), [], "沒開 multiModule 不檢查");
  assert.deepEqual(await sdModuleMapProblems(wi, await project(true, undefined), ["訂單"]), [], "沒有地圖不檢查");
  assert.deepEqual(await sdModuleMapProblems(wi, null, ["訂單"]), []);
});

test("接線：SD 確認時依賴的系統模組未完成，AI 不能代確認；本人可放行；其他情況不擋", async () => {
  const { requireDependenciesReady } = await import("../dist/work-item-actions/module-map-checks.js");
  const proj = await project(true, MAP);
  const st = { project_dir: proj, modules: ["訂單"] };
  await assert.rejects(requireDependenciesReady(st, "sd-confirm", "agent", "confirmed"), /權限.*未完成.*本人/);
  await requireDependenciesReady(st, "sd-confirm", "human", "confirmed");
  await requireDependenciesReady(st, "sd-confirm", "agent", "rejected");
  await requireDependenciesReady(st, "sa-confirm", "agent", "confirmed");
  await requireDependenciesReady({ project_dir: proj, modules: ["會員"] }, "sd-confirm", "agent", "confirmed");
  await requireDependenciesReady({ project_dir: proj }, "sd-confirm", "agent", "confirmed");
  await requireDependenciesReady({ project_dir: await project(false, MAP), modules: ["訂單"] }, "sd-confirm", "agent", "confirmed");
});
