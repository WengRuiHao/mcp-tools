/**
 * 用作業系統預設的程式開啟檔案、或在檔案總管中標示出檔案。
 * 設定 `SVN_EDIT_NO_LAUNCH=1` 會完全不啟動任何程式（給自動化測試用）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

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

export interface EditorLaunch {
  command: string;
  args: string[];
}

/** VS Code 的安裝位置（使用者安裝版、系統安裝版）；`SVN_EDIT_VSCODE` 可指定路徑覆蓋。找不到回傳 null。 */
export function findVsCode(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  const override = env.SVN_EDIT_VSCODE?.trim();
  if (override) return exists(override) ? override : null;
  const roots = [env.LOCALAPPDATA, env.ProgramFiles, env["ProgramFiles(x86)"]].filter((r): r is string => Boolean(r));
  const suffix = path.join("Microsoft VS Code", "Code.exe");
  for (const root of roots) {
    const candidate = root === env.LOCALAPPDATA ? path.join(root, "Programs", suffix) : path.join(root, suffix);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * 「編輯」某個檔案時要用哪個程式開：只影響 svn-edit 自己開檔，不會動到使用者電腦上的檔案關聯。
 * - md → VS Code（找不到就用預設程式）
 * - csv → 記事本（避免被 Excel 開啟後用 ANSI 編碼存檔，把 UTF-8 中文弄成亂碼）
 * - 其他 → 預設程式（回傳 null）
 */
export function resolveEditorLaunch(filePath: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): EditorLaunch | null {
  if (platform !== "win32") return null;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md") {
    const code = findVsCode(env, exists);
    return code ? { command: code, args: [filePath] } : null;
  }
  if (ext === ".csv") return { command: "notepad.exe", args: [filePath] };
  return null;
}

/** 開啟要編輯的檔案：依副檔名挑程式（見 resolveEditorLaunch），沒有指定就交給系統預設程式。 */
export function openForEdit(filePath: string): void {
  const launchSpec = resolveEditorLaunch(filePath);
  if (launchSpec) launch(launchSpec.command, launchSpec.args);
  else openFile(filePath);
}
