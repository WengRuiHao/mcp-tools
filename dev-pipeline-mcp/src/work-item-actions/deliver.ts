import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { convertSaToDocx } from "../export/sa-docx.js";
import { latestVersion } from "../workflow/version-history-check.js";
import { isGatePassed, isRoleDone } from "../workflow/work-item-progress.js";
import { WorkItemActionError, errorMessage, need, okReply, type ToolReply } from "./common.js";
import { isLegacyLayout, loadEffectiveDef, loadWorkItem, type WorkItemContext } from "./context.js";
import { checkDeliverables } from "./deliverables.js";
import { DELIVERABLES_DIR, refreshIndexDoc } from "./index-doc.js";
import type { WorkItemArgs } from "./schema.js";

/**
 * deliver：把正式交付物輸出成客戶命名的副本到 deliverables/（內部檔名維持不動）。
 * SA → <標題>_系統分析書_v<版次>.md／.docx（圖片放 <同名>_images/）；
 * SD → <標題>_系統設計書_v<版次>.md（流程圖圖片放 <同名>_images/，TableSchema 文件與 ER 圖一併複製到 deliverables/TableSchema/）。
 * 前置條件：產出角色已 done、對應確認關卡已通過；交付前重跑一次交件內容檢查。不改動 status.json。
 */

type Target = "sa" | "sd";

interface TargetSpec {
  role: string;
  gate: string;
  md: string;
  label: string;
}

const TARGETS: Readonly<Record<Target, TargetSpec>> = {
  sa: { role: "sa-analyst", gate: "sa-confirm", md: "01-sa.md", label: "系統分析書" },
  sd: { role: "sd-analyst", gate: "sd-confirm", md: "03-sd.md", label: "系統設計書" },
};

const MERMAID_FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*mermaid/im;
const MERMAID_BLOCK_RE = /^```mermaid[^\n]*\n[\s\S]*?^```[ \t]*\r?\n(?:\r?\n)?/gm;
const MAX_NAME_LENGTH = 80;

/** 工作項目標題轉成可當檔名的片語：移除不合法字元與控制字元、空白轉底線、去尾端點與空白、限長。 */
export function sanitizeDeliverTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, "")
    .split("")
    .filter((c) => c.charCodeAt(0) >= 0x20)
    .join("")
    .replace(/\s+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/[_.]+$/g, "");
  return cleaned === "" ? "工作項目" : cleaned;
}

export const deliverBaseName = (title: string, label: string, version: string): string => `${sanitizeDeliverTitle(title)}_${label}_v${version}`;

async function isPlainFile(file: string): Promise<boolean> {
  const st = await lstat(file).catch(() => null);
  return st !== null && st.isFile() && !st.isSymbolicLink();
}

async function readVersion(dir: string, spec: TargetSpec): Promise<string> {
  const text = await readFile(path.join(dir, spec.md), "utf-8").catch(() => null);
  const v = text === null ? null : latestVersion(text);
  if (v === null) throw new WorkItemActionError(`${spec.md} 的「版本管控歷程」讀不到有效的最新版次（格式例如 0.2、1.0），無法命名交付檔。`);
  return v;
}

/** 前置條件與交付前檢查：產出角色 done、確認關卡通過、交件內容檢查仍合格。 */
async function assertDeliverable(ctx: WorkItemContext, def: Awaited<ReturnType<typeof loadEffectiveDef>>["def"], spec: TargetSpec): Promise<void> {
  const progress = ctx.status.work_item_progress;
  if (!isRoleDone(progress, spec.role)) throw new WorkItemActionError(`${spec.label}還不能交付：角色 ${spec.role} 尚未 done（${spec.md} 要先完成交件）。`);
  if (!isGatePassed(progress, spec.gate)) throw new WorkItemActionError(`${spec.label}還不能交付：關卡 ${spec.gate} 尚未通過（${spec.md} 要先經確認）。`);
  const problems = await checkDeliverables(ctx.dir, spec.role, def, { techSource: ctx.status.tech_source, projectDir: ctx.status.project_dir, baseline: ctx.status.baseline, legacy: isLegacyLayout(ctx.status) });
  if (problems.length > 0) throw new WorkItemActionError(`${spec.label}交付前的內容檢查未通過，請修正後再交付：`, { problems });
}

