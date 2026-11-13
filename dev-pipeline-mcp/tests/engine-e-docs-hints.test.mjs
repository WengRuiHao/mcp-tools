// 第二批（重跑問題 68～74）：範本改由引擎動作取得、擋回訊息附固定格式範例、get 提示上游文件可能過期、說明書新增句子與長度。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, utimes, readFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv } from "./helpers/work-item-env.mjs";
import { SD_TEMPLATE, SA_TEMPLATE } from "./helpers/sasd-standard.mjs";
import { getSpecFirstRolePrompt, SPEC_FIRST_ROLE_IDS } from "../dist/prompts-spec-first.js";
import { checkImpactReuseList } from "../dist/workflow/reuse-record-check.js";
import { checkTechStack } from "../dist/workflow/tech-stack-check.js";
import { checkSdStructure, SD_SPEC_SECTIONS } from "../dist/workflow/sd-structure-check.js";
import { COMMON_RULES } from "../dist/prompts-spec-first/common.js";

const env = await setupEnv("wi-eng-e-docs-");
after(() => env.cleanup());

test("template 動作：取回 SA／SD 等範本全文，缺名稱被擋", async () => {
  for (const name of ["sa", "sd", "table-schema", "system-er", "mockup-states"]) {
    const r = await env.call({ action: "template", template: name });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.json.content.length > 200, name);
  }
  assert.equal((await env.call({ action: "template", template: "sd" })).json.content, SD_TEMPLATE());
  assert.equal((await env.call({ action: "template" })).isError, true);
});

test("說明書不再指向專案相對的 docs/sasd-standard，改指引取範本動作", () => {
  for (const id of SPEC_FIRST_ROLE_IDS) assert.ok(!getSpecFirstRolePrompt(id).includes("docs/sasd-standard"), id);
  assert.ok(getSpecFirstRolePrompt("sd-analyst").includes("action=template template=sd"));
  assert.ok(getSpecFirstRolePrompt("sa-analyst").includes("template=sa"));
  assert.ok(getSpecFirstRolePrompt("mockup-designer").includes("template=mockup-states"));
});

test("SD 範本的四張固定表頭與檢查的表頭一致；範本本身通過檢查", () => {
  const text = SD_TEMPLATE();
  for (const s of SD_SPEC_SECTIONS) assert.ok(text.includes(`| ${s.header.join(" | ")} |`), s.name);
  const problems = checkSdStructure(text).filter((p) => /必須是表格|表頭固定/.test(p));
  assert.deepEqual(problems, []);
  assert.ok(SA_TEMPLATE().length > 0);
});

test("擋回訊息附固定格式範例：可重用清單、技術棧列名、SD 表頭", () => {
  const reuse = checkImpactReuseList("## 可重用清單\n- 沒有位置的敘述\n");
  assert.match(reuse.join("\n"), /已搜尋：匯出 Excel，未找到/);
  assert.match(checkImpactReuseList("## 可重用清單\n無\n").join("\n"), /已搜尋：匯出 Excel，未找到/);
  const tech = checkTechStack("## 技術來源\n沿用現有\n## 技術棧\n| 項目 | 內容 |\n| --- | --- |\n| 前端語言 | JS |\n## 選擇理由\n沿用\n", { techSource: "existing", baselineText: "## 現有技術棧\nJS" }).join("\n");
  assert.match(tech, /前端框架、前端元件庫/);
  assert.match(tech, /資料庫種類、資料庫版本/);
  assert.match(tech, /不適用/);
  const sd = checkSdStructure("# x\n\n## 規格說明\n\n### 1. 使用資料表\n\n| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n").join("\n");
  assert.match(sd, /Table \| 功能 \| 說明 \| 結構文件/);
});

test("write 寫 sa-mockup 檔被擋並明確要求改用 attach destDir=sa-mockup", async () => {
  const { id } = await env.create();
  for (const filename of ["sa-mockup/index.html", "order.html"]) {
    const r = await env.call({ action: "write", workItemId: id, filename, content: "<html></html>" });
    assert.equal(r.isError, true);
    assert.match(r.json.message, /attach destDir=sa-mockup/);
  }
  const other = await env.call({ action: "write", workItemId: id, filename: "foo.md", content: "x" });
  assert.match(other.json.message, /不允許寫入/);
});

test("使用者決定或改需求晚於 impact.md：get 與索引提示上游文件可能過期；之後更新 impact.md 即消失", async () => {
  const { id, dir } = await env.create();
  const impact = path.join(dir, "impact.md");
  await writeFile(impact, "# impact\n", "utf-8");
  const old = new Date(Date.now() - 60_000);
  await utimes(impact, old, old);
  assert.equal((await env.call({ action: "get", workItemId: id })).json.upstreamMayBeStale, undefined);
  const u = await env.call({ action: "update_requirement", workItemId: id, requirement: "新的需求全文：加上匯出", reason: "使用者說要加匯出", by: "human" });
  assert.equal(u.isError, false, u.text);
  const g = await env.call({ action: "get", workItemId: id });
  assert.match(g.json.upstreamMayBeStale, /impact\.md/);
  assert.match(await readFile(path.join(dir, "00-索引.md"), "utf-8"), /上游文件可能過期/);
  await writeFile(impact, "# impact v2\n", "utf-8");
  assert.equal((await env.call({ action: "get", workItemId: id })).json.upstreamMayBeStale, undefined);
});

test("說明書：寫腳本用 Write、SD 標明共用檔歸屬、窄螢幕、驗證 impact.md 一致；長度仍在上限內", () => {
  assert.ok(COMMON_RULES.join("").includes("Bash heredoc"));
  assert.match(getSpecFirstRolePrompt("sd-analyst"), /共用檔要標明歸誰負責/);
  assert.match(getSpecFirstRolePrompt("mockup-designer"), /390px/);
  assert.match(getSpecFirstRolePrompt("sa-analyst"), /390px/);
  assert.match(getSpecFirstRolePrompt("spec-verifier"), /impact\.md 可能過期/);
  for (const id of SPEC_FIRST_ROLE_IDS) {
    const n = getSpecFirstRolePrompt(id).length;
    const max = id === "db-designer" ? 6500 : ["sa-analyst", "mockup-designer", "sd-analyst", "frontend-engineer", "backend-engineer"].includes(id) ? 3500 : 2500;
    assert.ok(n <= max, `${id} 長度 ${n}`);
  }
});
