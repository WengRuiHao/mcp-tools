import path from "node:path";
import { SA_FILE_NAME } from "../workflow/sa-image-check.js";
import { TEST_FILE_NAME } from "../workflow/test-evidence-check.js";
import { parseSaRequirementIds, testTraceabilityWarnings } from "../workflow/traceability-check.js";
import { readOptionalText } from "./sd-impl-warnings.js";

/** 高風險需求的測試工程師交件：測試報告與 SA 需求編號的追溯警告（只警告不擋；缺檔或 SA 沒有編號回空）。 */
export async function testTraceabilityWarningsFor(dir: string, roleId: string, highRisk: boolean): Promise<string[]> {
  if (!highRisk || roleId !== "tester") return [];
  const [sa, test] = await Promise.all([readOptionalText(path.join(dir, SA_FILE_NAME)), readOptionalText(path.join(dir, TEST_FILE_NAME))]);
  if (sa === undefined || test === undefined) return [];
  return testTraceabilityWarnings(test, parseSaRequirementIds(sa).ids).map((w) => `追溯矩陣：${w}`);
}
