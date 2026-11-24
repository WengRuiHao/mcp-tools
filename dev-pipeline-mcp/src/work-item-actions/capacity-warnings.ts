import { CAPACITY_FILE, overdueCapacityAssumptions, parseCapacityAssumptions } from "../capacity-assumptions.js";
import { readProjectDoc } from "../project-docs-store.js";

const todayIso = (now: Date): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** 高風險工作項目的 get：專案層容量假設有逾期的才回 capacityWarnings；非高風險、沒有文件、沒有逾期都不多欄位。 */
export async function capacityWarningsField(projectDir: string | null | undefined, highRisk: boolean | undefined, now: Date = new Date()): Promise<{ capacityWarnings?: string[] }> {
  if (!projectDir || highRisk !== true) return {};
  const doc = await readProjectDoc(projectDir, CAPACITY_FILE).catch(() => null);
  if (!doc || !doc.exists) return {};
  const over = overdueCapacityAssumptions(parseCapacityAssumptions(doc.content), todayIso(now));
  return over.length > 0 ? { capacityWarnings: over.map((a) => `容量假設「${a.text}」已逾期（到期日 ${a.date}）；請重新評估並更新 ${CAPACITY_FILE}`) } : {};
}
