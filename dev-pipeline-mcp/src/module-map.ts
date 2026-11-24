// 模組地圖（專案層文件 module-map.md）：解析與檢查（批次 2M-b）。純文字，不讀檔案。
// 格式：每個模組一個「## 模組：名稱」區塊，底下每行「- 項目：內容」（也接受粗體標籤、全形半形冒號）。
// 項目：負責人、類型（系統模組）、狀態（已完成／開發中，沒寫視為已完成）、擁有資料表、依賴模組。
import { extractSection } from "./workflow/reuse-record-check.js";
import { listHeadings } from "./workflow/sa-image-check.js";
import { parseTestBlocks } from "./workflow/traceability-check.js";

export const MODULE_MAP_FILE = "module-map.md";
const MODULE_PREFIX = "模組：";
const LIST_SPLIT = /[、,，;；\s]+/;
const strip = (s: string): string => s.replace(/[`*_\s]/g, "");
const list = (v: string): string[] => [...new Set(v.replace(/[`*]/g, "").split(LIST_SPLIT).map((s) => s.trim()).filter(Boolean))];

export interface InterfaceEntry {
  name: string;
  /** 同步呼叫或事件；寫錯或沒寫時是空字串（由結構檢查回報）。 */
  type: string;
  version: number | undefined;
  summary: string;
  users: string[];
}

export interface ModuleEntry {
  name: string;
  owner: string | undefined;
  system: boolean;
  finished: boolean;
  tables: string[];
  dependsOn: string[];
  interfaces: InterfaceEntry[];
}

const IFACE_HEADING = "對外介面";
const IFACE_TYPES = ["同步呼叫", "事件"];

/** 介面清單的一行：「名稱｜類型｜v版本｜摘要｜使用者：甲、乙」，除名稱外順序不拘。 */
function parseInterfaceLine(raw: string): InterfaceEntry | null {
  const bare = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "");
  if (bare === raw && !/[｜|]/.test(raw)) return null;
  const parts = bare.split(/[｜|]/).map((p) => p.replace(/[`*]/g, "").trim());
  if (!parts[0]) return null;
  const e: InterfaceEntry = { name: parts[0], type: "", version: undefined, summary: "", users: [] };
  const rest: string[] = [];
  for (const p of parts.slice(1)) {
    const users = /^使用者\s*[:：]\s*(.*)$/.exec(p);
    if (IFACE_TYPES.includes(p)) e.type = p;
    else if (/^v?\d+$/i.test(p)) e.version = Number(p.replace(/^v/i, ""));
    else if (users) e.users = list(users[1]);
    else if (p) rest.push(p);
  }
  e.summary = rest.join("；");
  return e;
}

function labelValue(line: string): { label: string; value: string } | null {
  const bare = line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "");
  const m = /^(.{1,20}?)\s*[:：]\s*(.*)$/.exec(bare);
  return m ? { label: strip(m[1]), value: m[2].replace(/^\*+\s*/, "").trim() } : null;
}

export function parseModuleMap(text: string): ModuleEntry[] {
  const lines = text.split(/\r\n|\r|\n/);
  const heads = listHeadings(text);
  const mods = heads.filter((h) => h.level === 2 && h.title.trim().startsWith(MODULE_PREFIX));
  return mods.map((h) => {
    const end = heads.find((x) => x.line > h.line && x.level <= 2);
    const entry: ModuleEntry = { name: h.title.trim().slice(MODULE_PREFIX.length).trim(), owner: undefined, system: false, finished: true, tables: [], dependsOn: [], interfaces: [] };
    let inIface = false;
    for (const raw of lines.slice(h.line, end ? end.line - 1 : lines.length)) {
      const heading = /^#{3,6}\s+(.+?)\s*#*\s*$/.exec(raw);
      if (heading) {
        inIface = strip(heading[1]) === IFACE_HEADING;
        continue;
      }
      if (inIface) {
        const it = parseInterfaceLine(raw);
        if (it) entry.interfaces.push(it);
        continue;
      }
      const kv = labelValue(raw);
      if (!kv) continue;
      if (kv.label === "負責人" && kv.value) entry.owner = kv.value;
      else if (kv.label === "類型") entry.system = strip(kv.value) === "系統模組";
      else if (kv.label === "狀態") entry.finished = strip(kv.value) === "已完成";
      else if (kv.label === "擁有資料表") entry.tables = list(kv.value);
      else if (kv.label === "依賴模組") entry.dependsOn = list(kv.value);
    }
    return entry;
  });
}

function findCycle(mods: readonly ModuleEntry[]): string[] | null {
  const by = new Map(mods.map((m) => [m.name, m]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    if (state.get(n) === 2) return null;
    if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 1);
    stack.push(n);
    for (const d of by.get(n)?.dependsOn ?? []) {
      if (!by.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const m of mods) {
    const c = visit(m.name);
    if (c) return c;
  }
  return null;
}

/** SD「## 跨模組情境」節每行一個情境名（冒號後是說明）；沒有這一節回空陣列。 */
export function parseSdScenarioNames(sdText: string): string[] {
  const body = extractSection(sdText, "跨模組情境");
  if (body === null) return [];
  const out: string[] = [];
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const bare = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "").replace(/[`*]/g, "").trim();
    if (!bare || raw.trim().startsWith("#")) continue;
    const name = bare.split(/[:：]/)[0].trim();
    if (name) out.push(name);
  }
  return [...new Set(out)];
}

