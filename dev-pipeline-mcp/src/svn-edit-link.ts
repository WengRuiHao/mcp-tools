/**
 * 報告頁上「編輯 SVN 上的規格書」的連結：連到 svn-mcp 的 svn-edit 本機服務（預設 127.0.0.1:9097）。
 * 這個模組只負責「組連結」，不含任何 SVN 邏輯——選檔、取出、編輯、上傳全部由 svn-edit 處理，
 * 這邊永遠不會有落差（也不需要保存 svn-edit 的 token：連結只是頁面導向，真正的動作要使用者在 svn-edit 的頁面上按）。
 */
import type { SasdConfig } from "./project-registry.js";

const DEFAULT_SVN_EDIT_PORT = 9097;

export interface SvnEditLink {
  url: string;
  connection: string;
  startDir: string;
  /** self-generated：SD 在本機，要用 svn-edit 把檔案上傳到 SVN（而不是取出編輯） */
  uploadOnly?: boolean;
}

/** 跟 svn-mcp 的 svn-edit 用同一個環境變數 SVN_EDIT_PORT，沒設定就用預設埠。 */
export function resolveSvnEditPort(): number {
  const port = Number(process.env.SVN_EDIT_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_SVN_EDIT_PORT;
}

/**
 * 登記了 SVN 連線的專案才有連結：
 * - external／self：規格書在 SVN 上，起始目錄用 sdRoot，沒有就用 saRoot。
 * - self-generated：SD 先產在本機（sdOutputPath），要靠 svn-edit 的「新增檔案／批次上傳」送上 SVN；
 *   saRoot 是前端規格的位置、不是 SD 該放的地方，所以只有登記了 sdRoot 才從那裡開始，否則從連線根目錄開始。
 * unregistered 沒有規格相關設定，不給連結。
 */
export function buildSvnEditLink(config: SasdConfig | null): SvnEditLink | null {
  if (!config || !config.svnConnectionId) return null;
  if (config.sdMode === "unregistered") return null;
  const uploadOnly = config.sdMode === "self-generated";
  const startDir = (config.sdRoot || (uploadOnly ? "" : config.saRoot) || "").trim().replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "");
  const url = `http://127.0.0.1:${resolveSvnEditPort()}/?connection=${encodeURIComponent(config.svnConnectionId)}&browse=${encodeURIComponent(startDir)}`;
  return { url, connection: config.svnConnectionId, startDir, ...(uploadOnly ? { uploadOnly } : {}) };
}

function esc(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 報告頁上方的區塊；沒有連結（不適用的專案）時回傳空字串，頁面完全不變。 */
export function renderSvnEditSection(link: SvnEditLink | null): string {
  if (!link) return "";
  const where = link.startDir ? `<code>${esc(link.startDir)}</code>` : "連線根目錄";
  if (link.uploadOnly) {
    return `<section class="block" id="svn-edit-section">
    <h2>上傳規格書到 SVN</h2>
    <p class="meta">這個專案的 SD 是 AI 產在本機的檔案；用 svn-mcp 的 svn-edit 介面瀏覽 SVN 目錄、把檔案或資料夾批次上傳過去（連線：<code>${esc(link.connection)}</code>，起始目錄：${where}）。<strong>這個連結只會打開 svn-edit 的頁面，要在那邊按上傳才會真的寫入 SVN，AI 沒有任何工具能做這件事。</strong>需要 svn-edit 在跑：連上 svn-mcp 的 Claude Code session 會自動啟動它，也可以直接執行 svn-mcp 的 <code>dist-exe/svn-edit.exe</code>。</p>
    <p><a class="btn btn-yes" href="${esc(link.url)}" target="_blank" rel="noopener">📤 開啟 svn-edit（瀏覽／上傳）</a></p>
  </section>`;
  }
  return `<section class="block" id="svn-edit-section">
    <h2>編輯 SVN 上的規格書</h2>
    <p class="meta">用 svn-edit 把 SVN 上的規格書取到暫存區、用 Word／Excel 等軟體改完再傳回 SVN（連線：<code>${esc(link.connection)}</code>，起始目錄：${where}）。<strong>這個連結只會打開 svn-edit 的頁面，要在那邊按「開始編輯」才會真的取出檔案。</strong>需要 svn-edit 在跑：連上 svn-mcp 的 Claude Code session 會自動啟動它，也可以直接執行 svn-mcp 的 <code>dist-exe/svn-edit.exe</code>。</p>
    <p><a class="btn btn-yes" href="${esc(link.url)}" target="_blank" rel="noopener">✏️ 開啟規格書瀏覽／編輯</a></p>
  </section>`;
}
