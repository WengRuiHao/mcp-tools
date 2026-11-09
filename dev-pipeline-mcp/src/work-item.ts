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

type WorkItemArgs = { taskGid?: string; workItemId?: string };
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** 輸出若為 JSON 物件，補上與 taskGid 同值的 workItemId（已有則不動，原欄位與順序不變）。 */
export function withWorkItemIdInOutput<R extends ToolResult>(result: R, id: string): R {
  const first = result.content?.[0];
  if (!first || first.type !== "text") return result;
  try {
    const parsed: unknown = JSON.parse(first.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || "workItemId" in parsed) return result;
    return { ...result, content: [{ ...first, text: JSON.stringify({ ...parsed, workItemId: id }) }, ...result.content.slice(1)] };
  } catch {
    return result;
  }
}

/**
 * 工具入參邊界：把 taskGid / workItemId 解析成單一 taskGid 後交給原 handler，
 * 缺／衝突時回 isError 結果而非拋例外；成功輸出多帶 workItemId（同值）。
 */
export function withTaskGid<A extends WorkItemArgs, R extends ToolResult>(
  handler: (args: Omit<A, "taskGid" | "workItemId"> & { taskGid: string }) => Promise<R>
): (args: A) => Promise<R | ToolResult> {
  return async (args) => {
    let taskGid: string;
    try {
      taskGid = resolveWorkItemIdArg(args);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text: JSON.stringify({ success: false, message }) }], isError: true };
    }
    const { workItemId: _drop, ...rest } = args;
    const result = await handler({ ...rest, taskGid } as Omit<A, "taskGid" | "workItemId"> & { taskGid: string });
    return withWorkItemIdInOutput(result, taskGid);
  };
}

type OptionalWorkItemArgs = { taskGid?: string | null; workItemId?: string | null };

/**
 * 給「taskGid 本來就是選填」的工具（例如與 worktreeId／projectDir 擇一）：
 * 有給就解析（衝突回 isError），都沒給則維持原行為（taskGid 為 undefined 交回原 handler）。
 * 有解析出 id 時輸出多帶 workItemId。
 */
export function withOptionalTaskGid<A extends OptionalWorkItemArgs, R extends ToolResult>(
  handler: (args: Omit<A, "workItemId">) => Promise<R>
): (args: A) => Promise<R | ToolResult> {
  return async (args) => {
    const { workItemId, ...rest } = args;
    const gid = args.taskGid?.trim() || undefined;
    const wid = workItemId?.trim() || undefined;
    if (gid && wid && gid !== wid) {
      const message = `taskGid（${gid}）與 workItemId（${wid}）同時提供但值不同，請只給其中一個，或讓兩者相同`;
      return { content: [{ type: "text", text: JSON.stringify({ success: false, message }) }], isError: true };
    }
    const id = gid ?? wid;
    const result = await handler((id ? { ...rest, taskGid: id } : rest) as Omit<A, "workItemId">);
    return id ? withWorkItemIdInOutput(result, id) : result;
  };
}