/** SD 宣告所屬的情境都要在模組地圖的情境清單裡。 */
export function checkSdScenarios(scenarios: readonly ScenarioEntry[], declared: readonly string[]): string[] {
  const known = new Set(scenarios.map((s) => s.name));
  return declared.filter((n) => !known.has(n)).map((n) => `SD 宣告的跨模組情境「${n}」不在模組地圖（先把它登記到 ${MODULE_MAP_FILE} 的「## 跨模組情境：${n}」，或修正名稱）`);
}

/** 每個所屬情境至少一個端到端整合測試（測試項目名稱含情境名），並掛對應需求編號。 */
export function checkScenarioTests(names: readonly string[], testText: string): string[] {
  const blocks = parseTestBlocks(testText);
  const out: string[] = [];
  for (const n of names) {
    const hit = blocks.filter((b) => b.name.includes(n));
    if (hit.length === 0) out.push(`跨模組情境「${n}」沒有端到端整合測試（測試報告加「## 測試：${n}…」項目）`);
    else if (!hit.some((b) => b.ids && b.ids.length > 0)) out.push(`跨模組情境「${n}」的測試項目缺少「**對應需求：** R1」（情境測試要掛追溯矩陣的需求編號）`);
  }
  return out;
}

const COND_FIELDS: ReadonlyArray<{ label: string; re: RegExp; syncOnly: boolean }> = [
  { label: "逾時", re: /^逾時\s*[:：]\s*\S/, syncOnly: true },
  { label: "冪等", re: /^冪等\s*[:：]\s*\S/, syncOnly: false },
  { label: "速率限制", re: /^(?:速率限制|限流)\s*[:：]\s*\S/, syncOnly: true },
];

