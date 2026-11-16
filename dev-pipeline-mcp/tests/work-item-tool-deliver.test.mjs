// deliver：把正式交付物輸出成客戶命名的副本到 deliverables/（問題 65）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setupEnv, runUntil } from "./helpers/work-item-env.mjs";

const { sanitizeDeliverTitle, deliverBaseName } = await import("../dist/work-item-actions/deliver.js");
const env = await setupEnv("wi-deliver-");
after(() => env.cleanup());
const deliver = (id, extra = {}) => env.call({ action: "deliver", workItemId: id, ...extra });

test("命名：標題淨化（不合法字元、空白、控制字元、尾端點）與版次", () => {
  assert.equal(sanitizeDeliverTitle('會員 匯出/訂單: "Excel"?'), "會員_匯出訂單_Excel");
  assert.equal(sanitizeDeliverTitle("  ..  "), "工作項目");
  assert.equal(sanitizeDeliverTitle("a".repeat(200)).length, 80);
  assert.equal(deliverBaseName("訂單匯出", "系統分析書", "1.0"), "訂單匯出_系統分析書_v1.0");
});

test("deliver：產出角色未 done 或關卡未通過時拒絕", async () => {
  const { id, dir } = await env.create();
  const early = await deliver(id);
  assert.equal(early.isError, true);
  assert.match(early.text, /尚未 done|尚未通過/);
  await runUntil(env, id, dir, "sd-analyst");
  const saOnly = await deliver(id, { target: "sa" });
  assert.equal(saOnly.isError, false, saOnly.text);
  const sd = await deliver(id, { target: "sd" });
  assert.equal(sd.isError, true, "sd 還沒 done");
  assert.equal(existsSync(path.join(dir, "deliverables")), true);
});

test("deliver all：客戶命名、圖片與連結改寫、TableSchema 與 ER 圖一併複製、內部檔不外洩、status 不變", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-verifier");
  const statusBefore = readFileSync(path.join(dir, "status.json"), "utf-8");
  const r = await deliver(id);
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.versions, { sa: "0.1", sd: "0.1" });
  const sa = "測試需求_系統分析書_v0.1";
  const sd = "測試需求_系統設計書_v0.1";
  const files = r.json.files;
  for (const f of [`deliverables/${sa}.md`, `deliverables/${sa}_images/a.png`, `deliverables/${sd}.md`, `deliverables/${sd}_images/flow.png`, "deliverables/TableSchema/t.md", "deliverables/TableSchema/system-er.md", "deliverables/TableSchema/er/t.png", "deliverables/TableSchema/er/system-er.png"]) {
    assert.ok(files.includes(f), f);
    assert.equal(existsSync(path.join(dir, ...f.split("/"))), true, f);
  }
  const saText = readFileSync(path.join(dir, "deliverables", `${sa}.md`), "utf-8");
  assert.ok(!saText.includes("](sa-images/"));
  assert.ok(saText.includes(`](${encodeURI(`${sa}_images`)}/a.png)`));
  const sdText = readFileSync(path.join(dir, "deliverables", `${sd}.md`), "utf-8");
  assert.ok(sdText.includes(`](${encodeURI(`${sd}_images`)}/flow.png)`));
  assert.ok(sdText.includes("(TableSchema/t.md#t)"), "SD 連到 TableSchema 的連結維持有效");
  const tableText = readFileSync(path.join(dir, "deliverables", "TableSchema", "t.md"), "utf-8");
  assert.ok(tableText.includes(`](../${encodeURI(sd)}.md)`), "TableSchema 回指 SD 的連結改成客戶命名");
  assert.ok(!tableText.includes("../03-sd.md"));
  assert.equal(existsSync(path.join(dir, "deliverables", "TableSchema", "_src")), false, "ER 來源是內部檔，不輸出");
  assert.equal(readdirSync(path.join(dir, "deliverables")).some((n) => /flow\.mmd|sa-notes|02-db|spec-check/.test(n)), false);
  assert.equal(readFileSync(path.join(dir, "status.json"), "utf-8"), statusBefore, "不改 status.json");
  const g = (await env.call({ action: "get", workItemId: id })).json;
  assert.ok(g.deliveredFiles.includes(`deliverables/${sd}.md`));
  assert.match(readFileSync(path.join(dir, "00-索引.md"), "utf-8"), /已交付的客戶命名文件/);
});

test("deliver：版次更新後新檔名並存，同版次再交付覆寫", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-verifier");
  assert.equal((await deliver(id, { target: "sa" })).isError, false);
  const saFile = path.join(dir, "01-sa.md");
  const text = readFileSync(saFile, "utf-8");
  const row1 = "| 0.1 | 2026/11/10 | 初版 | 示範團隊 | 系統分析師 |";
  assert.ok(text.includes(row1));
  writeFileSync(saFile, text.replace(row1, `${row1}\n| 0.2 | 2026/11/11 | 補充操作說明 | 示範團隊 | 系統分析師 |`));
  const r2 = await deliver(id, { target: "sa" });
  assert.equal(r2.isError, false, r2.text);
  assert.deepEqual(r2.json.versions, { sa: "0.2" });
  const names = readdirSync(path.join(dir, "deliverables"));
  assert.ok(names.includes("測試需求_系統分析書_v0.1.md") && names.includes("測試需求_系統分析書_v0.2.md"));
  assert.equal((await deliver(id, { target: "sa" })).isError, false, "同版次覆寫");
});

test("deliver：交件內容檢查不合格（例如 SA 又被改成含 mermaid）時拒絕並列出問題", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-verifier");
  const saFile = path.join(dir, "01-sa.md");
  writeFileSync(saFile, `${readFileSync(saFile, "utf-8")}\n${"```"}mermaid\nflowchart TD\nA-->B\n${"```"}\n`);
  const r = await deliver(id, { target: "sa" });
  assert.equal(r.isError, true);
  assert.ok(r.json.problems.some((p) => p.includes("mermaid")));
});

test("deliver：未知 target 與缺 workItemId 被拒絕", async () => {
  assert.equal((await env.call({ action: "deliver" })).isError, true);
  assert.equal((await env.call({ action: "deliver", workItemId: "wi-none-000" })).isError, true);
});
