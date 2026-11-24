import { updateStatus } from "../pipeline-store.js";
import { CAPACITY_FILE, capacityDocProblems, parseCapacityAssumptions } from "../capacity-assumptions.js";
import { MODULE_MAP_FILE, contractExampleProblems, glossaryProblems, interfaceChangeNotices, interfaceConditionProblems, parseContractExamples, moduleMapProblems, parseGlossary, parseModuleMap, parseScenarios, scenarioProblems } from "../module-map.js";
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

/** project_doc_read：不帶 filename 列出現有文件與可用名稱；帶 filename 回內容與 sha256（寫入時帶回 expectedSha256 做版本比對）。 */
export async function handleProjectDocRead(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId } = need("project_doc_read", a, ["workItemId"]);
  const { id, projectDir } = await projectDirOf(workItemId);
  if (a.filename === undefined || a.filename.trim() === "") {
    return okReply({ workItemId: id, docs: await listProjectDocs(projectDir), allowedNames: [...PROJECT_DOC_NAMES] });
  }
  assertName(a.filename);
  const doc = await readProjectDoc(projectDir, a.filename);
  return okReply({ workItemId: id, doc: a.filename, exists: doc.exists, content: doc.content, sha256: doc.sha256 });
}

/** project_doc_write：整份寫入；帶 expectedSha256 時與目前版本不符會拒絕（回 conflict:true）。 */
export async function handleProjectDocWrite(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId, filename } = need("project_doc_write", a, ["workItemId", "filename"]);
  if (typeof a.content !== "string") throw new WorkItemActionError("action=project_doc_write 缺少必填參數：content");
  assertName(filename);
  const { id, dir, projectDir } = await projectDirOf(workItemId);
  let result;
  const before = filename === MODULE_MAP_FILE ? (await readProjectDoc(projectDir, filename)).content : "";
  try {
    result = await writeProjectDoc(projectDir, filename, a.content, a.expectedSha256 !== undefined ? { expectedSha256: a.expectedSha256 } : {});
  } catch (e) {
    if (e instanceof ProjectDocConflictError) throw new WorkItemActionError(e.message, { conflict: true });
    throw new WorkItemActionError(errorMessage(e));
  }
  if (result.changed) {
    const at = new Date().toISOString();
    const updated = await updateStatus(id, (s) => ({ ...s, project_doc_changes: [...(s.project_doc_changes ?? []), { doc: filename, at, sha256: result.sha256 }].slice(-MAX_RECORDED_CHANGES) }));
    // 索引列出專案層文件；更新失敗不影響寫入，只附警告
    const indexWarning = await refreshIndexDoc({ dir, status: updated });
    const mapProblems = filename === MODULE_MAP_FILE ? [...moduleMapProblems(parseModuleMap(a.content), parseGlossary(a.content)), ...glossaryProblems(parseGlossary(a.content)), ...scenarioProblems(parseModuleMap(a.content), parseScenarios(a.content)), ...contractExampleProblems(parseModuleMap(a.content), parseContractExamples(a.content)), ...interfaceConditionProblems(a.content)] : [];
    const capacityProblems = filename === CAPACITY_FILE ? capacityDocProblems(parseCapacityAssumptions(a.content)) : [];
    const notices = filename === MODULE_MAP_FILE ? interfaceChangeNotices(before, a.content) : [];
    return okReply({ workItemId: id, doc: filename, sha256: result.sha256, bytes: result.bytes, changed: result.changed, ...(mapProblems.length > 0 ? { moduleMapWarnings: mapProblems } : {}), ...(notices.length > 0 ? { interfaceChangeNotices: notices } : {}), ...(capacityProblems.length > 0 ? { capacityWarnings: capacityProblems } : {}), ...(indexWarning ? { indexWarning } : {}) });
  }
  return okReply({ workItemId: id, doc: filename, sha256: result.sha256, bytes: result.bytes, changed: result.changed });
}
