import { z } from "zod";

/** 可供 zod object 展開的兩個選填欄位：taskGid 與 workItemId 擇一。 */
export const workItemIdParams = {
  taskGid: z.string().optional().describe("taskGid 與 workItemId 擇一，Asana 票單用 taskGid"),
  workItemId: z.string().optional().describe("taskGid 與 workItemId 擇一，Asana 票單用 taskGid"),
};

/**
 * 解析工作項目 id：對外雙收 taskGid / workItemId，內部統一回傳單一字串。
 * 兩者都給且（trim 後）不同值、或都沒給，皆丟出繁體中文錯誤。
 */
export function resolveWorkItemIdArg(args: { taskGid?: string; workItemId?: string }): string {
  const gid = args.taskGid?.trim() || undefined;
  const wid = args.workItemId?.trim() || undefined;
  if (gid && wid && gid !== wid) {
    throw new Error(`taskGid（${gid}）與 workItemId（${wid}）同時提供但值不同，請只給其中一個，或讓兩者相同`);
  }
  const id = gid ?? wid;
  if (!id) {
    throw new Error("缺少必要參數：請提供 taskGid 或 workItemId 其中一個（Asana 票單用 taskGid）");
  }
  return id;
}
