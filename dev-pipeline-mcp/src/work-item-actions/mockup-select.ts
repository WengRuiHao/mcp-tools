import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { MOCKUP_DIR, CANDIDATES_DIR, STYLE_FILE_RE } from "../workflow/mockup-check.js";
import { WorkItemActionError } from "./common.js";

/** 全新待選風格（new-select）在 mockup-confirm 核准時，記錄使用者選定的風格並把落選候選移到 _candidates/。 */

export const MOCKUP_CONFIRM_GATE = "mockup-confirm";

export interface SelectedStyleInput {
  gateId: string;
  decision: "confirmed" | "rejected";
  styleSource: string | undefined;
  selected: string | undefined;
}

/** 這次 confirm 是否需要（也只有這種情況接受）selected。 */
export const needsSelectedStyle = (i: Pick<SelectedStyleInput, "gateId" | "decision" | "styleSource">): boolean =>
  i.styleSource === "new-select" && i.gateId === MOCKUP_CONFIRM_GATE && i.decision === "confirmed";

/** 驗證 selected：需要時必填且為 sa-mockup/ 內存在的 style-*.html；不需要卻給了就拒絕。回傳正規化後的檔名或 undefined。 */
export async function validateSelected(dir: string, i: SelectedStyleInput): Promise<string | undefined> {
  const given = i.selected?.trim() ?? "";
  if (!needsSelectedStyle(i)) {
    if (given !== "") throw new WorkItemActionError(`selected 只能用在「styleSource=new-select 且關卡 ${MOCKUP_CONFIRM_GATE} 核准（decision=confirmed）」；這次不適用，請移除 selected。`);
    return undefined;
  }
  if (given === "") throw new WorkItemActionError(`styleSource=new-select（全新待選）確認 ${MOCKUP_CONFIRM_GATE} 時必須用 selected 指定使用者選定的風格檔名（${MOCKUP_DIR}/ 內的 style-*.html，例如 style-a.html）。`);
  if (!STYLE_FILE_RE.test(given)) throw new WorkItemActionError(`selected「${given}」格式不對：只能是 ${MOCKUP_DIR}/ 內的風格檔名，形如 style-a.html（不可含路徑）。`);
  const file = path.join(dir, MOCKUP_DIR, given);
  const ok = await stat(file).then((s) => s.isFile(), () => false);
  if (!ok) throw new WorkItemActionError(`selected「${given}」不存在於 ${MOCKUP_DIR}/（候選檔必須在主目錄；已移到 ${CANDIDATES_DIR}/ 的不算）。`);
  return given;
}

async function uniqueTarget(dest: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${base}-${n}${ext}`;
    if (!(await stat(path.join(dest, candidate)).then(() => true, () => false))) return candidate;
  }
}

async function htmlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!e.name.startsWith("_")) await walk(path.join(d, e.name));
      } else if (e.isFile() && /\.html?$/i.test(e.name)) out.push(path.join(d, e.name));
    }
  };
  await walk(root);
  return out;
}

const HTML_REF_RE = /[^\s"'()<>=,;]+\.html?(?=[#?"')\s>,;]|$)/gi;

/** 其餘 html 以相對路徑引用了被移走的檔案：回警告（不擋）。 */
async function referenceWarnings(root: string, moved: readonly { from: string; to: string }[], dir: string): Promise<string[]> {
  if (moved.length === 0) return [];
  const olds = new Map(moved.map((m) => [path.resolve(dir, m.from).toLowerCase(), m]));
  const out: string[] = [];
  for (const f of await htmlFiles(root)) {
    let text: string;
    try {
      text = await readFile(f, "utf-8");
    } catch {
      continue;
    }
    const hit = new Set<string>();
    for (const m of text.matchAll(HTML_REF_RE)) {
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(m[0])) continue;
      const hitMove = olds.get(path.resolve(path.dirname(f), m[0].split(/[?#]/)[0]).toLowerCase());
      if (hitMove) hit.add(hitMove.from);
    }
    if (hit.size > 0) out.push(`${path.relative(dir, f).split(path.sep).join("/")} 以相對路徑引用了已移到 ${CANDIDATES_DIR}/ 的候選檔（${[...hit].join("、")}），連結會失效，請確認是否需要更新`);
  }
  return out;
}

export interface MovedCandidate {
  from: string;
  to: string;
}

/** 把 sa-mockup/ 主目錄其餘的 style-*.html 移動（不刪除）到 sa-mockup/_candidates/，同名加序號後綴。 */
export async function moveLosingCandidates(dir: string, selected: string): Promise<{ moved: MovedCandidate[]; warnings: string[] }> {
  const root = path.join(dir, MOCKUP_DIR);
  const losers = (await readdir(root, { withFileTypes: true })).filter((e) => e.isFile() && STYLE_FILE_RE.test(e.name) && e.name !== selected).map((e) => e.name).sort();
  if (losers.length === 0) return { moved: [], warnings: [] };
  const dest = path.join(root, CANDIDATES_DIR);
  await mkdir(dest, { recursive: true });
  const moved: MovedCandidate[] = [];
  for (const name of losers) {
    const target = await uniqueTarget(dest, name);
    await rename(path.join(root, name), path.join(dest, target));
    moved.push({ from: `${MOCKUP_DIR}/${name}`, to: `${MOCKUP_DIR}/${CANDIDATES_DIR}/${target}` });
  }
  return { moved, warnings: await referenceWarnings(root, moved, dir) };
}
