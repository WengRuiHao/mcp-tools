/**
 * 共用設定：PENDING_HUMAN_ACTIONS.html 裡的勾選/確認按鈕要打回本機的 HTTP bridge
 * （`dist/http-server.js`，獨立長駐行程，見該檔案開頭說明）。這個常數兩邊都要用到同一個值——
 * `pipeline-store.ts` 產生 HTML 時要把這個 port 寫進頁面的 fetch() 目標，`http-server.ts`
 * 自己啟動時也要 bind 同一個 port，兩者用同一個環境變數/預設值來源，避免各自寫死、之後改一邊忘了改另一邊。
 */
export const DEFAULT_HTTP_BRIDGE_PORT = 8097;

export function resolveHttpBridgePort(): number {
  const fromEnv = Number(process.env.DEV_PIPELINE_MCP_HTTP_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_HTTP_BRIDGE_PORT;
}

export function resolveHttpBridgeHost(): string {
  return process.env.DEV_PIPELINE_MCP_HTTP_HOST || "127.0.0.1";
}
