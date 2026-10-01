import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolveProjectDir } from "./project-rule-files.js";
import { isRuleFilePath, isValidSnapshotName, listSnapshots, listTrackedFiles, readSnapshot, snapshotIfChanged } from "./rule-history.js";
import { textResult } from "./shared.js";

const TARGET_PARAMS = {
  projectDir: z.string().nullable().optional().describe("專案目錄絕對路徑"),
  taskGid: z.string().nullable().optional().describe("沒帶 projectDir 時，用這張票記錄的 project_dir 反查"),
};

export function registerRuleHistoryTools(server: McpServer): void {
  server.tool(
    "list_rule_history",
    "列出專案規則檔（<projectDir>/.pipeline/ 底下）的歷史快照。快照在 MCP 讀取規則檔、內容有變時自動存進 <projectDir>/.pipeline/.history/，每個檔案保留最近 10 份。不帶 file 列出有快照的檔案，帶 file（例如 .pipeline/roles/engineer.md）列出該檔案的快照，由新到舊。",
    { ...TARGET_PARAMS, file: z.string().nullable().optional().describe("規則檔相對路徑，例如 .pipeline/roles/engineer.md") },
    async ({ projectDir, taskGid, file }) => {
      const dir = await resolveProjectDir(projectDir, taskGid);
      if (!dir) return textResult({ success: false, message: "請帶 projectDir，或帶已經處理過的 taskGid。" }, true);
      if (!file) return textResult({ success: true, files: await listTrackedFiles(dir) });
      if (!isRuleFilePath(file)) return textResult({ success: false, message: "file 必須是 .pipeline/ 底下的規則檔路徑。" }, true);
      return textResult({ success: true, file, snapshots: await listSnapshots(dir, file) });
    }
  );

  server.tool(
    "restore_rule_file",
    "把規則檔還原成某個歷史快照（snapshot 取自 list_rule_history）。還原前會先把目前內容存成一份快照，所以這個動作本身也能還原回去。",
    {
      ...TARGET_PARAMS,
      file: z.string().describe("規則檔相對路徑，例如 .pipeline/roles/engineer.md"),
      snapshot: z.string().describe("快照檔名，例如 20261001-101500-123.md"),
    },
    async ({ projectDir, taskGid, file, snapshot }) => {
      const dir = await resolveProjectDir(projectDir, taskGid);
      if (!dir) return textResult({ success: false, message: "請帶 projectDir，或帶已經處理過的 taskGid。" }, true);
      if (!isRuleFilePath(file)) return textResult({ success: false, message: "file 必須是 .pipeline/ 底下的規則檔路徑。" }, true);
      if (!isValidSnapshotName(snapshot)) return textResult({ success: false, message: "snapshot 檔名格式不正確，請用 list_rule_history 回傳的 name。" }, true);

      const root = path.resolve(dir);
      const target = path.resolve(root, file);
      if (!target.startsWith(root + path.sep)) return textResult({ success: false, message: "路徑超出專案目錄範圍，已拒絕。" }, true);

      let restored: string;
      try {
        restored = await readSnapshot(dir, file, snapshot);
      } catch {
        return textResult({ success: false, message: `找不到快照 ${snapshot}。` }, true);
      }
      try {
        await snapshotIfChanged(dir, file, await readFile(target, "utf-8"));
      } catch {
        // current file missing: nothing to preserve
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, restored, "utf-8");
      return textResult({ success: true, file, restoredFrom: snapshot });
    }
  );
}
