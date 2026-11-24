// 模組地圖（專案層文件 module-map.md）：解析與檢查（批次 2M-b）。純文字，不讀檔案。
// 格式：每個模組一個「## 模組：名稱」區塊，底下每行「- 項目：內容」（也接受粗體標籤、全形半形冒號）。
// 項目：負責人、類型（系統模組）、狀態（已完成／開發中，沒寫視為已完成）、擁有資料表、依賴模組。
import { extractSection } from "./workflow/reuse-record-check.js";
import { listHeadings } from "./workflow/sa-image-check.js";

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

/** 模組地圖本身的結構問題（寫入時回警告）：模組重複、沒有負責人、資料表兩個擁有者、依賴不存在、循環依賴。 */
export function moduleMapProblems(mods: readonly ModuleEntry[]): string[] {
  const out: string[] = [];
  const names = new Set<string>();
  for (const m of mods) {
    if (names.has(m.name)) out.push(`模組「${m.name}」重複定義`);
    names.add(m.name);
    if (!m.owner) out.push(`模組「${m.name}」沒有負責人（寫「- 負責人：姓名」）`);
  }
  const owner = new Map<string, string>();
  for (const m of mods) {
    for (const t of m.tables) {
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

/** 工作項目宣告的模組都要在地圖裡。 */
export function checkModulesDeclared(mods: readonly ModuleEntry[], declared: readonly string[]): string[] {
  const known = new Set(mods.map((m) => m.name));
  return declared.filter((d) => !known.has(d)).map((d) => `宣告的模組「${d}」不在模組地圖（先把它登記到專案層文件 ${MODULE_MAP_FILE}，或修正模組名稱）`);
}

/** 資料表擁有權：只有擁有者能寫；工作項目動到別的模組擁有、且自己沒宣告該模組的資料表就擋。沒人擁有的表不擋。 */
export function checkTableOwnership(mods: readonly ModuleEntry[], tables: readonly string[], declared: readonly string[]): string[] {
  const mine = new Set(declared);
  const out: string[] = [];
  for (const t of tables) {
    const o = mods.find((m) => m.tables.includes(t));
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
