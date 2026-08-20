import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getAsanaMcpEntrypoint, getSpecPipelineMcpEntrypoint, getSvnMcpEntrypoint } from "./config-store.js";

let asanaClient: Client | null = null;
let specPipelineClient: Client | null = null;
let svnClient: Client | null = null;

/**
 * Full environment for spawning bridged child MCP servers.
 *
 * The SDK's StdioClientTransport, when no `env` is given, falls back to a small safe-inherit
 * allowlist (see getDefaultEnvironment() in the SDK) intended for a single hop from a trusted
 * host straight to a user-configured server. That allowlist drops vars like PATHEXT/LANG/LC_ALL
 * on Windows. For our nested hop (this process -> child MCP -> e.g. `svn` CLI), losing those vars
 * changes how Windows resolves/decodes the child's own subprocess invocations — concretely, the
 * bridged svn-mcp instance intermittently built garbled (double-encoded) SVN URLs from otherwise
 * correct, verified-UTF-8 connection config when spawned this way, while the exact same svn-mcp
 * binary spawned directly by the top-level host (which does inherit the full environment) worked
 * fine. Passing our own full environment through closes that gap: these are trusted local child
 * processes we spawn ourselves (not untrusted/remote-configured), so there's no security reason to
 * restrict what they inherit here.
 */
function getFullEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function connect(name: string, entrypoint: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint], env: getFullEnvironment() });
  const client = new Client({ name: `asana-pipeline-mcp (${name} bridge)`, version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function getAsanaClient(): Promise<Client> {
  if (!asanaClient) {
    asanaClient = await connect("asana-mcp", getAsanaMcpEntrypoint());
  }
  return asanaClient;
}

async function getSpecPipelineClient(): Promise<Client> {
  if (!specPipelineClient) {
    specPipelineClient = await connect("spec-pipeline-mcp", getSpecPipelineMcpEntrypoint());
  }
  return specPipelineClient;
}

async function getSvnClient(): Promise<Client> {
  if (!svnClient) {
    svnClient = await connect("svn-mcp", getSvnMcpEntrypoint());
  }
  return svnClient;
}

/** Thrown when the bridged MCP's tool call itself completed but reported `isError: true` — a business-logic failure, not a broken connection. Callers should NOT drop the cached client for this (see mcp-clients.ts's bridgeCall). */
export class McpBridgeError extends Error {}

/** Extracts the text payload from an MCP tool result and JSON-parses it (all bridged servers return JSON-in-text content). Throws McpBridgeError if the bridged tool reported isError, instead of silently handing the error payload back to the caller as if it were a normal result. */
function parseToolResult(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): any {
  const textBlock = result.content.find((b) => b.type === "text");
  const text = textBlock?.text;
  if (result.isError) {
    throw new McpBridgeError(text ?? `橋接的 MCP 回傳錯誤，但沒有文字內容：${JSON.stringify(result)}`);
  }
  if (!text) {
    throw new McpBridgeError(`預期收到文字內容，但沒有拿到：${JSON.stringify(result)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Calls one tool on a bridged child MCP, distinguishing two failure modes:
 * - The tool call reaches the child and completes, but reports isError (McpBridgeError from parseToolResult) —
 *   a business-logic failure. The connection itself is fine, so the cached client is kept.
 * - Anything else thrown (transport closed, child process died, JSON-RPC timeout, etc.) — a connection-level
 *   failure. The cached client is dropped so the *next* call reconnects instead of reusing a dead client forever.
 * Either way the error propagates to the caller; the MCP SDK's own tool-call dispatcher turns a thrown error
 * into a proper `isError` tool result for whoever is calling asana-pipeline-mcp, so this is safe to just throw.
 */
async function bridgeCall(
  getClient: () => Promise<Client>,
  invalidateClient: () => void,
  name: string,
  args: Record<string, unknown>
): Promise<any> {
  const client = await getClient();
  try {
    const result = await client.callTool({ name, arguments: args });
    return parseToolResult(result as any);
  } catch (err) {
    if (!(err instanceof McpBridgeError)) {
      invalidateClient();
    }
    throw err;
  }
}

export async function callAsanaTool(name: string, args: Record<string, unknown>): Promise<any> {
  return bridgeCall(
    getAsanaClient,
    () => {
      asanaClient = null;
    },
    name,
    args
  );
}

export async function callSpecPipelineTool(name: string, args: Record<string, unknown>): Promise<any> {
  return bridgeCall(
    getSpecPipelineClient,
    () => {
      specPipelineClient = null;
    },
    name,
    args
  );
}

export async function callSvnTool(name: string, args: Record<string, unknown>): Promise<any> {
  return bridgeCall(
    getSvnClient,
    () => {
      svnClient = null;
    },
    name,
    args
  );
}

export async function closeChildMcpClients(): Promise<void> {
  await Promise.allSettled([asanaClient?.close(), specPipelineClient?.close(), svnClient?.close()]);
  asanaClient = null;
  specPipelineClient = null;
  svnClient = null;
}