const encodeBase = (base: string): string => encodeURI(base);

async function copyPlain(src: string, dest: string): Promise<boolean> {
  if (!(await isPlainFile(src))) return false;
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(src, dest);
  return true;
}

async function writeChecked(root: string, rel: string, content: string): Promise<void> {
  const full = path.join(root, rel);
  const real = await realpath(path.dirname(full)).catch(() => path.dirname(full));
  if (!full.startsWith(root + path.sep) || !(real === root || real.startsWith(root + path.sep))) throw new WorkItemActionError(`輸出路徑超出 ${DELIVERABLES_DIR}/：${rel}`);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

async function deliverSa(ctx: WorkItemContext, root: string, base: string, warnings: string[]): Promise<string[]> {
  const out: string[] = [];
  const text = await readFile(path.join(ctx.dir, TARGETS.sa.md), "utf-8");
  if (MERMAID_FENCE_RE.test(text)) throw new WorkItemActionError(`${TARGETS.sa.md} 內還有 mermaid 區塊，交付文件不放 mermaid（圖用 sa-images/ 的截圖），修正後再交付。`);
  const imagesDir = `${base}_images`;
  await writeChecked(root, `${base}.md`, text.split("](sa-images/").join(`](${encodeBase(imagesDir)}/`));
  out.push(`${DELIVERABLES_DIR}/${base}.md`);
  for (const name of (await readdir(path.join(ctx.dir, "sa-images")).catch(() => [])).sort()) {
    if (await copyPlain(path.join(ctx.dir, "sa-images", name), path.join(root, imagesDir, name))) out.push(`${DELIVERABLES_DIR}/${imagesDir}/${name}`);
  }
  const docx = path.join(ctx.dir, "01-sa.docx");
  const [mdStat, docxStat] = await Promise.all([lstat(path.join(ctx.dir, TARGETS.sa.md)), lstat(docx).catch(() => null)]);
  let docxReady = docxStat !== null && docxStat.isFile() && !docxStat.isSymbolicLink() && docxStat.mtimeMs >= mdStat.mtimeMs;
  if (!docxReady) {
    const r = await convertSaToDocx(ctx.dir);
    if (r.status === "ok") docxReady = true;
    else if (r.status === "unavailable") warnings.push(`未輸出 Word（.docx）：${r.hint}`);
    else warnings.push(`未輸出 Word（.docx）：${r.message}`);
  }
  if (docxReady && (await copyPlain(docx, path.join(root, `${base}.docx`)))) out.push(`${DELIVERABLES_DIR}/${base}.docx`);
  return out;
}

/** TableSchema 文件的回指連結改成客戶命名（../03-sd.md → ../<SD 檔名>.md、../01-sa.md → ../<SA 檔名>.md）。 */
const rewriteBackLinks = (text: string, saBase: string, sdBase: string): string => text.split("](../03-sd.md").join(`](../${encodeBase(sdBase)}.md`).split("](../01-sa.md").join(`](../${encodeBase(saBase)}.md`);

async function deliverSd(ctx: WorkItemContext, root: string, base: string, saBase: string): Promise<string[]> {
  const out: string[] = [];
  const text = await readFile(path.join(ctx.dir, TARGETS.sd.md), "utf-8");
  if (MERMAID_FENCE_RE.test(text)) throw new WorkItemActionError(`${TARGETS.sd.md} 內還有 mermaid 區塊，交付文件不放 mermaid（流程圖用 flow.png），修正後再交付。`);
  const imagesDir = `${base}_images`;
  await writeChecked(root, `${base}.md`, text.split("](flow.png)").join(`](${encodeBase(imagesDir)}/flow.png)`));
  out.push(`${DELIVERABLES_DIR}/${base}.md`);
  if (await copyPlain(path.join(ctx.dir, "flow.png"), path.join(root, imagesDir, "flow.png"))) out.push(`${DELIVERABLES_DIR}/${imagesDir}/flow.png`);
  // SD 的「使用資料表」連結指向 TableSchema/<文件>.md#表名：文件與 ER 圖一併複製，連結才不會斷
  const schemaDir = path.join(ctx.dir, "TableSchema");
  for (const name of (await readdir(schemaDir).catch(() => [])).filter((n) => n.toLowerCase().endsWith(".md")).sort()) {
    const raw = await readFile(path.join(schemaDir, name), "utf-8");
    // 舊版面的資料表文件把 ER 圖 Mermaid 內嵌在文件、旁邊已有轉好的 PNG：交付副本直接拿掉 mermaid 區塊，只留圖片
    const md = isLegacyLayout(ctx.status) ? raw.replace(MERMAID_BLOCK_RE, "") : raw;
    if (MERMAID_FENCE_RE.test(md)) throw new WorkItemActionError(`TableSchema/${name} 內還有 mermaid 區塊，交付文件不放 mermaid，修正後再交付。`);
    await writeChecked(root, `TableSchema/${name}`, rewriteBackLinks(md, saBase, base));
    out.push(`${DELIVERABLES_DIR}/TableSchema/${name}`);
  }
  for (const name of (await readdir(path.join(schemaDir, "er")).catch(() => [])).filter((n) => n.toLowerCase().endsWith(".png")).sort()) {
    if (await copyPlain(path.join(schemaDir, "er", name), path.join(root, "TableSchema", "er", name))) out.push(`${DELIVERABLES_DIR}/TableSchema/er/${name}`);
  }
  return out;
}

export async function handleDeliver(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId } = need("deliver", a, ["workItemId"]);
  const target = a.target ?? "all";
  const targets: Target[] = target === "all" ? ["sa", "sd"] : [target];
  const ctx = await loadWorkItem(workItemId);
  const { def } = await loadEffectiveDef(ctx.status);
  for (const t of targets) await assertDeliverable(ctx, def, TARGETS[t]);
  const title = ctx.status.name ?? path.basename(ctx.dir);
  // SA 版次一定要讀（SD 的 TableSchema 文件回指 SA）；SD 版次只在交付 SD 時讀（SD 可能還沒完成）
  const versions: Record<Target, string> = { sa: await readVersion(ctx.dir, TARGETS.sa), sd: targets.includes("sd") ? await readVersion(ctx.dir, TARGETS.sd) : "" };
  const bases = { sa: deliverBaseName(title, TARGETS.sa.label, versions.sa), sd: deliverBaseName(title, TARGETS.sd.label, versions.sd) };
  const root = path.join(ctx.dir, DELIVERABLES_DIR);
  await mkdir(root, { recursive: true });
  const rootReal = await realpath(root);
  const warnings: string[] = [];
  const files: string[] = [];
  try {
    if (targets.includes("sa")) files.push(...(await deliverSa(ctx, rootReal, bases.sa, warnings)));
    if (targets.includes("sd")) files.push(...(await deliverSd(ctx, rootReal, bases.sd, bases.sa)));
  } catch (e) {
    if (e instanceof WorkItemActionError) throw e;
    throw new WorkItemActionError(`交付失敗：${errorMessage(e)}`);
  }
  const indexWarning = await refreshIndexDoc(ctx);
  return okReply({
    workItemId: ctx.id,
    target,
    versions: Object.fromEntries(targets.map((t) => [t, versions[t]])),
    files,
    ...(warnings.length > 0 ? { warnings } : {}),
    note: "已輸出客戶命名的副本到 deliverables/（內部檔名不變）；SD 轉 Word 由人工負責。同名再交付會覆寫，不同版次的檔案並存。",
    ...(indexWarning ? { indexWarning } : {}),
  });
}
