import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gitlabGetBranch, resolveConnectionId } from "./gitlab-client.js";
import { setBranchRole, removeBranchRole, listBranchRoles, getDeploymentBranches } from "./branch-role-store.js";
import { toolResult, projectIdParam, connectionIdParam, type GitlabResult } from "./shared.js";

const ROLE = z.enum(["personal", "staging", "production"]);

const ROLE_DESCRIPTION =
  "分支用途分類：personal（個人開發/寫文件用，同專案可以有多條，必須搭配 owner）、staging（測試機上版用，同專案限一條，重新標記會自動取代舊的）、production（正式機上版用，同專案限一條，重新標記會自動取代舊的）。";

/** Resolves connectionId once and turns the throw-on-ambiguous/unknown-id behavior into the same {success:false,message} shape every other tool in this MCP returns, instead of each tool re-implementing its own try/catch. */
async function resolveOrError(connectionId: string | null | undefined): Promise<{ id: string } | { error: GitlabResult }> {
  try {
    return { id: await resolveConnectionId(connectionId ?? undefined) };
  } catch (e) {
    return { error: { success: false, message: e instanceof Error ? e.message : String(e) } };
  }
}

export function registerBranchRoleTools(server: McpServer): void {
  server.tool(
    "gitlab_set_branch_role",
    "【本地端標記，非 GitLab 原生功能】把某條分支標記成 personal/staging/production 其中一種用途，之後可以用 gitlab_get_deployment_branches 快速查「正式機/測試機該用哪條分支」，不用每次都問人或用猜的。呼叫前會先真的向 GitLab 確認這條分支存在，不存在會拒絕標記。",
    {
      projectId: projectIdParam,
      connectionId: connectionIdParam,
      branch: z.string().describe("要標記的分支名稱，會先向 GitLab 驗證存在"),
      role: ROLE.describe(ROLE_DESCRIPTION),
      owner: z.string().nullable().optional().describe("這條個人分支屬於誰（帳號名稱），role 為 personal 時必填，其他 role 不需要"),
      note: z.string().nullable().optional().describe("備註，例如用途說明"),
    },
    async ({ projectId, connectionId, branch, role, owner, note }) => {
      if (role === "personal" && !owner) {
        return toolResult({ success: false, message: "role 為 personal 時必須提供 owner（這條分支屬於誰）" });
      }

      const resolved = await resolveOrError(connectionId);
      if ("error" in resolved) return toolResult(resolved.error);

      const branchCheck = await gitlabGetBranch(resolved.id, projectId, branch);
      if (!branchCheck.success) {
        return toolResult({ success: false, message: `無法標記，分支確認失敗：${branchCheck.message}` });
      }

      const result = await setBranchRole({
        connectionId: resolved.id,
        projectId,
        branch,
        role,
        owner: owner ?? undefined,
        note: note ?? undefined,
      });
      return toolResult({ success: true, data: result });
    }
  );

  server.tool(
    "gitlab_get_deployment_branches",
    "【本地端查詢】一次查出某個專案目前標記的 production/staging 分支各是哪一條、personal 分支有哪些人各自在用哪條。適合「正式機該用哪個分支」「測試機上版是哪條」這類問題，比逐一翻 gitlab_list_branches 猜名稱快。查不到不代表分支不存在，只代表還沒被 gitlab_set_branch_role 標記過。",
    { projectId: projectIdParam, connectionId: connectionIdParam },
    async ({ projectId, connectionId }) => {
      const resolved = await resolveOrError(connectionId);
      if ("error" in resolved) return toolResult(resolved.error);

      const data = await getDeploymentBranches(resolved.id, projectId);
      return toolResult({ success: true, data });
    }
  );

  server.tool(
    "gitlab_list_branch_roles",
    "【本地端查詢】列出已標記過用途的分支紀錄，可用 connectionId/projectId/role 篩選；三個都不給就是列出目前所有已標記過的分支（跨專案、跨連線）。想針對單一專案查整理好的結果，用 gitlab_get_deployment_branches 更直接。",
    {
      connectionId: z.string().nullable().optional().describe("只篩選這個連線的 id 或 name（不給就不篩選，列出所有連線底下的紀錄）"),
      projectId: z.string().nullable().optional().describe("只篩選這個專案（不給就不篩選，列出所有專案）"),
      role: ROLE.nullable().optional().describe("只篩選這個分類"),
    },
    async ({ connectionId, projectId, role }) =>
      toolResult({
        success: true,
        data: await listBranchRoles({ connectionId: connectionId ?? undefined, projectId: projectId ?? undefined, role: role ?? undefined }),
      })
  );

  server.tool(
    "gitlab_remove_branch_role",
    "【本地端標記】取消某條分支的用途標記（分支已被刪除、或標錯要重貼時使用）。只移除本地紀錄，不會動到 GitLab 上真正的分支。",
    { projectId: projectIdParam, connectionId: connectionIdParam, branch: z.string().describe("要取消標記的分支名稱") },
    async ({ projectId, connectionId, branch }) => {
      const resolved = await resolveOrError(connectionId);
      if ("error" in resolved) return toolResult(resolved.error);

      const removed = await removeBranchRole(resolved.id, projectId, branch);
      if (!removed) {
        return toolResult({ success: false, message: `找不到「${branch}」的標記紀錄` });
      }
      return toolResult({ success: true, data: removed });
    }
  );
}
