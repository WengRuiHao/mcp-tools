import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gitlabListPipelines, gitlabGetPipeline, gitlabListPipelineJobs } from "./gitlab-client.js";
import { toolResult, projectIdParam, connectionIdParam } from "./shared.js";

const pipelineIdParam = z.number().int().positive().describe("Pipeline 的數字 ID（全域 ID，不是 iid），可從 gitlab_list_pipelines 的結果取得。");

const PIPELINE_STATUS = z
  .enum(["created", "waiting_for_resource", "preparing", "pending", "running", "success", "failed", "canceled", "skipped", "manual", "scheduled"])
  .nullable()
  .optional()
  .describe("依狀態篩選，例如只想看失敗的就傳 failed");

export function registerPipelineTools(server: McpServer): void {
  server.tool(
    "gitlab_list_pipelines",
    "【唯讀】列出專案的 CI/CD pipeline 執行紀錄，依觸發時間新到舊排序。想知道「最近的建置/部署有沒有過」「哪次跑失敗了」從這個開始，找到目標 pipeline 的數字 ID 之後再用 gitlab_get_pipeline 看整體結果、gitlab_list_pipeline_jobs 看是哪個 job/stage 失敗。",
    {
      projectId: projectIdParam,
      connectionId: connectionIdParam,
      ref: z.string().nullable().optional().describe("只看指定分支/tag 觸發的 pipeline"),
      status: PIPELINE_STATUS,
      perPage: z.number().int().positive().max(100).nullable().optional().describe("每頁筆數，預設 20"),
      page: z.number().int().positive().nullable().optional().describe("頁碼，預設 1"),
    },
    async ({ projectId, connectionId, ref, status, perPage, page }) =>
      toolResult(
        await gitlabListPipelines(connectionId ?? undefined, projectId, {
          ref: ref ?? undefined,
          status: status ?? undefined,
          perPage: perPage ?? undefined,
          page: page ?? undefined,
        })
      )
  );

  server.tool(
    "gitlab_get_pipeline",
    "【唯讀】取得單一 pipeline 的整體資訊（狀態、觸發者、耗時、觸發的分支/commit）。只看得到整體狀態，想知道哪個 job 失敗要用 gitlab_list_pipeline_jobs。",
    { projectId: projectIdParam, connectionId: connectionIdParam, pipelineId: pipelineIdParam },
    async ({ projectId, connectionId, pipelineId }) => toolResult(await gitlabGetPipeline(connectionId ?? undefined, projectId, pipelineId))
  );

  server.tool(
    "gitlab_list_pipeline_jobs",
    "【唯讀】列出一個 pipeline 底下每個 job 的狀態（哪個 stage、成功/失敗/跳過）。適合「這次建置是卡在哪一步」這類問題，找到失敗的 job 後可以去 GitLab 網頁看它的完整 log（這個工具本身不含 log 內容）。",
    {
      projectId: projectIdParam,
      connectionId: connectionIdParam,
      pipelineId: pipelineIdParam,
      perPage: z.number().int().positive().max(100).nullable().optional().describe("每頁筆數，預設 50"),
    },
    async ({ projectId, connectionId, pipelineId, perPage }) =>
      toolResult(await gitlabListPipelineJobs(connectionId ?? undefined, projectId, pipelineId, perPage ?? undefined))
  );
}
