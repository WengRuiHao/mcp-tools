import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { TicketStatus } from "../pipeline-store.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { isRoleDone } from "../workflow/work-item-progress.js";
import { isLegacyLayout } from "./context.js";
import { checkDeliverables } from "./deliverables.js";

/**
 * 問題 80：角色可能不走 work_item write、直接用 Edit／Write 改產出檔。引擎在角色 done 與 write 通過檢查時，
 * 記下該角色文字產出檔的 SHA-256（status.deliverable_hashes）；之後別的角色 done 時，雜湊變了（或沒紀錄）的已完成角色
 * 會重跑同一套交件內容檢查（checkDeliverables），沒改動的不重跑。
 * 只雜湊文字檔（.md／.sql／.mmd）：圖片、mockup 的 html／css／js 由 attach 放入，不納入，避免 attach 造成誤判。
 */

export type RoleHashes = Record<string, string>;
const HASHED_EXTENSIONS = new Set([".md", ".sql", ".mmd"]);
const MAX_WALK_DEPTH = 4;

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

async function walkDir(root: string, rel: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return;
  const entries = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const child = `${rel}${e.name}`;
    if (e.isDirectory()) await walkDir(root, `${child}/`, depth + 1, out);
    else if (e.isFile() && HASHED_EXTENSIONS.has(path.extname(e.name).toLowerCase())) out.push(child);
  }
}

/** 角色產出檔（主檔＋附屬檔；資料夾型遞迴展開）中實際存在的文字檔相對路徑。 */
async function outputFiles(dir: string, def: WorkflowDefinition, roleId: string): Promise<string[]> {
  const role = def.roles.find((r) => r.id === roleId);
  if (!role) return [];
  const paths = role.outputs.flatMap((o) => {
    const a = def.artifacts.find((x) => x.id === o);
    return a ? [a.file, ...(a.attachments ?? [])] : [];
  });
  const files: string[] = [];
  for (const p of new Set(paths)) {
    if (p.endsWith("/")) await walkDir(dir, p, 0, files);
    else if (HASHED_EXTENSIONS.has(path.extname(p).toLowerCase()) && (await stat(path.join(dir, p)).then((s) => s.isFile(), () => false))) files.push(p);
  }
  return [...new Set(files)];
}

/** 角色目前的產出檔雜湊（相對路徑 → sha256）。 */
export async function hashRoleOutputs(dir: string, def: WorkflowDefinition, roleId: string): Promise<RoleHashes> {
  const files = (await outputFiles(dir, def, roleId)).sort();
  const entries = await Promise.all(files.map(async (f) => [f, sha256(await readFile(path.join(dir, f)))] as const));
  return Object.fromEntries(entries);
}

const sameHashes = (a: RoleHashes, b: RoleHashes): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/** 和紀錄不同的檔案（新增、改動、刪除），用在錯誤訊息。 */
function changedFiles(recorded: RoleHashes, current: RoleHashes): string[] {
  return [...new Set([...Object.keys(recorded), ...Object.keys(current)])].filter((k) => recorded[k] !== current[k]).sort();
}

export interface UpstreamRecheck {
  /** 重新檢查未通過的訊息（含角色與檔名）。 */
  problems: string[];
  /** 本次要寫回 status 的雜湊（通過重檢，或舊項目補基準線的角色）。檢查未通過的角色不更新，下次 done 仍會被擋。 */
  hashes: Record<string, RoleHashes>;
}

/**
 * 對「已完成、且產出檔和紀錄的雜湊不同」的角色（不含正在 done 的角色）重跑交件內容檢查。
 * 沒有紀錄的角色：新版面視為「沒經過 write」一律重檢；舊版面（legacy）相容，只補基準線、不重檢。
 */
export async function recheckChangedRoles(dir: string, status: TicketStatus, def: WorkflowDefinition, doingRoleId: string, selectedStyle: string | undefined): Promise<UpstreamRecheck> {
  const legacy = isLegacyLayout(status);
  const recordedAll = status.deliverable_hashes ?? {};
  const problems: string[] = [];
  const hashes: Record<string, RoleHashes> = {};
  for (const role of def.roles) {
    if (role.id === doingRoleId || !isRoleDone(status.work_item_progress, role.id)) continue;
    const current = await hashRoleOutputs(dir, def, role.id);
    const recorded = recordedAll[role.id];
    if (recorded && sameHashes(recorded, current)) continue;
    if (!recorded && legacy) {
      hashes[role.id] = current;
      continue;
    }
    const roleProblems = await checkDeliverables(dir, role.id, def, { techSource: status.tech_source, highRisk: status.high_risk === true, projectDir: status.project_dir, baseline: status.baseline, selectedStyle, legacy }).catch((e: unknown) => [`重新檢查時發生錯誤：${e instanceof Error ? e.message : String(e)}`]);
    if (roleProblems.length === 0) {
      hashes[role.id] = current;
      continue;
    }
    const files = recorded ? changedFiles(recorded, current) : Object.keys(current);
    problems.push(`已完成角色「${role.id}」的產出檔（${files.join("、") || "產出檔"}）${recorded ? "在交件後被改動" : "沒有經過 work_item write 的紀錄"}，重新檢查未通過：${roleProblems.join("；")}。請修正後用 work_item write 寫回`);
  }
  return { problems, hashes };
}
