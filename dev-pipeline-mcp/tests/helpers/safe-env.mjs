// 測試的預設安全環境（由 npm test 以 node --import 預載）。
// 把 asana-mcp 指到不存在的檔案，避免任何測試在忘了設定時啟動真的 asana-mcp（會用到使用者真實憑證）。
// 需要假的 asana-mcp 的測試，自己覆寫 process.env.ASANA_MCP_PATH 即可（例如 helpers/fake-asana-mcp.mjs）。
import os from "node:os";
import path from "node:path";

process.env.ASANA_MCP_PATH = path.join(os.tmpdir(), "dev-pipeline-tests-no-such-asana-mcp.js");
