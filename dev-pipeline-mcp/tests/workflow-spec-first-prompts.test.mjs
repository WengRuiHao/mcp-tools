// 規格先行流程的 12 個角色說明：可取得、含正確產出檔名與已定案規則、長度合理、不含客戶代號。
import test from "node:test";
import assert from "node:assert/strict";
import { getSpecFirstRolePrompt, SPEC_FIRST_ROLE_IDS } from "../dist/prompts-spec-first.js";
import { buildSpecFirstWorkflow } from "../dist/workflow/builtin/spec-first.js";

const wf = buildSpecFirstWorkflow();
const fileOf = (id) => wf.artifacts.find((a) => a.id === id).file;
const j = (...parts) => parts.join("");
const FORBIDDEN = [j("UEC", "-F"), j("電子", "發票"), j("ofe", "invoice"), j("SC", "SB"), j("上海", "商銀"), j("Alv", "en"), j("高", "銀"), j("sow", "ffd"), j("社家", "署"), j("boke", "ps"), j("KS", "BS")];

test("12 個角色都能取得，且與 builtin 角色 id 完全一致", () => {
  assert.equal(SPEC_FIRST_ROLE_IDS.length, 12);
  assert.deepEqual([...SPEC_FIRST_ROLE_IDS].sort(), wf.roles.map((r) => r.id).sort());
  for (const id of SPEC_FIRST_ROLE_IDS) assert.ok(getSpecFirstRolePrompt(id).length > 0, id);
});

test("未知角色報繁體中文錯誤，原型鏈名稱也不放行", () => {
  assert.throws(() => getSpecFirstRolePrompt("nope"), /未知的規格先行角色/);
  assert.throws(() => getSpecFirstRolePrompt("toString"), /未知的規格先行角色/);
  assert.throws(() => getSpecFirstRolePrompt(""), /未知的規格先行角色/);
});

test("每個角色說明含其 builtin 產出物的檔名", () => {
  for (const role of wf.roles) {
    const text = getSpecFirstRolePrompt(role.id);
    for (const out of role.outputs) {
      const art = wf.artifacts.find((a) => a.id === out);
      assert.ok(text.includes(art.file), `${role.id} 缺 ${art.file}`);
      for (const att of art.attachments ?? []) assert.ok(text.includes(att), `${role.id} 缺附件 ${att}`);
      if (art.render) assert.ok(text.includes(art.render), `${role.id} 缺 ${art.render}`);
    }
  }
});

test("說明含各章節與工作項目工具提示", () => {
  for (const id of SPEC_FIRST_ROLE_IDS) {
    const text = getSpecFirstRolePrompt(id);
    for (const h of ["## 目標", "## 要讀的輸入", "## 要交的產出檔案", "## 做法", "## 不可以做的事", "## 交件之後", "## 可用工具"]) assert.ok(text.includes(h), `${id} 缺 ${h}`);
    assert.ok(text.includes("work_item"), id);
  }
});

test("tech-selector：四種技術來源的做法、tech-stack.md、確認後鎖定、AI 不可代確認", () => {
  const t = getSpecFirstRolePrompt("tech-selector");
  for (const k of ["tech-stack.md", "## 技術來源", "## 技術棧", "## 選擇理由", "## 候選方案", "## 目標技術", "existing", "change", "new-guided", "new-select", "沿用現有", "換技術", "全新有規範", "全新待選"]) assert.ok(t.includes(k), k);
  for (const k of ["2～3 組", "優缺點", "學習與維運成本", "與現有專案相容性", "技術確認", "鎖定", "AI 不可代確認", "不可自行換語言"]) assert.ok(t.includes(k), k);
  assert.ok(t.includes("不可修改任何程式碼"));
});

test("其餘角色的輸入加上 tech-stack.md；前後端與 mockup 不可自行更換已確認的技術", () => {
  for (const id of ["mockup-designer", "sa-analyst", "db-designer", "sd-analyst", "spec-verifier", "frontend-engineer", "backend-engineer", "verifier", "tester"]) {
    assert.ok(getSpecFirstRolePrompt(id).includes("tech-stack.md"), `${id} 輸入含 tech-stack.md`);
  }
  for (const id of ["mockup-designer", "frontend-engineer", "backend-engineer"]) {
    assert.ok(getSpecFirstRolePrompt(id).includes("不可自行更換 tech-stack.md 已確認的語言、框架、元件庫"), id);
  }
});

