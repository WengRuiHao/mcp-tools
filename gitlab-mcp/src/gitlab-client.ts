import { readFile } from "node:fs/promises";
import { getConnectionsFilePath, getDefaultConnectionId } from "./config-store.js";

export interface GitlabResult {
  success: boolean;
  data?: unknown;
  message?: string;
}

interface CallResult extends GitlabResult {
  /** GitLab's X-Next-Page response header, when present — callers doing pagination need this beyond just the parsed body. */
  nextPage?: string | null;
}

interface GitlabConnection {
  id: string;
  name: string;
  token: string;
  baseUrl: string;
}

/** No hardcoded fallback host on purpose — this is an open-source-able repo, so it must not bake in
 * any particular company's internal GitLab domain. Every connection has to name its own baseUrl. */
async function loadConnections(): Promise<GitlabConnection[]> {
  const raw = await readFile(getConnectionsFilePath(), "utf-8");
  const parsed = JSON.parse(raw) as GitlabConnection[];
  return parsed.map((c) => {
    if (!c.baseUrl || !c.baseUrl.trim()) {
      throw new Error(`連線「${c.name || c.id}」缺少 baseUrl，這一項為必填，不會使用任何預設站台`);
    }
    return { ...c, baseUrl: c.baseUrl.trim().replace(/\/+$/, "") };
  });
}

/** Lists connections with tokens stripped — safe to hand back to whatever's driving this MCP. */
export async function listConnections(): Promise<GitlabResult> {
  try {
    const conns = await loadConnections();
    return { success: true, data: conns.map((c) => ({ id: c.id, name: c.name, baseUrl: c.baseUrl })) };
  } catch (e) {
    return {
      success: false,
      message: `讀取 GitLab 連線清單失敗（${getConnectionsFilePath()}）：${e instanceof Error ? e.message : String(e)}。請先建立這個檔案，格式為 [{ "id": "...", "name": "...", "token": "...", "baseUrl": "..." }, ...]`,
    };
  }
}

/** Exposes just the resolved connection's id (never the token) — for callers like branch-role tools that need to know which connection a project/branch belongs to without making a GitLab API call themselves. */
export async function resolveConnectionId(connectionId?: string): Promise<string> {
  const conn = await resolveConnection(connectionId);
  return conn.id;
}