/** 介面清單的執行條件欄位：同步呼叫要有逾時、冪等、速率限制；事件只要冪等。缺的欄位只警告。 */
export function interfaceConditionProblems(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  const heads = listHeadings(text);
  const out: string[] = [];
  for (const h of heads.filter((x) => x.level === 2 && x.title.trim().startsWith(MODULE_PREFIX))) {
    const mod = h.title.trim().slice(MODULE_PREFIX.length).trim();
    const end = heads.find((x) => x.line > h.line && x.level <= 2);
    let inIface = false;
    for (const raw of lines.slice(h.line, end ? end.line - 1 : lines.length)) {
      const heading = /^#{3,6}\s+(.+?)\s*#*\s*$/.exec(raw);
      if (heading) {
        inIface = strip(heading[1]) === IFACE_HEADING;
        continue;
      }
      if (!inIface) continue;
      const entry = parseInterfaceLine(raw);
      if (!entry) continue;
      const parts = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "").split(/[｜|]/).map((p) => p.replace(/[`*]/g, "").trim());
      const missing = COND_FIELDS.filter((f) => (!f.syncOnly || entry.type !== "事件") && !parts.some((p) => f.re.test(p))).map((f) => f.label);
      if (missing.length > 0) out.push(`介面「${mod}.${entry.name}」缺少執行條件：${missing.join("、")}（寫「逾時：3秒｜冪等：是｜速率限制：100/秒」，值應與 SD 的失敗模式表一致）`);
    }
  }
  return out;
}

export interface ContractExample {
  module: string;
  iface: string;
  input: string;
  output: string;
}

const CONTRACT_HEADING = "契約範例";

/** 每個模組底下「### 契約範例」每行「介面｜輸入：…｜預期輸出：…」；缺的欄位是空字串（由結構檢查回報）。 */
export function parseContractExamples(text: string): ContractExample[] {
  const lines = text.split(/\r\n|\r|\n/);
  const heads = listHeadings(text);
  const out: ContractExample[] = [];
  for (const h of heads.filter((x) => x.level === 2 && x.title.trim().startsWith(MODULE_PREFIX))) {
    const mod = h.title.trim().slice(MODULE_PREFIX.length).trim();
    const end = heads.find((x) => x.line > h.line && x.level <= 2);
    let inSection = false;
    for (const raw of lines.slice(h.line, end ? end.line - 1 : lines.length)) {
      const heading = /^#{3,6}\s+(.+?)\s*#*\s*$/.exec(raw);
      if (heading) {
        inSection = strip(heading[1]) === CONTRACT_HEADING;
        continue;
      }
      if (!inSection) continue;
      const bare = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "");
      if (!/[｜|]/.test(bare)) continue;
      const parts = bare.split(/[｜|]/).map((p) => p.replace(/[`*]/g, "").trim());
      const field = (re: RegExp): string => parts.slice(1).map((p) => re.exec(p)?.[1]?.trim()).find((v) => v !== undefined) ?? "";
      if (parts[0]) out.push({ module: mod, iface: parts[0], input: field(/^輸入\s*[:：]\s*(.*)$/), output: field(/^(?:預期)?輸出\s*[:：]\s*(.*)$/) });
    }
  }
  return out;
}

/** 契約範例結構（地圖寫入警告）：每個介面至少一個範例、範例要指向存在的介面且有輸入與預期輸出。 */
export function contractExampleProblems(mods: readonly ModuleEntry[], examples: readonly ContractExample[]): string[] {
  const out: string[] = [];
  for (const m of mods) {
    for (const i of m.interfaces) if (!examples.some((e) => e.module === m.name && e.iface === i.name)) out.push(`介面「${m.name}.${i.name}」沒有契約範例（高風險需求呼叫它時會被擋；在模組底下加「### 契約範例」，寫「- ${i.name}｜輸入：…｜預期輸出：…」）`);
  }
  for (const e of examples) {
    const owner = mods.find((m) => m.name === e.module);
    if (owner && !owner.interfaces.some((i) => i.name === e.iface)) out.push(`契約範例的介面「${e.module}.${e.iface}」不在模組「${e.module}」的對外介面清單`);
    if (!e.input) out.push(`契約範例「${e.module}.${e.iface}」缺少「輸入：」`);
    if (!e.output) out.push(`契約範例「${e.module}.${e.iface}」缺少「預期輸出：」`);
  }
  return out;
}

/** SD 呼叫的對方介面都要有契約範例（消費方以範例當替身）；呼叫自己宣告的模組不算。 */
export function checkCalledContracts(calls: readonly CrossModuleCall[], examples: readonly ContractExample[], declared: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of calls) {
    const key = `${c.module}.${c.iface}`;
    if (declared.includes(c.module) || seen.has(key)) continue;
    seen.add(key);
    if (!examples.some((e) => e.module === c.module && e.iface === c.iface && e.input && e.output)) out.push(`呼叫的介面「${key}」沒有契約範例（請對方在模組地圖補「### 契約範例」，高風險需求才要求）`);
  }
  return out;
}

