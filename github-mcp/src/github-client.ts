import { getGithubToken } from "./config-store.js";

const API_BASE = "https://api.github.com";

export interface GithubResult {
  success: boolean;
  data?: unknown;
  message?: string;
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

interface CallResult extends GithubResult {
  /** Raw Link response header, when present — callers doing pagination need this beyond just the parsed body. */
  linkHeader?: string | null;
}

async function call(method: string, pathSuffix: string, body?: unknown): Promise<CallResult> {
  const token = await getGithubToken();
  if (!token) {
    return { success: false, message: "GitHub 尚未設定 Personal Access Token，請先寫入 info/github.json 的 token 欄位" };
  }

  try {
    const res = await fetchWithRetry(`${API_BASE}${pathSuffix}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg = (parsed && (parsed.message as string)) || `GitHub API 回傳 ${res.status}`;
      return { success: false, message: `${msg}（HTTP ${res.status}）` };
    }
    return { success: true, data: parsed, linkHeader: res.headers.get("link") };
  } catch (e) {
    return { success: false, message: `GitHub 請求失敗：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Wraps a paginated list call: flags whether GitHub's Link header advertises a further page, so callers never mistake a truncated single page for the full list. */
async function callList(method: string, pathSuffix: string): Promise<GithubResult> {
  const result = await call(method, pathSuffix);
  if (!result.success) return result;
  const hasMore = !!result.linkHeader && /rel="next"/.test(result.linkHeader);
  return {
    success: true,
    data: {
      items: result.data,
      hasMore,
      ...(hasMore ? { note: "已達單頁上限，GitHub 回報還有更多結果——這份清單不完整，需要的話請提高 perPage 或另外實作分頁" } : {}),
    },
  };
}

export function githubWhoami(): Promise<GithubResult> {
  return call("GET", "/user");
}

export function githubListRepos(visibility?: string, sort?: string, perPage?: number): Promise<GithubResult> {
  const params = new URLSearchParams();
  if (visibility) params.set("visibility", visibility);
  if (sort) params.set("sort", sort);
  params.set("per_page", String(perPage ?? 30));
  return callList("GET", `/user/repos?${params.toString()}`);
}

export function githubCreateRepo(name: string, isPrivate: boolean, description?: string, autoInit?: boolean): Promise<GithubResult> {
  return call("POST", "/user/repos", {
    name,
    private: isPrivate,
    description: description ?? undefined,
    auto_init: autoInit ?? false,
  });
}

export function githubGetRepo(owner: string, repo: string): Promise<GithubResult> {
  return call("GET", `/repos/${owner}/${repo}`);
}

export function githubListIssues(owner: string, repo: string, state?: string): Promise<GithubResult> {
  const params = new URLSearchParams({ state: state ?? "open", per_page: "50" });
  return callList("GET", `/repos/${owner}/${repo}/issues?${params.toString()}`);
}

export function githubCreateIssue(owner: string, repo: string, title: string, body?: string, labels?: string[]): Promise<GithubResult> {
  return call("POST", `/repos/${owner}/${repo}/issues`, { title, body, labels });
}

export function githubGetIssue(owner: string, repo: string, issueNumber: number): Promise<GithubResult> {
  return call("GET", `/repos/${owner}/${repo}/issues/${issueNumber}`);
}

export function githubUpdateIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  fields: { title?: string; body?: string; state?: "open" | "closed" }
): Promise<GithubResult> {
  return call("PATCH", `/repos/${owner}/${repo}/issues/${issueNumber}`, fields);
}

export function githubAddIssueComment(owner: string, repo: string, issueNumber: number, body: string): Promise<GithubResult> {
  return call("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
}

export function githubListPrs(owner: string, repo: string, state?: string): Promise<GithubResult> {
  const params = new URLSearchParams({ state: state ?? "open", per_page: "50" });
  return callList("GET", `/repos/${owner}/${repo}/pulls?${params.toString()}`);
}

export function githubCreatePr(owner: string, repo: string, title: string, head: string, base: string, body?: string): Promise<GithubResult> {
  return call("POST", `/repos/${owner}/${repo}/pulls`, { title, head, base, body });
}

export function githubGetPr(owner: string, repo: string, prNumber: number): Promise<GithubResult> {
  return call("GET", `/repos/${owner}/${repo}/pulls/${prNumber}`);
}

export function githubMergePr(owner: string, repo: string, prNumber: number, mergeMethod?: string): Promise<GithubResult> {
  return call("PUT", `/repos/${owner}/${repo}/pulls/${prNumber}/merge`, { merge_method: mergeMethod ?? "merge" });
}
