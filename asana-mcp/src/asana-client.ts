import { getAsanaToken } from "./config-store.js";

const ASANA_API_BASE = "https://app.asana.com/api/1.0";
const MAX_PAGES = 20;
const BOARD_CACHE_TTL_MS = 5 * 60 * 1000;

export interface AsanaResult {
  success: boolean;
  data?: unknown;
  message?: string;
}

interface RawPageResult {
  data?: unknown;
  next_page?: { uri?: string } | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One retry for transient failures (429 rate limit, 5xx) — waits Retry-After if given, else 1s. Not a general backoff strategy, just the gap between "one blip kills the whole pipeline" and "no retry at all". */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 429 && res.status < 500) return res;

  const retryAfterHeader = res.headers.get("retry-after");
  const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 1000;
  await sleep(Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 1000);
  return fetch(url, init);
}

/** 呼叫 Asana API，回傳包含 success/data 的標準結構。全程只用 GET，不做任何寫入呼叫。 */
export async function asanaGet(pathSuffix: string): Promise<AsanaResult> {
  const token = await getAsanaToken();
  if (!token) {
    return { success: false, message: "Asana 尚未設定 Token，請先在 claudeWeb 網頁的串接設定填入共用帳號 Token" };
  }

  const url = pathSuffix.startsWith("http") ? pathSuffix : ASANA_API_BASE + pathSuffix;
  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    const body = await res.text();
    if (!res.ok) {
      return { success: false, message: `Asana API 回傳 ${res.status}：${body.slice(0, 200)}` };
    }
    const parsed = JSON.parse(body) as { data?: unknown };
    return { success: true, data: parsed.data };
  } catch (e) {
    return { success: false, message: `Asana 請求失敗：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 呼叫 Asana API 並回傳原始 JSON（含 next_page），供分頁用。 */
async function asanaGetRaw(pathSuffix: string): Promise<RawPageResult | null> {
  const token = await getAsanaToken();
  if (!token) return null;

  const url = pathSuffix.startsWith("http") ? pathSuffix : ASANA_API_BASE + pathSuffix;
  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as RawPageResult;
  } catch {
    return null;
  }
}

interface PagedResult {
  items: unknown[];
  /** true when the list is NOT guaranteed complete — either a page request failed mid-walk, or MAX_PAGES was hit while Asana still reported a next_page. Callers must surface this, not silently treat items as the full list. */
  truncated: boolean;
  truncationReason?: "fetch_failed" | "max_pages_reached";
}

/** Asana 分頁遍歷，取得所有資料（自動 follow next_page），安全上限 20 頁。區分「正常翻完」跟「中途失敗/達上限」，不讓呼叫端把截斷清單誤判成全貌。 */
async function asanaGetAllPages(initialPath: string): Promise<PagedResult> {
  const all: unknown[] = [];
  let pathSuffix: string | null = initialPath;

  for (let page = 0; page < MAX_PAGES && pathSuffix; page++) {
    const res = await asanaGetRaw(pathSuffix);
    if (!res) {
      return { items: all, truncated: true, truncationReason: "fetch_failed" };
    }
    if (Array.isArray(res.data)) all.push(...res.data);

    pathSuffix = null;
    const uri = res.next_page?.uri;
    if (uri) pathSuffix = uri;
  }

  if (pathSuffix) {
    // Loop only exits with pathSuffix still set when MAX_PAGES was hit but Asana reported more.
    return { items: all, truncated: true, truncationReason: "max_pages_reached" };
  }
  return { items: all, truncated: false };
}

export async function asanaWorkspaces(): Promise<AsanaResult> {
  return asanaGet("/workspaces?opt_fields=name,gid");
}

/** 這組共用帳號 token 對應的 Asana 使用者身份（gid/name/email）。用來判斷「指派人是不是這個 pipeline 帳號本人」這類條件，不用靠使用者自己貼 gid。 */
export async function asanaMe(): Promise<AsanaResult> {
  return asanaGet("/users/me?opt_fields=gid,name,email");
}

export async function asanaProjects(workspaceGid: string): Promise<AsanaResult> {
  return asanaGet(
    `/workspaces/${workspaceGid}/projects?limit=100&opt_fields=name,gid,archived,created_at&archived=false`
  );
}

const SUBTASK_FIELDS =
  "name,gid,completed,assignee.name,due_on,num_subtasks";

/** 單一任務完整詳情（含描述 notes、自訂欄位、子任務清單——board 資料裡沒有這些）。 */
export async function asanaTask(taskGid: string): Promise<AsanaResult> {
  const taskFields =
    "name,notes,completed,assignee.name,assignee.gid,due_on,num_subtasks,memberships.section.name,modified_at," +
    "custom_fields.name,custom_fields.display_value,custom_fields.type,parent.gid,parent.name";

  const [taskRes, subtasksResult] = await Promise.all([
    asanaGet(`/tasks/${taskGid}?opt_fields=${taskFields}`),
    asanaGetAllPages(`/tasks/${taskGid}/subtasks?limit=100&opt_fields=${SUBTASK_FIELDS}`),
  ]);

  if (!taskRes.success) return taskRes;

  return {
    success: true,
    data: {
      ...(taskRes.data as Record<string, unknown>),
      subtasks: subtasksResult.items,
      ...(subtasksResult.truncated
        ? { subtasksTruncated: true, subtasksTruncationReason: subtasksResult.truncationReason }
        : {}),
    },
  };
}

/** 任務的完整活動流／留言。resource_subtype="comment_added" 為使用者留言，其餘為系統事件（狀態變更等）。 */
export async function asanaTaskComments(taskGid: string): Promise<AsanaResult> {
  return asanaGet(
    `/tasks/${taskGid}/stories?opt_fields=text,created_at,created_by.name,type,resource_subtype`
  );
}

/** 列出任務底下的所有附件（檔名、類型、大小、下載連結）。download_url 是短效簽章連結，要下載請盡快呼叫 asanaDownloadAttachment。 */
export async function asanaAttachments(taskGid: string): Promise<AsanaResult> {
  const fields = "name,resource_type,host,download_url,view_url,size,created_at";
  const result = await asanaGetAllPages(`/tasks/${taskGid}/attachments?limit=100&opt_fields=${fields}`);
  return {
    success: true,
    data: {
      items: result.items,
      ...(result.truncated ? { truncated: true, truncationReason: result.truncationReason } : {}),
    },
  };
}

interface StoryItem {
  gid?: string;
  text?: string;
  created_at?: string;
  created_by?: { name?: string };
  resource_subtype?: string;
}
interface AttachmentItem {
  gid?: string;
  name?: string;
  size?: number;
  created_at?: string;
}

/**
 * 把任務的活動流（stories：留言＋系統事件）跟附件清單合併成一份依時間排序的時間軸，解決「留言說有附檔，
 * 但要另外呼叫 asana_attachments 自己對時間、猜哪個附件對應哪句留言」的麻煩。
 * 每個附件項目仍然只有 metadata（沒有內容），真要讀取內容要另外呼叫 asana_download_attachment 帶這裡回傳的
 * attachmentGid——這裡故意不順便下載，避免一次呼叫又要打通常用不到的檔案下載流量。
 */
export async function asanaTaskActivity(taskGid: string): Promise<AsanaResult> {
  const [storiesRes, attachmentsResult] = await Promise.all([
    asanaGet(`/tasks/${taskGid}/stories?opt_fields=text,created_at,created_by.name,type,resource_subtype`),
    asanaGetAllPages(
      `/tasks/${taskGid}/attachments?limit=100&opt_fields=name,resource_type,host,size,created_at`
    ),
  ]);
  if (!storiesRes.success) return storiesRes;

  const stories = (Array.isArray(storiesRes.data) ? storiesRes.data : []) as StoryItem[];
  const attachments = attachmentsResult.items as AttachmentItem[];

  const timeline = [
    ...stories.map((s) => ({
      at: s.created_at ?? null,
      kind: s.resource_subtype === "comment_added" ? ("comment" as const) : ("system_event" as const),
      resource_subtype: s.resource_subtype ?? null,
      author: s.created_by?.name ?? null,
      text: s.text ?? null,
    })),
    ...attachments.map((a) => ({
      at: a.created_at ?? null,
      kind: "attachment" as const,
      attachmentGid: a.gid ?? null,
      name: a.name ?? null,
      size: a.size ?? null,
    })),
  ].sort((x, y) => (x.at ?? "").localeCompare(y.at ?? ""));

  return {
    success: true,
    data: {
      items: timeline,
      message:
        "kind=\"comment\" 是使用者留言，\"system_event\" 是狀態變更等系統事件，\"attachment\" 是這個時間點上傳的附件（只有 metadata，要讀內容請帶 attachmentGid 呼叫 asana_download_attachment）。已依 at 時間排序，可以直接看最後幾筆判斷最新進度。",
      ...(attachmentsResult.truncated
        ? { attachmentsTruncated: true, attachmentsTruncationReason: attachmentsResult.truncationReason }
        : {}),
    },
  };
}

export interface DownloadedAttachment {
  name: string;
  ext: string;
  size: number;
  tempFilePath: string;
}

/** 下載單一附件到本機暫存檔（不管文字或二進位格式一律寫檔，交給呼叫端用專案既有的檔案讀取流程處理，例如 docx 用 python-docx）。attachmentGid 來自 asanaAttachments 回傳的 gid。 */
export async function asanaDownloadAttachment(attachmentGid: string): Promise<AsanaResult> {
  const token = await getAsanaToken();
  if (!token) {
    return { success: false, message: "Asana 尚未設定 Token，請先在 claudeWeb 網頁的串接設定填入共用帳號 Token" };
  }

  // 附件的 download_url 是短效簽章連結，先重新查詢一次拿到還沒過期的連結。
  const metaRes = await asanaGet(`/attachments/${attachmentGid}?opt_fields=name,download_url,resource_type,size`);
  if (!metaRes.success) return metaRes;
  const meta = metaRes.data as { name?: string; download_url?: string; size?: number };
  if (!meta.download_url) {
    return { success: false, message: `附件 ${attachmentGid} 沒有可下載的 download_url（可能是外部連結型附件，非上傳檔案）。` };
  }

  try {
    const fileRes = await fetch(meta.download_url);
    if (!fileRes.ok) {
      return { success: false, message: `下載附件失敗，HTTP ${fileRes.status}` };
    }
    const buffer = Buffer.from(await fileRes.arrayBuffer());

    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const name = meta.name || `attachment-${attachmentGid}`;
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "asana-mcp-"));
    const tmpPath = path.join(tmpDir, name);
    await writeFile(tmpPath, buffer);

    const result: DownloadedAttachment = { name, ext, size: buffer.length, tempFilePath: tmpPath };
    return {
      success: true,
      data: {
        ...result,
        message: "已下載到本機暫存檔，請用專案既有的檔案讀取流程處理這個路徑（例如 docx 用 CLAUDE.md 裡的 python-docx 讀取流程），讀完記得清掉暫存目錄。",
      },
    };
  } catch (e) {
    return { success: false, message: `下載附件失敗：${e instanceof Error ? e.message : String(e)}` };
  }
}

interface BoardData {
  success: true;
  project: unknown;
  sections: unknown[];
  tasks: unknown[];
  totalTasks: number;
  loadTimeMs: number;
  fromCache: boolean;
  tasksTruncated?: boolean;
  tasksTruncationReason?: "fetch_failed" | "max_pages_reached";
}
interface BoardCacheEntry {
  data: BoardData;
  time: number;
}
const boardCache = new Map<string, BoardCacheEntry>();

/** 專案完整看板資料：並行拉「專案資訊 + 區段 + 全部任務」，5 分鐘 TTL 記憶體快取。回傳結構為扁平（success/project/sections/tasks 同層），無論命中快取與否皆一致。 */
export async function asanaBoard(projectGid: string, refresh: boolean): Promise<AsanaResult | BoardData> {
  if (!refresh) {
    const cached = boardCache.get(projectGid);
    if (cached && Date.now() - cached.time < BOARD_CACHE_TTL_MS) {
      return { ...cached.data, fromCache: true };
    }
  }

  const taskFields =
    "name,gid,completed,due_on,assignee.name,assignee.gid,memberships.section.gid,memberships.section.name,modified_at," +
    "custom_fields.name,custom_fields.display_value,custom_fields.type,num_subtasks,percent_complete";

  const start = Date.now();
  try {
    const [projRes, secRes, tasksResult] = await Promise.all([
      asanaGet(
        `/projects/${projectGid}?opt_fields=name,gid,members.name,members.gid,custom_field_settings.custom_field.name,custom_field_settings.custom_field.gid`
      ),
      asanaGet(`/projects/${projectGid}/sections?opt_fields=name,gid`),
      asanaGetAllPages(`/projects/${projectGid}/tasks?limit=100&opt_fields=${taskFields}`),
    ]);

    if (!projRes.success) return projRes;

    const sections = secRes.success && Array.isArray(secRes.data) ? secRes.data : [];
    const allTasks = tasksResult.items;

    const result: BoardData = {
      success: true,
      project: projRes.data,
      sections,
      tasks: allTasks,
      totalTasks: allTasks.length,
      loadTimeMs: Date.now() - start,
      fromCache: false,
      ...(tasksResult.truncated ? { tasksTruncated: true, tasksTruncationReason: tasksResult.truncationReason } : {}),
    };

    boardCache.set(projectGid, { data: result, time: Date.now() });
    return result;
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : String(e) };
  }
}
