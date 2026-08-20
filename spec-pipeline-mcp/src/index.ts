#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { stat } from "node:fs/promises";
import {
  getGitTopLevel,
  getRecentCommits,
  isGitRepoRoot,
  isFileTracked,
} from "./git.js";
import { lookupGitDir, registerGitDir, listRegisteredMappings } from "./config-store.js";
import { getRolePrompt } from "./prompts.js";

const server = new McpServer({
  name: "spec-pipeline-mcp",
  version: "0.1.0",
});

function invalidGitDirResult(absGitDir: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: `提供的目錄不是有效的 git 版控目錄: ${absGitDir}` }),
      },
    ],
    isError: true,
  };
}

server.tool(
  "load_spec",
  "判斷規格檔案類型（.docx / .md），並針對 .md 檔案解析對應的 git 版控目錄狀態。" +
    "docx 類型不需要版控檢查，md 類型會回報是否已被 git 追蹤，" +
    "若未追蹤則檢查是否已登記對應的版控目錄，都沒有的話回報需要詢問使用者。",
  {
    specPath: z.string().describe("規格檔案的絕對或相對路徑"),
  },
  async ({ specPath }) => {
    const absPath = path.resolve(specPath);
    const ext = path.extname(absPath).toLowerCase();

    try {
      await stat(absPath);
    } catch {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `找不到檔案: ${absPath}` }),
          },
        ],
        isError: true,
      };
    }

    if (ext === ".docx") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              fileType: "docx",
              specPath: absPath,
              needsGitCheck: false,
              instruction:
                "請先使用 word 轉 md 的工具（markitdown）將此檔案轉換為 Markdown 內容，" +
                "轉換完成後不需要執行 git 版控檢查，直接將內容交給分析師角色繼續後續流程。",
            }),
          },
        ],
      };
    }

    if (ext !== ".md" && ext !== ".markdown") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `不支援的檔案類型: ${ext}，僅支援 .docx 與 .md`,
            }),
          },
        ],
        isError: true,
      };
    }

    const specDir = path.dirname(absPath);
    let tracked: boolean;
    try {
      tracked = await isFileTracked(absPath);
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `檢查 git 追蹤狀態失敗: ${err.message}` }),
          },
        ],
        isError: true,
      };
    }

    if (tracked) {
      const gitDir = await getGitTopLevel(specDir);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              fileType: "md",
              specPath: absPath,
              needsGitCheck: true,
              gitTracked: true,
              gitDir,
              instruction: "此規格目錄已被 git 追蹤，可直接呼叫 get_recent_commits 取得最新 commit 記錄。",
            }),
          },
        ],
      };
    }

    const registeredGitDir = await lookupGitDir(specDir);
    if (registeredGitDir) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              fileType: "md",
              specPath: absPath,
              needsGitCheck: true,
              gitTracked: false,
              registeredGitDir,
              instruction: "此規格目錄本身未被 git 追蹤，但已登記對應的版控目錄，可用 registeredGitDir 呼叫 get_recent_commits。",
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            fileType: "md",
            specPath: absPath,
            specDir,
            needsGitCheck: true,
            gitTracked: false,
            registeredGitDir: null,
            needsUserInput: true,
            instruction:
              "此規格目錄未被 git 追蹤，也尚未登記對應的版控目錄。" +
              "請詢問使用者這份規格對應的 git 版控目錄在哪裡，取得回答後呼叫 register_git_dir 登記。",
          }),
        },
      ],
    };
  }
);

server.tool(
  "register_git_dir",
  "將使用者提供的 git 版控目錄，登記為某個規格目錄的對應關係，之後同目錄的規格就不用再詢問一次。",
  {
    specDir: z.string().describe("規格檔案所在的目錄"),
    gitDir: z.string().describe("使用者提供的 git 版控目錄"),
  },
  async ({ specDir, gitDir }) => {
    const absGitDir = path.resolve(gitDir);
    const valid = await isGitRepoRoot(absGitDir);

    if (!valid) {
      return invalidGitDirResult(absGitDir);
    }

    await registerGitDir(specDir, absGitDir);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            registered: true,
            specDir: path.resolve(specDir),
            gitDir: absGitDir,
          }),
        },
      ],
    };
  }
);

server.tool(
  "get_recent_commits",
  "查詢指定 git 版控目錄的最新 commit 記錄，供分析師角色判讀最新程式碼變更。",
  {
    gitDir: z.string().describe("git 版控目錄"),
    limit: z.number().int().positive().max(100).default(10).describe("要抓取的 commit 數量，預設 10"),
  },
  async ({ gitDir, limit }) => {
    const absGitDir = path.resolve(gitDir);
    const valid = await isGitRepoRoot(absGitDir);

    if (!valid) {
      return invalidGitDirResult(absGitDir);
    }

    try {
      const commits = await getRecentCommits(absGitDir, limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ gitDir: absGitDir, commits }),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `讀取 commit 記錄失敗: ${err.message}` }),
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "list_registered_git_dirs",
  "列出目前已登記的「規格目錄 -> git 版控目錄」對應關係，方便除錯或確認設定。",
  {},
  async () => {
    const mappings = await listRegisteredMappings();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ mappings }),
        },
      ],
    };
  }
);

server.tool(
  "get_role_prompt",
  "取得「分析師」／「工程師」／「驗證師」角色的完整說明（任務內容、硬性規則、輸出格式）。" +
    "這個 MCP 本身不跑 LLM、不替你分析或寫程式碼，這三個角色都是由呼叫端的 AI 自己扮演——" +
    "這個工具只負責提供固定的角色說明文字，讓任何連上這個 MCP 的 AI host 都能拿到同一套流程定義，不用各自維護一份可能兜不起來的版本。",
  {
    role: z.enum(["analyst", "engineer", "verifier"]).describe(
      "analyst：對照規格判斷需求實作程度；engineer：依分析結論實際修改程式碼；verifier：核對修改是否真的符合規格需求"
    ),
  },
  async ({ role }) => {
    return {
      content: [
        {
          type: "text",
          text: getRolePrompt(role),
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("spec-pipeline-mcp failed to start:", err);
  process.exit(1);
});