test("baseline-survey：盤點「## 現有技術棧」；mockup-designer 的風格來源四個值與欄位名稱一致", () => {
  const b = getSpecFirstRolePrompt("baseline-survey");
  assert.ok(b.includes("## 現有技術棧") && b.includes("技術選型師"));
  const m = getSpecFirstRolePrompt("mockup-designer");
  for (const k of ["沿用現有", "換新", "全新有規範", "全新待選", "畫面風格來源"]) assert.ok(m.includes(k), k);
});

test("mockup-designer：只畫 mockup、放 sa-mockup/、不寫規格、等使用者確認", () => {
  const t = getSpecFirstRolePrompt("mockup-designer");
  assert.ok(t.includes("sa-mockup/") && t.includes("不寫規格") && t.includes("人工確認") && t.includes("瀏覽器"));
});

test("sa-analyst：功能標題格式、純後端、sa-images/、定稿不換圖、客戶語氣", () => {
  const t = getSpecFirstRolePrompt("sa-analyst");
  assert.ok(t.includes("## 功能：") && t.includes("（純後端）") && t.includes("sa-images/") && t.includes("![說明](sa-images/"));
  assert.ok(t.includes("不可把圖片換成實際系統畫面") && t.includes("客戶看得懂"));
});

test("db-designer：破壞性語句與回滾", () => {
  const t = getSpecFirstRolePrompt("db-designer");
  for (const k of ["02-db.sql", "02-db.md", "DROP", "TRUNCATE", "WHERE", "ALTER", "回滾", "強制人工確認"]) assert.ok(t.includes(k), k);
});

test("flow-analyst：必須附 flow.png", () => {
  const t = getSpecFirstRolePrompt("flow-analyst");
  assert.ok(t.includes("flow.mmd") && t.includes("flow.png") && t.includes("必須附上"));
});

test("spec-verifier：只看規格、PASS／FAIL 與四個 rootCause", () => {
  const t = getSpecFirstRolePrompt("spec-verifier");
  assert.ok(t.includes("PASS") && t.includes("FAIL") && t.includes("rootCause") && t.includes("sa-images/"));
  for (const v of ["sa", "db", "flow", "sd"]) assert.ok(t.includes(v), v);
  assert.ok(t.includes("不可閱讀或引用程式碼"));
});

test("verifier：六個 rootCause 值", () => {
  const t = getSpecFirstRolePrompt("verifier");
  assert.ok(t.includes("PASS") && t.includes("rootCause"));
  for (const v of ["sa、db、flow、sd、fe、be"]) assert.ok(t.includes(v), v);
});

test("tester：先白箱後黑箱、截圖存 evidence/、最終驗收由使用者本人、AI 不能代確認", () => {
  const t = getSpecFirstRolePrompt("tester");
  assert.ok(t.includes("白箱") && t.includes("黑箱") && t.includes("evidence/") && t.includes("引用"));
  assert.ok(t.includes("最終驗收") && t.includes("鎖死") && t.includes("使用者本人") && t.includes("AI 不能代為確認"));
});

test("前後端工程師依 SA／SD 並要求規格驗證 PASS", () => {
  assert.ok(getSpecFirstRolePrompt("frontend-engineer").includes("01-sa.md"));
  assert.ok(getSpecFirstRolePrompt("backend-engineer").includes("03-sd.md"));
  for (const id of ["frontend-engineer", "backend-engineer"]) assert.ok(getSpecFirstRolePrompt(id).includes("spec-check.md"));
});

test("每份說明長度 800～2500 字元", () => {
  for (const id of SPEC_FIRST_ROLE_IDS) {
    const n = getSpecFirstRolePrompt(id).length;
    assert.ok(n >= 800 && n <= 2500, `${id} 長度 ${n}`);
  }
});

test("options：workItemDir 與 roleNotes 會附上", () => {
  const t = getSpecFirstRolePrompt("sa-analyst", { workItemDir: "wi/x", roleNotes: "補充ABC" });
  assert.ok(t.includes("wi/x") && t.includes("補充ABC"));
});

test("不含真實客戶或專案代號", () => {
  for (const id of SPEC_FIRST_ROLE_IDS) {
    const t = getSpecFirstRolePrompt(id);
    for (const w of FORBIDDEN) assert.ok(!t.includes(w), `${id} 含 ${w}`);
  }
});
