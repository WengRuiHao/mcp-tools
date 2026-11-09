// 黃金快照：全部已註冊 MCP 工具的對外介面（名稱、description 雜湊與長度、輸入參數 schema）。
// 參數 schema 取自 listTools 的 JSON Schema，describe 文字只存 sha256；UPDATE_GOLDEN=1 才會重寫 tests/golden/tool-schemas.json。
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { connectClient } from "./helpers/support.mjs";
import { checkGolden } from "./helpers/golden.mjs";
import { registerAllTools } from "../dist/toolsets.js";

const EXPECTED_TOOL_COUNT = 43;
const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** 遞迴把 schema 中的 description 換成雜湊與長度，其餘（type、enum、required、properties…）原樣保留。 */
function digestSchema(node) {
  if (Array.isArray(node)) return node.map(digestSchema);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "description" && typeof v === "string") { out.descriptionSha256 = sha(v); out.descriptionLength = v.length; }
    else out[k] = digestSchema(v);
  }
  return out;
}

function countParams(schema) {
  return Object.keys(schema?.properties ?? {}).length;
}

async function buildSnapshot() {
  const { client, close } = await connectClient((s) => registerAllTools(s, new Set()));
  try {
    const tools = (await client.listTools()).tools;
    const snapshot = {};
    for (const t of tools) {
      const description = t.description ?? "";
      snapshot[t.name] = {
        descriptionSha256: sha(description),
        descriptionLength: description.length,
        paramCount: countParams(t.inputSchema),
        inputSchema: digestSchema(t.inputSchema),
      };
    }
    return snapshot;
  } finally {
    await close();
  }
}

test("工具介面黃金快照：工具總數固定為 43", async () => {
  const snapshot = await buildSnapshot();
  assert.equal(Object.keys(snapshot).length, EXPECTED_TOOL_COUNT);
});

test("工具介面黃金快照：名稱、說明雜湊、參數 schema 逐項比對", async () => {
  const snapshot = await buildSnapshot();
  checkGolden("tool-schemas.json", { toolCount: Object.keys(snapshot).length, ...snapshot });
});