/** 地圖寫入前後比對介面：升版、內容變了版本沒升、版本倒退、被移除，各自列出使用者。新增介面與沒變都不通知。 */
export function interfaceChangeNotices(oldText: string, newText: string): string[] {
  const snap = (text: string) => {
    const ex = parseContractExamples(text);
    const out = new Map<string, { iface: InterfaceEntry; examples: string }>();
    for (const m of parseModuleMap(text)) {
      for (const i of m.interfaces) out.set(`${m.name}.${i.name}`, { iface: i, examples: ex.filter((e) => e.module === m.name && e.iface === i.name).map((e) => `${e.input}→${e.output}`).join("\n") });
    }
    return out;
  };
  const before = snap(oldText);
  const after = snap(newText);
  const out: string[] = [];
  for (const [key, old] of before) {
    const users = old.iface.users.join("、") || "（無）";
    const now = after.get(key);
    if (!now) {
      if (old.iface.users.length > 0) out.push(`介面「${key}」已移除，但仍登記有使用者：${users}；請先讓他們改用別的介面`);
      continue;
    }
    const ov = old.iface.version;
    const nv = now.iface.version;
    if (ov !== undefined && nv !== undefined && nv > ov) out.push(`介面「${key}」升版 v${ov} → v${nv}，使用者：${users} 需要跟著升級（預設新舊版並行，舊版保留到使用者都升級完）`);
    else if (ov !== undefined && nv !== undefined && nv < ov) out.push(`介面「${key}」版本倒退（v${ov} → v${nv}）；使用者：${users}`);
    else if (old.iface.summary !== now.iface.summary) out.push(`介面「${key}」的摘要變了但版本沒升；若是不相容變更請升版，使用者：${users}`);
    else if (old.examples !== now.examples) out.push(`介面「${key}」的契約範例變了但版本沒升；若是不相容變更請升版，使用者：${users}`);
  }
  return out;
}

export interface GlossaryEntry {
  name: string;
  aliases: string[];
}

/** 「## 名詞表」每行「- 標準名稱：別名、別名」。沒有這一節回空陣列。 */
export function parseGlossary(text: string): GlossaryEntry[] {
  const body = extractSection(text, "名詞表");
  if (body === null) return [];
  const out: GlossaryEntry[] = [];
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const kv = labelValue(raw);
    if (kv && kv.label) out.push({ name: kv.label, aliases: list(kv.value) });
  }
  return out;
}

/** 名詞表結構問題：同一別名登記在兩個標準名稱、別名與另一個標準名稱相同。 */
export function glossaryProblems(g: readonly GlossaryEntry[]): string[] {
  const out: string[] = [];
  const names = new Set(g.map((e) => e.name));
  const owner = new Map<string, string>();
  for (const e of g) {
    for (const a of e.aliases) {
      const prev = owner.get(a);
      if (prev !== undefined && prev !== e.name) out.push(`別名「${a}」同時登記在「${prev}」與「${e.name}」；一個別名只能對應一個標準名稱`);
      else owner.set(a, e.name);
      if (names.has(a) && a !== e.name) out.push(`「${e.name}」的別名「${a}」本身是另一個標準名稱`);
    }
  }
  return out;
}

/** 別名換成標準名稱；沒登記的原樣返回。 */
function canonicalizer(g: readonly GlossaryEntry[] | undefined): (t: string) => string {
  const map = new Map<string, string>();
  for (const e of g ?? []) for (const a of e.aliases) if (!map.has(a)) map.set(a, e.name);
  return (t) => map.get(t) ?? t;
}

/** 模組地圖本身的結構問題（寫入時回警告）：模組重複、沒有負責人、資料表兩個擁有者、依賴不存在、循環依賴。 */
export function moduleMapProblems(mods: readonly ModuleEntry[], glossary?: readonly GlossaryEntry[]): string[] {
  const canon = canonicalizer(glossary);
  const out: string[] = [];
  const names = new Set<string>();
  for (const m of mods) {
    if (names.has(m.name)) out.push(`模組「${m.name}」重複定義`);
    names.add(m.name);
    if (!m.owner) out.push(`模組「${m.name}」沒有負責人（寫「- 負責人：姓名」）`);
  }
  const owner = new Map<string, string>();
  for (const m of mods) {
    for (const raw of m.tables) {
      const t = canon(raw);
      const prev = owner.get(t);
      if (prev !== undefined && prev !== m.name) out.push(`資料表「${t}」同時被模組「${prev}」與「${m.name}」擁有；一筆資料只能有一個擁有者`);
      else owner.set(t, m.name);
    }
    for (const d of m.dependsOn) if (!names.has(d) && !mods.some((x) => x.name === d)) out.push(`模組「${m.name}」依賴的「${d}」不存在於模組地圖`);
  }
  for (const m of mods) {
    const seen = new Set<string>();
    for (const i of m.interfaces) {
      if (seen.has(i.name)) out.push(`模組「${m.name}」的介面「${i.name}」重複登記`);
      seen.add(i.name);
      if (!IFACE_TYPES.includes(i.type)) out.push(`模組「${m.name}」的介面「${i.name}」類型要寫「${IFACE_TYPES.join("」或「")}」`);
      if (i.version === undefined) out.push(`模組「${m.name}」的介面「${i.name}」沒有版本（寫 v1、v2…單一整數）`);
      for (const u of i.users) if (!names.has(u)) out.push(`模組「${m.name}」的介面「${i.name}」的使用者模組「${u}」不在模組地圖（使用者不存在）`);
    }
    if (m.system) for (const d of m.dependsOn) if (mods.some((x) => x.name === d && !x.system)) out.push(`系統模組「${m.name}」依賴「${d}」（一般模組）；系統模組只能被依賴，不能反過來依賴一般模組`);
  }
  const cycle = findCycle(mods);
  if (cycle) out.push(`模組依賴有循環：${cycle.join(" → ")}`);
  return out;
}

