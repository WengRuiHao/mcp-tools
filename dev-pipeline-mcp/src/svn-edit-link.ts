/**
 * 報告頁上「編輯 SVN 上的規格書」的連結：連到 svn-mcp 的 svn-edit 本機服務（預設 127.0.0.1:8096）。
 * 這個模組只負責「組連結」，不含任何 SVN 邏輯——選檔、取出、編輯、上傳全部由 svn-edit 處理，
 * 這邊永遠不會有落差（也不需要保存 svn-edit 的 token：連結只是頁面導向，真正的動作要使用者在 svn-edit 的頁面上按）。
 */
import type { SasdConfig } from "./project-registry.js";

const DEFAULT_SVN_EDIT_PORT = 8096;

export interface SvnEditLink {
  url: string;
  connection: string;
  startDir: string;
}

/** 跟 svn-mcp 的 svn-edit 用同一個環境變數 SVN_EDIT_PORT，沒設定就用預設埠。 */
export function resolveSvnEditPort(): number {
  const port = Number(process.env.SVN_EDIT_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_SVN_EDIT_PORT;
}

/**
 * 只有規格書真的放在 SVN 上的專案才有連結：sdMode 是 external／self、而且登記了 SVN 連線。
 * self-generated 專案的 SD 是本機檔案（sdOutputPath），不在 SVN 上，沒有東西可以用 svn-edit 編輯。
 * 起始目錄用 sdRoot，沒有就用 saRoot。
 */
export function buildSvnEditLink(config: SasdConfig | null): SvnEditLink | null {
  if (!config || !config.svnConnectionId) return null;
  if (config.sdMode !== "external" && config.sdMode !== "self") return null;
  const startDir = (config.sdRoot || config.saRoot || "").trim().replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "");
  const url = `http://127.0.0.1:${resolveSvnEditPort()}/?connection=${encodeURIComponent(config.svnConnectionId)}&browse=${encodeURIComponent(startDir)}`;
  return { url, connection: config.svnConnectionId, startDir };
}

function esc(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 報告頁上方的區塊；沒有連結（不適用的專案）時回傳空字串，頁面完全不變。 */
export function renderSvnEditSection(link: SvnEditLink | null): string {
  if (!link) return "";
  const where = link.startDir ? `<code>${esc(link.startDir)}</code>` : "連線根目錄";
  return `<section class="block" id="svn-edit-section">
    <h2>編輯 SVN 上的規格書</h2>
    <p class="meta">用 svn-edit 把 SVN 上的規格書取到暫存區、用 Word／Excel 等軟體改完再傳回 SVN（連線：<code>${esc(link.connection)}</code>，起始目錄：${where}）。<strong>這個連結只會打開 svn-edit 的頁面，要在那邊按「開始編輯」才會真的取出檔案。</strong>需要 svn-edit 在跑：連上 svn-mcp 的 Claude Code session 會自動啟動它，也可以直接執行 svn-mcp 的 <code>dist-exe/svn-edit.exe</code>。</p>
    <p><a class="btn btn-yes" href="${esc(link.url)}" target="_blank" rel="noopener">✏️ 開啟規格書瀏覽／編輯</a></p>
  </section>`;
}
