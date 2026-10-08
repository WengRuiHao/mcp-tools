/**
 * 用作業系統預設的程式開啟檔案、或在檔案總管中標示出檔案。
 * 設定 `SVN_EDIT_NO_LAUNCH=1` 會完全不啟動任何程式（給自動化測試用）。
 */
import { spawn } from "node:child_process";

function launch(command: string, args: string[]): void {
  if (process.env.SVN_EDIT_NO_LAUNCH === "1") return;
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", (e) => console.error(`[svn-edit] 啟動 ${command} 失敗：${e.message}`));
  child.unref();
}

/** 用預設程式開啟檔案（Windows 交給檔案總管處理，中文路徑與空白都不需要額外跳脫）。 */
export function openFile(filePath: string): void {
  if (process.platform === "win32") launch("explorer.exe", [filePath]);
  else if (process.platform === "darwin") launch("open", [filePath]);
  else launch("xdg-open", [filePath]);
}

/** 在檔案總管中標示出檔案（其他平台退而求其次，開啟所在資料夾）。 */
export function revealFile(filePath: string): void {
  if (process.platform === "win32") launch("explorer.exe", [`/select,${filePath}`]);
  else if (process.platform === "darwin") launch("open", ["-R", filePath]);
  else launch("xdg-open", [filePath.replace(/[\\/][^\\/]*$/, "")]);
}

/** 用預設瀏覽器開啟網址（只給 svn-edit 自己的 127.0.0.1 控制頁用）。 */
export function openUrl(url: string): void {
  if (process.platform === "win32") launch("explorer.exe", [url]);
  else if (process.platform === "darwin") launch("open", [url]);
  else launch("xdg-open", [url]);
}
