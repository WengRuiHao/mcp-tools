import type { RoleName } from "../prompts.js";
import { loadProjectFlowOverride } from "./load.js";

/** prompts 的固定角色對應 workflow 角色 id；對不上的 workflow 角色（例如 sa-analyst）不附加。 */
const FLOW_ROLE_IDS: Record<RoleName, readonly string[]> = {
  analyst: ["analyst"],
  "spec-writer": ["spec-writer", "spec-writer-first", "spec-writer-reverse"],
  engineer: ["engineer"],
  verifier: ["verifier"],
  tester: ["tester"],
};

/**
 * 只取專案 flow.json 覆寫裡該角色的 roleNotes（不含 legacy-adapter 轉出的內容）。
 * 沒有 flow.json、沒有該角色的 notes、或讀取／驗證失敗，一律無聲回空陣列。
 */
export async function loadFlowRoleNotes(projectDir: string, role: RoleName): Promise<string[]> {
  try {
    const override = await loadProjectFlowOverride(projectDir);
    const roles = override?.roles ?? {};
    return FLOW_ROLE_IDS[role].flatMap((id) => (roles[id]?.roleNotes ? [roles[id]!.roleNotes!] : []));
  } catch {
    return [];
  }
}
