import { updateStatus } from "../pipeline-store.js";
import { CAPACITY_FILE, capacityDocProblems, parseCapacityAssumptions } from "../capacity-assumptions.js";
import { LEGACY_EXCEPTIONS_FILE, legacyExceptionProblems } from "../legacy-exceptions.js";
import { MODULE_MAP_FILE, contractExampleProblems, glossaryProblems, interfaceChangeNotices, interfaceConditionProblems, parseContractExamples, moduleMapProblems, parseGlossary, parseModuleMap, parseScenarios, scenarioProblems } from "../module-map.js";
import { getSection, parseSections, replaceSection, sectionSha256, singleSectionKey } from "../doc-sections.js";
import { refreshIndexDoc } from "./index-doc.js";
import { PROJECT_DOC_NAMES, ProjectDocConflictError, isProjectDocName, listProjectDocs, readProjectDoc, writeProjectDoc } from "../project-docs-store.js";
import { WorkItemActionError, errorMessage, need, okReply, type ToolReply } from "./common.js";
import { loadWorkItem } from "./context.js";
import type { WorkItemArgs } from "./schema.js";

/** 專案層級文件（跨功能共用）的讀寫動作；檔名限固定白名單，寫入記錄在工作項目狀態，供交付摘要呈現。 */

const MAX_RECORDED_CHANGES = 50;

async function projectDirOf(workItemId: string): Promise<{ id: string; dir: string; projectDir: string }> {
  const ctx = await loadWorkItem(workItemId);
  const projectDir = ctx.status.project_dir;
  if (!projectDir) throw new WorkItemActionError(`工作項目「${ctx.id}」沒有記錄專案目錄，無法存取專案層文件`);
  return { id: ctx.id, dir: ctx.dir, projectDir };
}

function assertName(filename: string): void {
  if (!isProjectDocName(filename)) throw new WorkItemActionError(`不允許的專案層文件名稱「${filename}」；只接受：${PROJECT_DOC_NAMES.join("、")}`);
}

const requireMarkdown = (filename: string): void => {
  if (!filename.endsWith(".md")) throw new WorkItemActionError(`section 只能用在 .md 專案層文件，「${filename}」不是`);
};
const listKeys = (text: string): string => parseSections(text).map((x) => x.key).join("、") || "（沒有任何段落）";
const MAX_SECTION_RETRIES = 3;

/** 段落式寫入：只比對該段版本，合併進最新的整份文件再寫入；整份在讀寫之間被別人改過就重新合併（最多 MAX_SECTION_RETRIES 次）。 */
async function writeSection(projectDir: string, filename: string, section: string, newSection: string, expected: string | undefined): Promise<{ content: string; before: string; result: Awaited<ReturnType<typeof writeProjectDoc>> }> {
  requireMarkdown(filename);
  try {
    singleSectionKey(newSection, section);
  } catch (e) {
    throw new WorkItemActionError(errorMessage(e));
  }
  for (let attempt = 0; attempt < MAX_SECTION_RETRIES; attempt++) {
    const doc = await readProjectDoc(projectDir, filename);
    const current = getSection(doc.content, section);
    if (current === undefined && expected !== undefined) throw new WorkItemActionError(`文件「${filename}」現在沒有「## ${section}」這一段（可能被別人刪了）；請重新讀取後再決定`, { conflict: true });
    if (current !== undefined) {
      if (expected === undefined) throw new WorkItemActionError(`「## ${section}」已存在，改寫必須帶 expectedSectionSha256（先用 project_doc_read 帶 section 讀取，取得 sectionSha256）`);
      if (expected !== sectionSha256(current)) throw new WorkItemActionError(`「## ${section}」在你讀取之後已被更新；請重新讀取該段，只重做自己的改動再寫入`, { conflict: true });
    }
    const content = replaceSection(doc.content, section, newSection);
    try {
      return { content, before: doc.content, result: await writeProjectDoc(projectDir, filename, content, doc.sha256 !== null ? { expectedSha256: doc.sha256 } : {}) };
    } catch (e) {
      if (e instanceof ProjectDocConflictError) continue; // 別的段落剛被改：重新讀取合併
      throw new WorkItemActionError(errorMessage(e));
    }
  }
  throw new WorkItemActionError(`「${filename}」正被頻繁寫入，合併重試 ${MAX_SECTION_RETRIES} 次仍失敗；請稍後重試`, { conflict: true });
}

