import { getGitlabSettings } from "./config-store.js";

export interface GitlabResult {
  success: boolean;
  data?: unknown;
  message?: string;
}

interface CallResult extends GitlabResult {
  /** GitLab's X-Next-Page response header, when present — callers doing pagination need this beyond just the parsed body. */
  nextPage?: string | null;
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

async function call(method: string, pathSuffix: string, body?: unknown): Promise<CallResult> {
  const settings = await getGitlabSettings();
  if (!settings) {
    return { success: false, message: "GitLab 尚未設定 Personal Access Token，請先在 info/gitlab.json 寫入 { token, baseUrl? }" };
  }

  try {
    const res = await fetchWithRetry(`${settings.apiBase}${pathSuffix}`, {
      method,
      headers: {
        "PRIVATE-TOKEN": settings.token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg = (parsed && (parsed.message as string)) || `GitLab API 回傳 ${res.status}`;
      return { success: false, message: `${typeof msg === "string" ? msg : JSON.stringify(msg)}（HTTP ${res.status}）` };
    }
    return { success: true, data: parsed, nextPage: res.headers.get("x-next-page") };
  } catch (e) {
    return { success: false, message: `GitLab 請求失敗：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Wraps a paginated list call: flags whether GitLab's X-Next-Page header advertises a further page, so callers never mistake a truncated single page for the full list. */
async function callList(method: string, pathSuffix: string): Promise<GitlabResult> {
  const result = await call(method, pathSuffix);
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

export function gitlabWhoami(): Promise<GitlabResult> {
  return call("GET", "/user");
}

export function gitlabListProjects(opts: {
  owned?: boolean;
  membership?: boolean;
  search?: string;
  perPage?: number;
  page?: number;
}): Promise<GitlabResult> {
  const params = new URLSearchParams();
  params.set("membership", String(opts.membership ?? true));
  if (opts.owned) params.set("owned", "true");
  if (opts.search) params.set("search", opts.search);
  params.set("per_page", String(opts.perPage ?? 30));
  params.set("page", String(opts.page ?? 1));
  params.set("order_by", "last_activity_at");
  return callList("GET", `/projects?${params.toString()}`);
}

export function gitlabGetProject(projectId: string): Promise<GitlabResult> {
  return call("GET", `/projects/${encodeProjectId(projectId)}`);
}

export function gitlabListBranches(projectId: string, search?: string, perPage?: number): Promise<GitlabResult> {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("per_page", String(perPage ?? 50));
  return callList("GET", `/projects/${encodeProjectId(projectId)}/repository/branches?${params.toString()}`);
}

export function gitlabGetBranch(projectId: string, branch: string): Promise<GitlabResult> {
  return call("GET", `/projects/${encodeProjectId(projectId)}/repository/branches/${encodeURIComponent(branch)}`);
}

export function gitlabListCommits(
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
  return callList("GET", `/projects/${encodeProjectId(projectId)}/repository/commits?${params.toString()}`);
}

export function gitlabGetCommit(projectId: string, sha: string): Promise<GitlabResult> {
  return call("GET", `/projects/${encodeProjectId(projectId)}/repository/commits/${encodeURIComponent(sha)}`);
}

export function gitlabGetCommitDiff(projectId: string, sha: string): Promise<GitlabResult> {
  return callList("GET", `/projects/${encodeProjectId(projectId)}/repository/commits/${encodeURIComponent(sha)}/diff`);
}

export function gitlabCompareBranches(projectId: string, from: string, to: string): Promise<GitlabResult> {
  const params = new URLSearchParams({ from, to });
  return call("GET", `/projects/${encodeProjectId(projectId)}/repository/compare?${params.toString()}`);
}

export function gitlabGetRepositoryTree(
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
  return callList("GET", `/projects/${encodeProjectId(projectId)}/repository/tree?${params.toString()}`);
}

export function gitlabGetFileContents(projectId: string, filePath: string, ref: string): Promise<GitlabResult> {
  const encodedPath = encodeURIComponent(filePath);
  const params = new URLSearchParams({ ref });
  return call("GET", `/projects/${encodeProjectId(projectId)}/repository/files/${encodedPath}?${params.toString()}`);
}
