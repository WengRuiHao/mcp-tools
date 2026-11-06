import { GATES_FILE_CANDIDATES, readFirstExisting } from "../project-rule-files.js";
import { parseProjectFlowOverride, type ProjectFlowOverride } from "./schema.js";

/** flow.json 候選路徑，沿用 gates.json 同一套機制（.pipeline 優先，其次 .claude/pipeline-roles）。 */
export const FLOW_FILE_CANDIDATES: string[] = GATES_FILE_CANDIDATES.map((p) => p.replace(/gates\.json$/, "flow.json"));

/** 讀專案 flow.json：沒有檔案回 null；JSON 壞掉或欄位越權一律丟錯（不悄悄退回預設）。 */
export async function loadProjectFlowOverride(projectDir: string): Promise<ProjectFlowOverride | null> {
  const found = await readFirstExisting(projectDir, FLOW_FILE_CANDIDATES);
  if (!found) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(found.content);
  } catch {
    throw new Error(`${found.relPath} 不是合法的 JSON，請修正後再呼叫`);
  }
  const parsed = parseProjectFlowOverride(raw);
  if (!parsed.ok) throw new Error(`${found.relPath} 不合法：${parsed.errors.join("；")}`);
  return parsed.value;
}
