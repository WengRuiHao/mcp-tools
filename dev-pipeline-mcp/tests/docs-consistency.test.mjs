// 文件與程式一致性：擋掉「改了程式忘了改文件」。
// 只檢查機械可驗證的項目：工具名稱、工具總數、SVG 合法性、流程說明引用的工具名稱。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectClient } from "./helpers/support.mjs";
import { registerAllTools } from "../dist/toolsets.js";
import { getOverview } from "../dist/overview-prompts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

// 實際註冊的工具名單（預設全部群組都開）。
async function registeredTools() {
  const { client, close } = await connectClient((s) => registerAllTools(s, new Set()));
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await close();
  }
}

const TOOLS = await registeredTools();
const TOOL_SET = new Set(TOOLS);
const README = read("README.md");
const MANUAL = read("docs/MANUAL.html");
const SVG_DIR = path.join(ROOT, "docs", "img");
const SVG_FILES = fs.readdirSync(SVG_DIR).filter((f) => f.endsWith(".svg"));

/** README「## 提供的工具」到下一個「## 」之間的工具表，取每列第一格反引號內的名稱。 */
function readmeTableToolNames() {
  const start = README.indexOf("## 提供的工具");
  assert.ok(start >= 0, "README 找不到「## 提供的工具」章節");
  const end = README.indexOf("\n## ", start + 5);
  const section = README.slice(start, end < 0 ? undefined : end);
  const names = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("| `")) continue;
    const firstCell = line.split(/(?<!\\)\|/)[1] ?? "";
    for (const m of firstCell.matchAll(/`([^`]+)`/g)) names.push(m[1]);
  }
  return names;
}

/** MANUAL 工具總覽的每一列 <div class="tool-row"><code>name</code>。 */
function manualToolNames() {
  const names = [];
  // 工具名稱是列首連續以「 / 」串起來的 <code>；其後的括號說明（如 kind="..."）不算。
  const chain = /^<code>([^<]+)<\/code>(?:\s*\/\s*<code>([^<]+)<\/code>)*/;
  for (const row of MANUAL.matchAll(/<div class="tool-row">([\s\S]*?)<span>/g)) {
    const head = chain.exec(row[1]);
    if (head) for (const m of head[0].matchAll(/<code>([^<]+)<\/code>/g)) names.push(m[1]);
  }
  return names;
}

test("README 工具表：每個已註冊工具都有列，且表內沒有不存在的工具", () => {
  const names = readmeTableToolNames();
  assert.ok(names.length > 0, "README 工具表解析不到任何工具名稱");
  const missing = TOOLS.filter((t) => !names.includes(t));
  const stale = names.filter((n) => !TOOL_SET.has(n));
  assert.deepEqual(missing, [], `README 工具表缺少這些已註冊工具：${missing.join(", ")}`);
  assert.deepEqual(stale, [], `README 工具表出現不存在的工具：${stale.join(", ")}`);
});

test("MANUAL 工具總覽：每個已註冊工具都有列，且沒有不存在的工具", () => {
  const names = manualToolNames();
  assert.ok(names.length > 0, "MANUAL 工具列解析不到任何工具名稱");
  const missing = TOOLS.filter((t) => !names.includes(t));
  const stale = names.filter((n) => !TOOL_SET.has(n));
  assert.deepEqual(missing, [], `MANUAL 缺少這些已註冊工具：${missing.join(", ")}`);
  assert.deepEqual(stale, [], `MANUAL 出現不存在的工具：${stale.join(", ")}`);
});

test("工具總數：README、MANUAL、toolsets.svg 寫的數字等於實際註冊總數", () => {
  const total = TOOLS.length;
  const checks = [
    ["README 摺疊標題", README, /展開完整工具清單（(\d+) 個）/g],
    ["README toolsets 圖說", README, /預設全部註冊共 (\d+) 個工具/g],
    ["MANUAL 工具總覽", MANUAL, /總共 (\d+) 個工具/g],
    ["toolsets.svg", read("docs/img/toolsets.svg"), /共 (\d+) 個工具/g],
  ];
  for (const [label, text, re] of checks) {
    const found = [...text.matchAll(re)].map((m) => Number(m[1]));
    assert.ok(found.length > 0, `${label} 找不到「N 個工具」格式的數字（格式變了？請同步更新本測試）`);
    for (const n of found) assert.equal(n, total, `${label} 寫 ${n} 個工具，實際註冊 ${total} 個`);
  }
});

test("docs/img/*.svg 皆為合法 XML（標籤正確配對）", () => {
  assert.ok(SVG_FILES.length > 0);
  for (const file of SVG_FILES) {
    const xml = fs.readFileSync(path.join(SVG_DIR, file), "utf-8");
    const body = xml
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<\?[\s\S]*?\?>/g, "")
      .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
      .replace(/<!DOCTYPE[^>]*>/gi, "");
    const stack = [];
    for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
      const [, closing, name, rest] = m;
      if (closing) {
        assert.equal(stack.pop(), name, `${file}：結尾標籤 </${name}> 沒有對到開頭標籤`);
      } else if (!rest.trimEnd().endsWith("/")) {
        stack.push(name);
      }
    }
    assert.deepEqual(stack, [], `${file}：有標籤沒有關閉：${stack.join(", ")}`);
    assert.match(body, /^\s*<svg[\s>]/, `${file}：根元素不是 <svg>`);
    // 內文不得有未跳脫的 & 或 <（常見於文字裡寫「A & B」）
    const text = body.replace(/<[^>]*>/g, "");
    assert.doesNotMatch(text, /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/, `${file}：文字裡有未跳脫的 &`);
  }
});

test("prepare_project 必須同時出現在 README 與 one-time-setup.svg", () => {
  assert.ok(TOOL_SET.has("prepare_project"));
  assert.ok(README.includes("`prepare_project`"), "README 沒提到 prepare_project");
  assert.ok(read("docs/img/one-time-setup.svg").includes("prepare_project"), "one-time-setup.svg 沒提到 prepare_project");
});

test("getOverview(core) 提到的工具名稱都存在於註冊名單", () => {
  const text = getOverview("core");
  // 反引號包起來、snake_case、且以工具常見動詞開頭者視為工具名稱。
  const toolLike = /^(?:get|list|read|write|record|resolve|restore|resync|request|advance|abandon|create|join|merge|finalize|install|prepare|relocate|run|search|download|svn)_[a-z_]+$/;
  const mentioned = new Set();
  for (const m of text.matchAll(/`([a-z][a-z0-9_]*)`/g)) if (toolLike.test(m[1])) mentioned.add(m[1]);
  assert.ok(mentioned.size >= 5, "core 流程說明解析不到足夠的工具名稱，請檢查解析規則");
  // svn-mcp 的工具（SVN 讀取不經本 MCP）：流程說明可以提到，但不屬於本 MCP 的註冊名單。
  const SVN_MCP_TOOLS = new Set(["svn_browse", "svn_cat", "svn_diff", "svn_doc_images", "svn_find_repo", "svn_list_connections", "svn_log", "svn_test_connection"]);
  const unknown = [...mentioned].filter((n) => !TOOL_SET.has(n) && !SVN_MCP_TOOLS.has(n));
  assert.deepEqual(unknown, [], `core 流程說明提到不存在的工具：${unknown.join(", ")}`);
  for (const n of SVN_MCP_TOOLS) assert.ok(!TOOL_SET.has(n), `${n} 不應再註冊在本 MCP（SVN 讀取一律直連 svn-mcp）`);
});