async function resolveConnection(connectionId?: string): Promise<GitlabConnection> {
  const target = connectionId?.trim() || getDefaultConnectionId();
  const conns = await loadConnections();
  if (!target) {
    if (conns.length === 1) return conns[0];
    throw new Error(
      `沒有指定 connectionId，也沒有設定 GITLAB_CONNECTION_ID 環境變數。可用的連線：${conns.map((c) => c.name).join("、") || "(無，請先建立 info/gitlab-connections.json)"}`
    );
  }
  const conn = conns.find((c) => c.id === target || c.name === target);
  if (!conn) {
    throw new Error(`找不到 GitLab 連線「${target}」。可用的連線：${conns.map((c) => c.name).join("、") || "(無)"}`);
  }
  return conn;
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

/** GitLab accepts either the numeric project id or the URL-encoded `namespace/path`. A bare numeric string is passed through; anything else is percent-encoded as GitLab's API requires. */
export function encodeProjectId(id: string): string {
  return /^\d+$/.test(id) ? id : encodeURIComponent(id);
}

/** Turns a bare HTTP status into an actionable next-step hint for whichever caller (human or AI) is reading the error message — GitLab's own error bodies rarely explain what to actually do about it. */
function errorHint(status: number): string {
  if (status === 404) {
    return "（找不到——常見原因是 projectId 格式錯誤、connectionId 接錯站台，或 MR/Issue/Pipeline 用了全域 ID 而不是專案內編號 iid；建議先用 gitlab_list_projects/gitlab_list_merge_requests/gitlab_list_issues 這類列表工具查出正確值，不要用猜的）";
  }
  if (status === 401 || status === 403) {
    return "（權限不足——請確認 gitlab_list_connections 裡這個連線的 token 還沒過期、scope 至少要有 read_api，且這個帳號本人在 GitLab 上真的有權限存取此專案）";
  }
  return "";
}

async function call(connectionId: string | undefined, method: string, pathSuffix: string, body?: unknown): Promise<CallResult> {
  let conn: GitlabConnection;
  try {
    conn = await resolveConnection(connectionId);
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : String(e) };
  }

  try {
    const res = await fetchWithRetry(`${conn.baseUrl}/api/v4${pathSuffix}`, {
      method,
      headers: {
        "PRIVATE-TOKEN": conn.token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg = (parsed && (parsed.message as string)) || `GitLab API 回傳 ${res.status}`;
      const hint = errorHint(res.status);
      return {
        success: false,
        message: `[${conn.name}] ${typeof msg === "string" ? msg : JSON.stringify(msg)}（HTTP ${res.status}）${hint}`,
      };
    }
    return { success: true, data: parsed, nextPage: res.headers.get("x-next-page") };
  } catch (e) {
    return { success: false, message: `[${conn.name}] GitLab 請求失敗：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Wraps a paginated list call: flags whether GitLab's X-Next-Page header advertises a further page, so callers never mistake a truncated single page for the full list. */
async function callList(connectionId: string | undefined, method: string, pathSuffix: string): Promise<GitlabResult> {
  const result = await call(connectionId, method, pathSuffix);
  if (!result.success) return result;
  const hasMore = !!result.nextPage;
  return {
    success: true,
    data: {
      items: result.data,
      hasMore,
      ...(hasMore ? { note: `已達單頁上限，GitLab 回報下一頁是第 ${result.nextPage} 頁——這份清單不完整，需要的話請提高 perPage 或加 page 參數翻頁` } : {}),
    },
  };
}

export function gitlabWhoami(connectionId?: string): Promise<GitlabResult> {
  return call(connectionId, "GET", "/user");
}

export function gitlabListProjects(
  connectionId: string | undefined,
  opts: {
    owned?: boolean;
    membership?: boolean;
    search?: string;
    perPage?: number;
    page?: number;
  }
): Promise<GitlabResult> {
  const params = new URLSearchParams();
  params.set("membership", String(opts.membership ?? true));
  if (opts.owned) params.set("owned", "true");
  if (opts.search) params.set("search", opts.search);
  params.set("per_page", String(opts.perPage ?? 30));
  params.set("page", String(opts.page ?? 1));
  params.set("order_by", "last_activity_at");
  return callList(connectionId, "GET", `/projects?${params.toString()}`);
}

export function gitlabGetProject(connectionId: string | undefined, projectId: string): Promise<GitlabResult> {
  return call(connectionId, "GET", `/projects/${encodeProjectId(projectId)}`);
}

export function gitlabListBranches(connectionId: string | undefined, projectId: string, search?: string, perPage?: number): Promise<GitlabResult> {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("per_page", String(perPage ?? 50));
  return callList(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/repository/branches?${params.toString()}`);
}

export function gitlabGetBranch(connectionId: string | undefined, projectId: string, branch: string): Promise<GitlabResult> {
  return call(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/repository/branches/${encodeURIComponent(branch)}`);
}

export function gitlabListCommits(
  connectionId: string | undefined,
  projectId: string,
  refName?: string,
  filePath?: string,
  perPage?: number,
  page?: number
): Promise<GitlabResult> {
  const params = new URLSearchParams();
  if (refName) params.set("ref_name", refName);
  if (filePath) params.set("path", filePath);
  params.set("per_page", String(perPage ?? 30));
  params.set("page", String(page ?? 1));
  return callList(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/repository/commits?${params.toString()}`);
}

export function gitlabGetCommit(connectionId: string | undefined, projectId: string, sha: string): Promise<GitlabResult> {
  return call(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/repository/commits/${encodeURIComponent(sha)}`);
}

export function gitlabGetCommitDiff(connectionId: string | undefined, projectId: string, sha: string): Promise<GitlabResult> {
  return callList(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/repository/commits/${encodeURIComponent(sha)}/diff`);
}

export function gitlabCompareBranches(connectionId: string | undefined, projectId: string, from: string, to: string): Promise<GitlabResult> {
  const params = new URLSearchParams({ from, to });
  return call(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/repository/compare?${params.toString()}`);
}

export function gitlabGetRepositoryTree(
  connectionId: string | undefined,
  projectId: string,
  ref?: string,
  path?: string,
  recursive?: boolean,
  perPage?: number
): Promise<GitlabResult> {
  const params = new URLSearchParams();
  if (ref) params.set("ref", ref);
  if (path) params.set("path", path);
  if (recursive) params.set("recursive", "true");
  params.set("per_page", String(perPage ?? 100));
  return callList(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/repository/tree?${params.toString()}`);
}

export function gitlabGetFileContents(connectionId: string | undefined, projectId: string, filePath: string, ref: string): Promise<GitlabResult> {
  const encodedPath = encodeURIComponent(filePath);
  const params = new URLSearchParams({ ref });
  return call(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/repository/files/${encodedPath}?${params.toString()}`);
}

/** GitLab's per-project code search (scope=blobs) works without Elasticsearch — unlike global/group search, it's backed by a plain grep over that one project, so it's always available. */
export function gitlabSearchCode(connectionId: string | undefined, projectId: string, search: string, ref?: string, perPage?: number): Promise<GitlabResult> {
  const params = new URLSearchParams({ scope: "blobs", search });
  if (ref) params.set("ref", ref);
  params.set("per_page", String(perPage ?? 20));
  return callList(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/search?${params.toString()}`);
}

export function gitlabListMergeRequests(
  connectionId: string | undefined,
  projectId: string,
  opts: {
    state?: "opened" | "closed" | "merged" | "all";
    targetBranch?: string;
    sourceBranch?: string;
    search?: string;
    perPage?: number;
    page?: number;
  }
): Promise<GitlabResult> {
  const params = new URLSearchParams();
  params.set("state", opts.state ?? "opened");
  if (opts.targetBranch) params.set("target_branch", opts.targetBranch);
  if (opts.sourceBranch) params.set("source_branch", opts.sourceBranch);
  if (opts.search) params.set("search", opts.search);
  params.set("order_by", "updated_at");
  params.set("per_page", String(opts.perPage ?? 30));
  params.set("page", String(opts.page ?? 1));
  return callList(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/merge_requests?${params.toString()}`);
}

export function gitlabGetMergeRequest(connectionId: string | undefined, projectId: string, mrIid: number): Promise<GitlabResult> {
  return call(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/merge_requests/${mrIid}`);
}

/** "changes" is GitLab's endpoint name for an MR's file diffs — kept as get_merge_request_changes to match GitLab's own terminology instead of inventing a different name for the same thing. */
export function gitlabGetMergeRequestChanges(connectionId: string | undefined, projectId: string, mrIid: number): Promise<GitlabResult> {
  return call(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/merge_requests/${mrIid}/changes`);
}

export function gitlabListMergeRequestDiscussions(
  connectionId: string | undefined,
  projectId: string,
  mrIid: number,
  perPage?: number,
  page?: number
): Promise<GitlabResult> {
  const params = new URLSearchParams();
  params.set("per_page", String(perPage ?? 20));
  params.set("page", String(page ?? 1));
  return callList(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/merge_requests/${mrIid}/discussions?${params.toString()}`);
}

export function gitlabListIssues(
  connectionId: string | undefined,
  projectId: string,
  opts: { state?: "opened" | "closed" | "all"; search?: string; labels?: string; perPage?: number; page?: number }
): Promise<GitlabResult> {
  const params = new URLSearchParams();
  params.set("state", opts.state ?? "opened");
  if (opts.search) params.set("search", opts.search);
  if (opts.labels) params.set("labels", opts.labels);
  params.set("order_by", "updated_at");
  params.set("per_page", String(opts.perPage ?? 30));
  params.set("page", String(opts.page ?? 1));
  return callList(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/issues?${params.toString()}`);
}

export function gitlabGetIssue(connectionId: string | undefined, projectId: string, issueIid: number): Promise<GitlabResult> {
  return call(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/issues/${issueIid}`);
}

export function gitlabListPipelines(
  connectionId: string | undefined,
  projectId: string,
  opts: {
    ref?: string;
    status?: "created" | "waiting_for_resource" | "preparing" | "pending" | "running" | "success" | "failed" | "canceled" | "skipped" | "manual" | "scheduled";
    perPage?: number;
    page?: number;
  }
): Promise<GitlabResult> {
  const params = new URLSearchParams();
  if (opts.ref) params.set("ref", opts.ref);
  if (opts.status) params.set("status", opts.status);
  params.set("order_by", "id");
  params.set("sort", "desc");
  params.set("per_page", String(opts.perPage ?? 20));
  params.set("page", String(opts.page ?? 1));
  return callList(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/pipelines?${params.toString()}`);
}

export function gitlabGetPipeline(connectionId: string | undefined, projectId: string, pipelineId: number): Promise<GitlabResult> {
  return call(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/pipelines/${pipelineId}`);
}

/** Per-job status/stage within one pipeline run — this is what actually answers "which stage failed", since the pipeline object itself only has one overall status. */
export function gitlabListPipelineJobs(connectionId: string | undefined, projectId: string, pipelineId: number, perPage?: number): Promise<GitlabResult> {
  const params = new URLSearchParams();
  params.set("per_page", String(perPage ?? 50));
  return callList(connectionId, "GET", `/projects/${encodeProjectId(projectId)}/pipelines/${pipelineId}/jobs?${params.toString()}`);
}
