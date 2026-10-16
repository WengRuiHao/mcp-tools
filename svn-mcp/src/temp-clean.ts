/**
 * 刪暫存資料夾（編輯項目的工作副本、檢視檔…）。
 *
 * Windows 上資料夾裡的檔案常被別的程式短暫鎖住：TortoiseSVN 的快取程式、防毒軟體會掃描新建的 SVN 工作副本，
 * 讓 `.svn\wc.db` 在我們要刪的當下回 EBUSY／EPERM，過一下就釋放了。所以：
 * - 刪除時對這些錯誤自動重試幾秒；
 * - 還是刪不掉就放進背景，每隔幾秒再試（呼叫端不用卡住，也不用把「解鎖都成功了」的放棄編輯當成失敗）；
 * - 連背景都刪不掉的，下次 svn-edit 啟動或結束時由 cleanupTransientDirs 清掉（沒有 session.json 的空殼）。
 */
import { rm } from "node:fs/promises";

/** Node 的重試等待是線性遞增（第 n 次等 n × retryDelay）：6 次、150 毫秒 ≒ 最久等 3 秒，不會讓畫面卡太久。 */
const RETRY_OPTIONS = { recursive: true, force: true, maxRetries: 6, retryDelay: 150 } as const;
export const BACKGROUND_RETRY_MS = 5000;
const BACKGROUND_MAX_ATTEMPTS = 12;

function scheduleBackgroundRemoval(dir: string, attempt = 1): void {
  if (attempt > BACKGROUND_MAX_ATTEMPTS) return;
  const timer = setTimeout(() => {
    rm(dir, RETRY_OPTIONS).catch(() => scheduleBackgroundRemoval(dir, attempt + 1));
  }, BACKGROUND_RETRY_MS);
  timer.unref();
}

/** 刪除整個資料夾；成功回傳 true。被鎖住刪不掉時回傳 false，並在背景繼續重試（不會丟出錯誤）。 */
export async function removeDirWithRetry(dir: string): Promise<boolean> {
  try {
    await rm(dir, RETRY_OPTIONS);
    return true;
  } catch {
    scheduleBackgroundRemoval(dir);
    return false;
  }
}