export interface ScenarioEntry {
  name: string;
  modules: string[];
  coordinator: string | undefined;
  failure: string;
  consistency: string;
}

const SCENARIO_PREFIX = "跨模組情境：";

/** 「## 跨模組情境：名稱」區塊：經過模組（依序，用 → 或頓號分隔）、協調者、失敗處理、一致性。 */
export function parseScenarios(text: string): ScenarioEntry[] {
  const lines = text.split(/\r\n|\r|\n/);
  const heads = listHeadings(text);
  return heads
    .filter((h) => h.level === 2 && h.title.trim().startsWith(SCENARIO_PREFIX))
    .map((h) => {
      const end = heads.find((x) => x.line > h.line && x.level <= 2);
      const e: ScenarioEntry = { name: h.title.trim().slice(SCENARIO_PREFIX.length).trim(), modules: [], coordinator: undefined, failure: "", consistency: "" };
      for (const raw of lines.slice(h.line, end ? end.line - 1 : lines.length)) {
        const kv = labelValue(raw);
        if (!kv) continue;
        if (kv.label === "經過模組") e.modules = list(kv.value.replace(/[→>＞]+|->/g, "、"));
        else if (kv.label === "協調者" && kv.value) e.coordinator = strip(kv.value);
        else if (kv.label === "失敗處理") e.failure = kv.value;
        else if (kv.label === "一致性" || kv.label === "一致性要求") e.consistency = kv.value;
      }
      return e;
    });
}

/** 跨模組情境的結構問題：情境重名、模組不存在、少於兩個模組、協調者不在經過模組、缺失敗處理或一致性。 */
export function scenarioProblems(mods: readonly ModuleEntry[], scenarios: readonly ScenarioEntry[]): string[] {
  const known = new Set(mods.map((m) => m.name));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of scenarios) {
    if (seen.has(s.name)) out.push(`跨模組情境「${s.name}」重複定義`);
    seen.add(s.name);
    for (const m of s.modules) if (!known.has(m)) out.push(`跨模組情境「${s.name}」經過的模組「${m}」不在模組地圖`);
    if (new Set(s.modules).size < 2) out.push(`跨模組情境「${s.name}」至少兩個模組（寫「- 經過模組：甲 → 乙」）`);
    if (!s.coordinator) out.push(`跨模組情境「${s.name}」沒有協調者（寫「- 協調者：模組名」）`);
    else if (!s.modules.includes(s.coordinator)) out.push(`跨模組情境「${s.name}」的協調者「${s.coordinator}」不在經過模組`);
    if (!s.failure) out.push(`跨模組情境「${s.name}」沒有失敗處理（每一步失敗三選一：重試、補償、人工處理）`);
    if (!s.consistency) out.push(`跨模組情境「${s.name}」沒有一致性要求（寫「- 一致性：最終一致或強一致與做法」）`);
  }
  return out;
}

/** 工作項目宣告的模組都要在地圖裡。 */
export function checkModulesDeclared(mods: readonly ModuleEntry[], declared: readonly string[]): string[] {
  const known = new Set(mods.map((m) => m.name));
  return declared.filter((d) => !known.has(d)).map((d) => `宣告的模組「${d}」不在模組地圖（先把它登記到專案層文件 ${MODULE_MAP_FILE}，或修正模組名稱）`);
}

