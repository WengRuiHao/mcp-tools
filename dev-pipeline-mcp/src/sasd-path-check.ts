/**
 * project_config(kind='sasd_config', action='register') 登記前的路徑檢查：saRoot／sdRoot 必須是「相對於 SVN repo 根目錄、用正斜線」的真實路徑。
 * 過去只驗連線不驗路徑，結果有專案登記了本機工作副本風格的路徑（WC-FOLDER\2-SA\…，多一層資料夾名又用反斜線），
 * 在 SVN 上根本不存在，之後每張票讀規格都會失敗。
 */

export interface SvnRootInput {
  field: "saRoot" | "sdRoot";
  value: string;
}

export type SvnBrowseFn = (args: { path: string; connectionId: string }) => Promise<{ success?: boolean; message?: string } | null | undefined>;

/** 純語法檢查（不連 SVN）：回傳問題描述，沒問題回傳 null。 */
export function findSvnRootSyntaxProblem(value: string): string | null {
  if (value.includes("\\")) {
    return "含有反斜線——SVN 路徑要用正斜線 /（反斜線是本機 Windows 路徑的寫法）";
  }
  if (/^[a-zA-Z]:/.test(value) || value.startsWith("/")) {
    return "看起來是本機絕對路徑——要填相對於 SVN repo 根目錄的路徑（例如 \"2-SA/規格\"），不要磁碟代號或開頭的 /";
  }
  if (value.split("/").includes("..")) {
    return "不可包含 ..";
  }
  return null;
}

/**
 * 逐一檢查 saRoot／sdRoot：先語法、再實際用 svn_browse 確認路徑在這個連線底下存在。
 * 回傳第一個問題的完整訊息；全部通過回傳 null。browse 可注入，方便測試不連真實 SVN。
 */
export async function verifySvnRoots(connectionId: string, roots: SvnRootInput[], browse: SvnBrowseFn): Promise<string | null> {
  for (const { field, value } of roots) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const syntaxProblem = findSvnRootSyntaxProblem(trimmed);
    if (syntaxProblem) return `${field}「${value}」${syntaxProblem}。`;
    // callSvnTool 在 svn 回報錯誤時是丟例外（不是回 success:false），兩種失敗型態都要接。
    let failure: string | null = null;
    try {
      const result = await browse({ path: trimmed, connectionId });
      if (!result?.success) failure = result?.message ?? "未知錯誤";
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    if (failure !== null) {
      return `${field}「${value}」在 SVN 連線「${connectionId}」底下瀏覽失敗（路徑不存在或沒有權限）：${failure}。請先用 svn_browse 從 repo 根目錄一層層確認真實路徑，再重新呼叫 project_config(kind='sasd_config', action='register')。`;
    }
  }
  return null;
}

/** 「這個專案沒有 SA 文件」的占位寫法（例如 N/A-無SA文件），不是 SVN 上的真實路徑。 */
export function isNoSaPlaceholder(saRoot: string): boolean {
  return /^n\/a\b/i.test(saRoot.trim());
}

/**
 * 這個登記需不需要 SVN 連線：sdMode 是 external／self（規格就在 SVN），或 saRoot 是真實路徑
 * （分析師一定要到 SVN 讀 SA，沒連線就讀不到）。saRoot 是 N/A 占位且 SD 不在 SVN（self-generated／unregistered）才免。
 */
export function requiresSvnConnection(sdMode: string, saRoot: string): boolean {
  if (sdMode === "external" || sdMode === "self") return true;
  return !isNoSaPlaceholder(saRoot);
}