/** project_doc_read：不帶 filename 列出現有文件與可用名稱；帶 filename 回內容與 sha256（寫入時帶回 expectedSha256 做版本比對）。 */
export async function handleProjectDocRead(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId } = need("project_doc_read", a, ["workItemId"]);
  const { id, projectDir } = await projectDirOf(workItemId);
  if (a.filename === undefined || a.filename.trim() === "") {
    return okReply({ workItemId: id, docs: await listProjectDocs(projectDir), allowedNames: [...PROJECT_DOC_NAMES] });
  }
  assertName(a.filename);
  const doc = await readProjectDoc(projectDir, a.filename);
  if (a.section !== undefined) {
    requireMarkdown(a.filename);
    const sec = getSection(doc.content, a.section);
    if (sec === undefined) throw new WorkItemActionError(`文件「${a.filename}」沒有「## ${a.section}」這一段；可用段落：${listKeys(doc.content)}`);
    return okReply({ workItemId: id, doc: a.filename, section: a.section, content: sec, sectionSha256: sectionSha256(sec), sha256: doc.sha256 });
  }
  return okReply({ workItemId: id, doc: a.filename, exists: doc.exists, content: doc.content, sha256: doc.sha256 });
}

/** project_doc_write：整份寫入；帶 expectedSha256 時與目前版本不符會拒絕（回 conflict:true）。 */
export async function handleProjectDocWrite(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId, filename } = need("project_doc_write", a, ["workItemId", "filename"]);
  if (typeof a.content !== "string") throw new WorkItemActionError("action=project_doc_write 缺少必填參數：content");
  assertName(filename);
  const { id, dir, projectDir } = await projectDirOf(workItemId);
  let result;
  let content = a.content;
  let before = filename === MODULE_MAP_FILE ? (await readProjectDoc(projectDir, filename)).content : "";
  if (a.section !== undefined) {
    ({ result, content, before } = await writeSection(projectDir, filename, a.section, a.content, a.expectedSectionSha256));
  } else {
    try {
      result = await writeProjectDoc(projectDir, filename, a.content, a.expectedSha256 !== undefined ? { expectedSha256: a.expectedSha256 } : {});
    } catch (e) {
      if (e instanceof ProjectDocConflictError) throw new WorkItemActionError(e.message, { conflict: true });
      throw new WorkItemActionError(errorMessage(e));
    }
  }
  if (result.changed) {
    const at = new Date().toISOString();
    const updated = await updateStatus(id, (s) => ({ ...s, project_doc_changes: [...(s.project_doc_changes ?? []), { doc: filename, at, sha256: result.sha256 }].slice(-MAX_RECORDED_CHANGES) }));
    // 索引列出專案層文件；更新失敗不影響寫入，只附警告
    const indexWarning = await refreshIndexDoc({ dir, status: updated });
    const mapProblems = filename === MODULE_MAP_FILE ? [...moduleMapProblems(parseModuleMap(content), parseGlossary(content)), ...glossaryProblems(parseGlossary(content)), ...scenarioProblems(parseModuleMap(content), parseScenarios(content)), ...contractExampleProblems(parseModuleMap(content), parseContractExamples(content)), ...interfaceConditionProblems(content)] : [];
    const capacityProblems = filename === CAPACITY_FILE ? capacityDocProblems(parseCapacityAssumptions(content)) : [];
    const legacyProblems = filename === LEGACY_EXCEPTIONS_FILE ? legacyExceptionProblems(content) : [];
    const notices = filename === MODULE_MAP_FILE ? interfaceChangeNotices(before, content) : [];
    return okReply({ workItemId: id, doc: filename, sha256: result.sha256, bytes: result.bytes, changed: result.changed, ...(mapProblems.length > 0 ? { moduleMapWarnings: mapProblems } : {}), ...(notices.length > 0 ? { interfaceChangeNotices: notices } : {}), ...(capacityProblems.length > 0 ? { capacityWarnings: capacityProblems } : {}), ...(legacyProblems.length > 0 ? { legacyExceptionWarnings: legacyProblems } : {}), ...(indexWarning ? { indexWarning } : {}) });
  }
  return okReply({ workItemId: id, doc: filename, sha256: result.sha256, bytes: result.bytes, changed: result.changed });
}
