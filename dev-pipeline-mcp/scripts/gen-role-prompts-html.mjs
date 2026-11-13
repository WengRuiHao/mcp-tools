// 重新產生 docs/WORKFLOW-ROLE-PROMPTS.html：每個角色一段，內容取自 dist/prompts-spec-first.js（就是系統交給 AI 的原文）。
// 用法：npm run build 之後執行 node scripts/gen-role-prompts-html.mjs
// 沿用現有 HTML 的外框（樣式、說明、導覽）與各角色「交件後的關卡」說明、檔尾的附帶區塊；只重寫各角色的標題與原文。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.join(root, "docs", "WORKFLOW-ROLE-PROMPTS.html");
const { getSpecFirstRolePrompt, SPEC_FIRST_ROLE_IDS } = await import(new URL("../dist/prompts-spec-first.js", import.meta.url));

const { REVIEWER_PROMPT, REVIEWER_ROLE_ID } = await import(new URL("../dist/prompts-spec-first/reviewer.js", import.meta.url));

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const old = fs.readFileSync(htmlPath, "utf-8").replace(/\r\n/g, "\n");

const firstRole = old.indexOf('<h2 id="r-');
const lastRole = old.lastIndexOf('<h2 id="r-');
const tail = old.slice(old.indexOf("</pre>", lastRole) + "</pre>".length);
const gateOf = (id) => new RegExp(`<h2 id="r-${id}">[\\s\\S]*?<p class="meta">交件後的關卡：([^<]*?)\\s*(?:　·　長度[^<]*)?</p>`).exec(old)?.[1] ?? "";

const sections = SPEC_FIRST_ROLE_IDS.map((id, i) => {
  const text = getSpecFirstRolePrompt(id);
  const title = /^# 角色：(.+?)（規格先行流程）/.exec(text)?.[1] ?? id;
  const gate = gateOf(id).replace(/　·.*$/, "").trim();
  return `<h2 id="r-${id}">${i + 1}. ${esc(title)} <code>${id}</code></h2>\n<p class="meta">交件後的關卡：${gate}　·　長度 ${text.length} 字元</p>\n<pre>${esc(text.trimEnd())}\n</pre>\n`;
});

const reviewerN = SPEC_FIRST_ROLE_IDS.length + 1;
sections.push(`<h2 id="r-${REVIEWER_ROLE_ID}">${reviewerN}. AI 審查員（非流程角色） <code>${REVIEWER_ROLE_ID}</code></h2>
<p class="meta">不是流程中的交件角色：在 auto 關卡核准前由 AI 審查員使用，取得方式 work_item action=role_prompt roleId="${REVIEWER_ROLE_ID}"　·　長度 ${REVIEWER_PROMPT.length} 字元</p>
<pre>${esc(REVIEWER_PROMPT.trimEnd())}
</pre>
`);

const nav = `<nav>${SPEC_FIRST_ROLE_IDS.map((id, i) => `<a href="#r-${id}">${i + 1}. ${esc(/^# 角色：(.+?)（/.exec(getSpecFirstRolePrompt(id))?.[1] ?? id)}</a>`).join("")}<a href="#r-${REVIEWER_ROLE_ID}">${reviewerN}. AI 審查員（非流程角色）</a></nav>`;
let head = old.slice(0, firstRole).replace(/<nav>[\s\S]*?<\/nav>/, nav);
head = head.replace(/共 \d+ 個角色/, `共 ${SPEC_FIRST_ROLE_IDS.length} 個流程角色與 1 份 AI 審查員說明書`).replace(/底色標示的句子，是這次新加入的「重複程式碼與共用防線」內容（已併入提示詞原文）。/, "");
const out = `${head}${sections.join("\n")}${tail}`;
fs.writeFileSync(htmlPath, out, "utf-8");
console.log(`已重新產生 ${path.relative(root, htmlPath)}：${SPEC_FIRST_ROLE_IDS.length} 個角色`);
