/**
 * 叫出 Windows 系統內建的「選擇資料夾」視窗，讓使用者點選本機資料夾（跟檔案總管、TortoiseSVN 看到的同一個視窗，
 * 資料夾上有 SVN 圖示），選好後回傳完整路徑，不用複製貼上。
 *
 * 為什麼要由本機服務來叫：網頁（瀏覽器的「上傳資料夾」視窗）拿不到資料夾的完整路徑，只拿得到裡面的檔案；
 * svn-edit 是跑在使用者自己電腦上的本機服務，可以直接叫系統視窗（Vista 以後的 IFileDialog，選資料夾模式）。
 *
 * - 只有 Windows 能用；其他系統、叫不出視窗都丟錯誤，由網頁退回「頁面內的資料夾點選視窗」；
 * - 一次只開一個視窗（重複按不會疊出好幾個）；使用者按取消回傳空字串；
 * - 這支只負責「選」，不會讀寫選到的資料夾裡的任何東西；
 * - `SVN_EDIT_NO_LAUNCH=1`（自動化測試）時不叫視窗，直接回傳 `SVN_EDIT_PICK_RESULT`。
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { cleanLocalDir } from "./prefs-model.js";
import { EditError } from "./remote-edit-client.js";
import { toSlash } from "./util.js";

const PICK_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TITLE_LENGTH = 100;

let picking = false;

/** C# 部分：IFileDialog（選資料夾模式）。介面方法的順序必須跟 Windows SDK 的 vtable 一致。 */
const PICKER_SOURCE = `
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class FolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
  }
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItem ppv);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static string Pick(string title, string start) {
    IFileDialog dlg = (IFileDialog)new FileOpenDialogRCW();
    uint options;
    dlg.GetOptions(out options);
    dlg.SetOptions(options | 0x20 | 0x40 | 0x800); // 選資料夾、只要檔案系統、路徑必須存在
    dlg.SetTitle(title);
    dlg.SetOkButtonLabel("選擇資料夾");
    if (!String.IsNullOrEmpty(start) && Directory.Exists(start)) {
      Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
      IShellItem item;
      SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out item);
      dlg.SetFolder(item);
    }
    int hr = dlg.Show(GetForegroundWindow()); // 掛在目前最上層的視窗（svn-edit 視窗）底下
    if (hr != 0) return ""; // 取消
    IShellItem result;
    dlg.GetResult(out result);
    string selected;
    result.GetDisplayName(0x80058000, out selected); // SIGDN_FILESYSPATH
    return selected;
  }
}
`;

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 組出要給 PowerShell 執行的腳本（標題與起始資料夾已跳脫）。輸出用 base64，避免中文被主控台字碼頁弄壞。 */
export function buildPickerScript(title: string, start: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$title = ${psQuote(title)}`,
    `$start = ${psQuote(start.split("/").join(path.sep))}`, // Windows 的 API 不接受用 / 分隔的路徑
    "Add-Type -TypeDefinition @'",
    PICKER_SOURCE.trim(),
    "'@",
    "$picked = [FolderPicker]::Pick($title, $start)",
    "[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($picked)))",
  ].join("\n");
}

/** 系統視窗回傳的路徑整理成跟其他地方一致的格式（磁碟機路徑用 `/`，網路路徑維持原樣）。 */
export function normalizePickedPath(picked: string): string {
  const text = picked.trim();
  if (text.startsWith(path.sep + path.sep)) return cleanLocalDir(text);
  return cleanLocalDir(toSlash(text));
}

export interface PickParams {
  title?: unknown;
  /** 視窗一開始停在哪個資料夾（上次選的位置）；不存在就忽略。 */
  start?: unknown;
}

export async function pickLocalFolder(params: PickParams): Promise<{ path: string }> {
  if (process.env.SVN_EDIT_NO_LAUNCH === "1") return { path: process.env.SVN_EDIT_PICK_RESULT ?? "" };
  if (process.platform !== "win32") throw new EditError("INVALID_INPUT", "這個系統沒辦法叫出系統的選擇資料夾視窗，請改用頁面內的選擇視窗。");
  if (picking) throw new EditError("INVALID_INPUT", "已經有一個選擇資料夾的視窗開著了，請先在那個視窗選好或取消。");

  const title = (typeof params.title === "string" && params.title.trim() ? params.title.trim() : "選擇資料夾").slice(0, MAX_TITLE_LENGTH);
  const startText = typeof params.start === "string" ? params.start.trim() : "";
  const start = startText && path.isAbsolute(startText) && existsSync(startText) && statSync(startText).isDirectory() ? path.resolve(startText) : "";

  picking = true;
  try {
    const encoded = Buffer.from(buildPickerScript(title, start), "utf16le").toString("base64");
    const stdout = await new Promise<string>((resolve, reject) => {
      // 注意：不能加 detached；而且要 -STA（系統視窗需要單執行緒套間）
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, timeout: PICK_TIMEOUT_MS, encoding: "utf8" }, (error, out, stderr) => {
        if (error) reject(new EditError("INVALID_INPUT", `叫不出系統的選擇資料夾視窗：${String(stderr || error.message).trim().slice(0, 300)}`));
        else resolve(String(out));
      });
    });
    const picked = Buffer.from(stdout.trim(), "base64").toString("utf-8");
    if (!picked) return { path: "" };
    const normalized = normalizePickedPath(picked);
    if (!normalized) throw new EditError("INVALID_INPUT", `選到的位置沒辦法使用：${picked}（需要是磁碟機或網路上的資料夾）`);
    return { path: normalized };
  } finally {
    picking = false;
  }
}
