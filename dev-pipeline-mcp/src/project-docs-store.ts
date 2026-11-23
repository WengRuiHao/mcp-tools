import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { withFileLock } from "./atomic-store.js";
import { snapshotIfChanged } from "./rule-history.js";

/**
 * 專案層級文件（跨功能共用）：放在 <projectDir>/.dev-pipeline/project-docs/，只接受固定白名單檔名。
 * 寫入是原子的（暫存檔加 rename）、同進程內以檔案鎖序列化，可帶 expectedSha256 做版本比對；
 * 覆寫前把舊內容存進規則檔的歷史快照（.pipeline/.history/，每檔保留最近 10 份），還原沿用 restore_rule_file。
 */

export const PROJECT_DOCS_DIR = ".dev-pipeline/project-docs";
export const MAX_PROJECT_DOC_BYTES = 512 * 1024;

/** 白名單：架構決策書、系統 BPMN、權限碼登記表、授權決策、模組地圖、遷移腳本編號登記表、專案層變更紀錄。 */
export const PROJECT_DOC_NAMES: readonly string[] = Object.freeze([
  "architecture-decisions.md",
  "system-bpmn.bpmn",
  "permission-codes.md",
  "authorization-decisions.md",
  "module-map.md",
  "migration-registry.json",
  "change-log.md",
]);

export class ProjectDocConflictError extends Error {
  constructor(name: string) {
    super(`專案層文件「${name}」在你讀取之後已被更新；請重新讀取最新內容，只重做自己的改動再寫入`);
    this.name = "ProjectDocConflictError";
  }
}

export const isProjectDocName = (name: string): boolean => PROJECT_DOC_NAMES.includes(name);

function assertName(name: string): void {
  if (!isProjectDocName(name)) throw new Error(`不允許的專案層文件名稱「${name}」；只接受：${PROJECT_DOC_NAMES.join("、")}`);
}

/** 專案目錄底下的相對路徑（用 / 分隔），也是歷史快照的 key。 */
export function projectDocRelPath(name: string): string {
  assertName(name);
  return `${PROJECT_DOCS_DIR}/${name}`;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const absPath = (projectDir: string, name: string): string => path.join(path.resolve(projectDir), ...projectDocRelPath(name).split("/"));

export interface ProjectDocRead {
  exists: boolean;
  content: string;
  /** 目前內容的 sha256；檔案不存在時為 null。寫入時帶回 expectedSha256 做版本比對。 */
  sha256: string | null;
}

export async function readProjectDoc(projectDir: string, name: string): Promise<ProjectDocRead> {
  const file = absPath(projectDir, name);
  try {
    const content = await readFile(file, "utf-8");
    return { exists: true, content, sha256: sha256(content) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, content: "", sha256: null };
    throw e;
  }
}

async function assertDocsDirNotSymlink(projectDir: string): Promise<void> {
  const dir = path.join(path.resolve(projectDir), ...PROJECT_DOCS_DIR.split("/"));
  try {
    if ((await lstat(dir)).isSymbolicLink()) throw new Error("專案層文件資料夾是符號連結，拒絕寫入");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export async function writeProjectDoc(projectDir: string, name: string, content: string, opts: { expectedSha256?: string } = {}): Promise<{ sha256: string; bytes: number; changed: boolean }> {
  const file = absPath(projectDir, name);
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_PROJECT_DOC_BYTES) throw new Error(`內容太大（${bytes} bytes），上限 ${MAX_PROJECT_DOC_BYTES} bytes`);
  return withFileLock(file, async () => {
    await assertDocsDirNotSymlink(projectDir);
    const current = await readProjectDoc(projectDir, name);
    if (opts.expectedSha256 !== undefined && opts.expectedSha256 !== current.sha256) throw new ProjectDocConflictError(name);
    if (current.exists && current.content === content) return { sha256: sha256(content), bytes, changed: false }; // 內容沒變：不重寫、不多存快照
    if (current.exists) await snapshotIfChanged(path.resolve(projectDir), projectDocRelPath(name), current.content);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, file);
    return { sha256: sha256(content), bytes, changed: true };
  });
}

export interface ProjectDocListing {
  name: string;
  bytes: number;
}

/** 只列白名單內實際存在的檔案。 */
export async function listProjectDocs(projectDir: string): Promise<ProjectDocListing[]> {
  const dir = path.join(path.resolve(projectDir), ...PROJECT_DOCS_DIR.split("/"));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: ProjectDocListing[] = [];
  for (const n of names.filter(isProjectDocName).sort()) {
    const s = await stat(path.join(dir, n)).catch(() => null);
    if (s?.isFile()) out.push({ name: n, bytes: s.size });
  }
  return out;
}