/** 資料表擁有權：只有擁有者能寫；工作項目動到別的模組擁有、且自己沒宣告該模組的資料表就擋。沒人擁有的表不擋。 */
export function checkTableOwnership(mods: readonly ModuleEntry[], tables: readonly string[], declared: readonly string[], glossary?: readonly GlossaryEntry[]): string[] {
  const mine = new Set(declared);
  const canon = canonicalizer(glossary);
  const out: string[] = [];
  for (const t of tables) {
    const o = mods.find((m) => m.tables.some((x) => canon(x) === canon(t)));
    if (o && !mine.has(o.name)) out.push(`資料表「${t}」屬於模組「${o.name}」，本工作項目只宣告了模組「${declared.join("、") || "（無）"}」；只有擁有者能寫（改成宣告「${o.name}」，或改走跨模組請求）`);
  }
  return out;
}

/** 所屬模組依賴的系統模組還沒完成就擋住進入實作。 */
export function blockedByUnfinishedSystemModules(mods: readonly ModuleEntry[], declared: readonly string[]): string[] {
  const by = new Map(mods.map((m) => [m.name, m]));
  const out: string[] = [];
  for (const name of declared) {
    for (const d of by.get(name)?.dependsOn ?? []) {
      const dep = by.get(d);
      if (dep && dep.system && !dep.finished) out.push(`模組「${name}」依賴的系統模組「${d}」未完成（狀態不是已完成），不能進入實作`);
    }
  }
  return out;
}

export interface CrossModuleCall {
  module: string;
  iface: string;
  version: number | undefined;
  line: number;
}

const CALL_RE = /^\**([^\s.：:*]+)\.([^\s：:*]+?)\**(?:\s+v(\d+))?\s*[:：]/;

/** SD「## 跨模組呼叫」節裡每行「- 模組.介面 v版本：用途」；沒有這一節回空陣列。 */
export function parseCrossModuleCalls(sdText: string): CrossModuleCall[] {
  const body = extractSection(sdText, "跨模組呼叫");
  if (body === null) return [];
  const out: CrossModuleCall[] = [];
  body.split(/\r\n|\r|\n/).forEach((raw, i) => {
    const m = CALL_RE.exec(raw.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, ""));
    if (m) out.push({ module: m[1], iface: m[2], version: m[3] === undefined ? undefined : Number(m[3]), line: i + 1 });
  });
  return out;
}

/** 跨模組呼叫只能引用對方清單內的介面：模組與介面要存在、版本要對、呼叫方要宣告依賴且登記為使用者。呼叫自己宣告的模組不算跨模組；沒宣告模組略過。 */
export function checkCrossModuleCalls(mods: readonly ModuleEntry[], calls: readonly CrossModuleCall[], declared: readonly string[]): string[] {
  if (declared.length === 0) return [];
  const by = new Map(mods.map((m) => [m.name, m]));
  const callers = declared.filter((d) => by.has(d));
  const out: string[] = [];
  for (const c of calls) {
    if (declared.includes(c.module)) continue;
    const target = by.get(c.module);
    if (!target) {
      out.push(`跨模組呼叫的模組「${c.module}」不在模組地圖（呼叫「${c.module}.${c.iface}」）`);
      continue;
    }
    const iface = target.interfaces.find((i) => i.name === c.iface);
    if (!iface) {
      out.push(`呼叫的介面「${c.module}.${c.iface}」不在模組「${c.module}」的對外介面清單（只能使用對方清單內的介面，先請對方登記）`);
      continue;
    }
    if (c.version !== undefined && iface.version !== undefined && c.version !== iface.version) out.push(`呼叫「${c.module}.${c.iface}」寫的版本 v${c.version} 與清單目前版本 v${iface.version} 不符`);
    if (callers.length > 0 && !callers.some((d) => by.get(d)?.dependsOn.includes(c.module))) out.push(`本工作項目的模組「${callers.join("、")}」沒有宣告依賴「${c.module}」（先在模組地圖的「依賴模組」補上）`);
    if (!callers.some((d) => iface.users.includes(d))) out.push(`本工作項目的模組「${declared.join("、")}」不在「${c.module}.${c.iface}」的使用者模組清單（先在介面清單登記使用者）`);
  }
  return out;
}
