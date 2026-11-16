// 舊版面工作項目（快照含已併入 SD 的 flow-analyst）相容：ER 圖 Mermaid 內嵌在文件、SD 沒有「流程圖」章節、SA 可含 mermaid，新舊格式都接受；新工作項目一律嚴格新格式。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setupEnv, runUntil, fulfil, CLEAN_REVIEW, VALID_SD, VALID_TABLE_SCHEMA, VALID_SYSTEM_ER, VALID_SA } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-legacy-");
after(() => env.cleanup());
const done = (id, roleId) => env.call({ action: "done", workItemId: id, roleId });
const agentConfirm = async (id, gateId) => {
  const r = await env.call({ action: "confirm", workItemId: id, gateId, decision: "confirmed", by: "agent", review: CLEAN_REVIEW });
  assert.equal(r.isError, false, r.text);
};
const ER_INLINE = ["```mermaid", "erDiagram", "    t {", "        INT id PK", "    }", "```", ""].join("\n");

/** 把快照改成舊版（含 flow-analyst），模擬併入 SD 之前建立的工作項目。 */
function makeLegacy(dir) {
  const file = path.join(dir, "status.json");
  const st = JSON.parse(readFileSync(file, "utf-8"));
  st.workflow_snapshot.roles.push({ id: "flow-analyst", dependsOn: ["sa-analyst", "db-designer"], optional: false });
  st.workflow_snapshot.stage_order.splice(st.workflow_snapshot.stage_order.indexOf("sd-analyst"), 0, "flow-analyst");
  writeFileSync(file, JSON.stringify(st, null, 2));
}

test("legacy：內嵌 mermaid 的資料表文件、沒有「流程圖」章節的 SD、含 mermaid 的 SA 都能交件", async () => {
  const { id, dir } = await env.create();
  makeLegacy(dir);
  await runUntil(env, id, dir, "sa-analyst");
  await fulfil(dir, "sa-analyst");
  writeFileSync(path.join(dir, "01-sa.md"), `${VALID_SA}\n${"```"}mermaid\nflowchart TD\nA-->B\n${"```"}\n`);
  assert.equal((await done(id, "sa-analyst")).isError, false, "SA 含 mermaid（legacy 例外）");
  await agentConfirm(id, "sa-confirm");
  await fulfil(dir, "db-designer");
  writeFileSync(path.join(dir, "TableSchema", "t.md"), VALID_TABLE_SCHEMA.replace("![t 模組 ER 圖](er/t.png)", `${ER_INLINE}\n![t 模組 ER 圖](er/t.png)`));
  writeFileSync(path.join(dir, "TableSchema", "system-er.md"), VALID_SYSTEM_ER.replace("![系統 ER 圖](er/system-er.png)", `${ER_INLINE}\n![系統 ER 圖](er/system-er.png)`));
  await rmSrc(dir);
  const db = await done(id, "db-designer");
  assert.equal(db.isError, false, db.text);
  await agentConfirm(id, "db-flow-confirm");
  await fulfil(dir, "sd-analyst");
  const noFlowSection = VALID_SD.replace(/## 流程圖[\s\S]*?(?=## API 說明)/, "").replace("二、流程圖\n三、API 說明", "二、API 說明");
  writeFileSync(path.join(dir, "03-sd.md"), noFlowSection);
  const sd = await done(id, "sd-analyst");
  assert.equal(sd.isError, false, sd.text);
  const g = (await env.call({ action: "get", workItemId: id })).json;
  assert.equal(g.success, true);
  assert.ok(!g.doneRoles.includes("flow-analyst"), "已移除的角色不出現在角色列表");
});

async function rmSrc(dir) {
  const { rm } = await import("node:fs/promises");
  await rm(path.join(dir, "TableSchema", "_src"), { recursive: true, force: true });
}

test("legacy：整個流程走完仍是 complete，get 與索引重新產生不崩潰", async () => {
  const { id, dir } = await env.create();
  makeLegacy(dir);
  await runUntil(env, id, dir, "final-acceptance-none");
  const ok = await env.call({ action: "confirm", workItemId: id, gateId: "final-acceptance", decision: "confirmed", by: "human", reason: "使用者驗收" });
  assert.equal(ok.isError, false, ok.text);
  const g = (await env.call({ action: "get", workItemId: id })).json;
  assert.equal(g.complete, true);
  assert.match(readFileSync(path.join(dir, "00-索引.md"), "utf-8"), /工作項目索引/);
  const prompt = await env.call({ action: "role_prompt", workItemId: id, roleId: "flow-analyst" });
  assert.equal(prompt.isError, true, "flow-analyst 已不是流程角色");
});

test("新工作項目（快照不含 flow-analyst）一律嚴格新格式：資料表文件內嵌 mermaid、SD 缺流程圖章節、SA 含 mermaid 都被擋", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-analyst");
  await fulfil(dir, "sa-analyst");
  writeFileSync(path.join(dir, "01-sa.md"), `${VALID_SA}\n${"```"}mermaid\nflowchart TD\nA-->B\n${"```"}\n`);
  assert.equal((await done(id, "sa-analyst")).isError, true);
  writeFileSync(path.join(dir, "01-sa.md"), VALID_SA);
  assert.equal((await done(id, "sa-analyst")).isError, false);
  await agentConfirm(id, "sa-confirm");
  await fulfil(dir, "db-designer");
  writeFileSync(path.join(dir, "TableSchema", "t.md"), VALID_TABLE_SCHEMA.replace("![t 模組 ER 圖](er/t.png)", `${ER_INLINE}\n![t 模組 ER 圖](er/t.png)`));
  assert.equal((await done(id, "db-designer")).isError, true);
  await fulfil(dir, "db-designer");
  assert.equal((await done(id, "db-designer")).isError, false);
  await agentConfirm(id, "db-flow-confirm");
  await fulfil(dir, "sd-analyst");
  writeFileSync(path.join(dir, "03-sd.md"), VALID_SD.replace(/## 流程圖[\s\S]*?(?=## API 說明)/, "").replace("二、流程圖\n三、API 說明", "二、API 說明"));
  const sd = await done(id, "sd-analyst");
  assert.equal(sd.isError, true);
  assert.ok(sd.json.problems.some((p) => p.includes("流程圖")));
});
