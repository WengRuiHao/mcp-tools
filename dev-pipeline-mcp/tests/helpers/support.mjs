// 測試共用工具：暫時目錄、資料目錄隔離、in-memory MCP client。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export function makeTmpDir(prefix = "dpm-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 建立暫時資料目錄並指給 ASANA_PIPELINE_DATA_DIR；回傳 cleanup。 */
export function isolateDataDir() {
  const dir = makeTmpDir("dpm-data-");
  const previous = process.env.ASANA_PIPELINE_DATA_DIR;
  process.env.ASANA_PIPELINE_DATA_DIR = dir;
  return {
    dir,
    cleanup() {
      if (previous === undefined) delete process.env.ASANA_PIPELINE_DATA_DIR;
      else process.env.ASANA_PIPELINE_DATA_DIR = previous;
      removeDir(dir);
    },
  };
}

/** 寫檔（自動建立上層目錄）。 */
export function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return full;
}

/** 以 in-memory transport 連上一個註冊好的 server；register(server) 由呼叫端決定要註冊哪些工具。 */
export async function connectClient(register) {
  const server = new McpServer({ name: "dpm-test", version: "0.0.0" });
  register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "dpm-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** 呼叫工具並解出文字；能解析成 JSON 就一併回傳 json。 */
export async function callTool(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).map((c) => c.text ?? "").join("");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 回應（例如角色說明全文）
  }
  return { isError: res.isError === true, text, json };
}

/** 假的完整 TicketStatus，overrides 淺層覆蓋（summaries/sync 另行深層合併）。 */
export function fakeStatus(overrides = {}) {
  const { summaries, sync, ...rest } = overrides;
  return {
    stage: "new",
    project_dir: null,
    project_name: null,
    name: null,
    last_seen_assignee_gid: null,
    last_seen_completed: false,
    verdict: null,
    sasd_checked: false,
    sasd_info: null,
    history: [],
    content_hash: null,
    last_seen_modified_at: null,
    needs_reanalysis: false,
    human_requested_reanalysis: false,
    summaries: { analysis: null, implementation: null, verification: null, test: null, ...summaries },
    confirmation: null,
    spec_confirmation: null,
    verifier_root_cause: null,
    consecutive_fail_count: 0,
    implementation_manual_actions: [],
    verification_manual_actions: [],
    test_manual_actions: [],
    test_evidence: [],
    test_produces_office_files: null,
    test_level: null,
    sync: {
      analysis_hash: null,
      implementation_hash: null,
      verification_hash: null,
      test_hash: null,
      analysis_hash_at_impl_write: null,
      implementation_hash_at_verify_write: null,
      verification_hash_at_test_write: null,
      ...sync,
    },
    ...rest,
  };
}
