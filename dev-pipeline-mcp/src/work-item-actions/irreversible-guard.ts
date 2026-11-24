import { readFile } from "node:fs/promises";
import path from "node:path";
import { hasIrreversibleDbChange } from "../workflow/sd-rollout-check.js";
import { WorkItemActionError } from "./common.js";

const SD_CONFIRM_GATE = "sd-confirm";

/** 高風險且 SD 寫了不可逆的 DB 變更時，SD 確認只能由使用者本人核准；AI 代確認會被擋（打回不受限）。 */
export async function requireHumanForIrreversible(dir: string, status: { high_risk?: boolean }, gateId: string, by: string, decision: string): Promise<void> {
  if (gateId !== SD_CONFIRM_GATE || by !== "agent" || decision !== "confirmed" || status.high_risk !== true) return;
  const text = await readFile(path.join(dir, "03-sd.md"), "utf-8").catch(() => undefined);
  if (text === undefined || !hasIrreversibleDbChange(text)) return;
  throw new WorkItemActionError(`關卡「${gateId}」：這份 SD 的「DB 變更回滾」寫了不可逆，高風險需求的不可逆資料庫變更必須由使用者本人確認（by="human"，reason 附使用者原話），AI 不可代確認。`);
}
