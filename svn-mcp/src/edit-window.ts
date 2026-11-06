/**
 * svn-edit 的桌面視窗：用 Edge 的「應用程式視窗」模式（`--app=網址`）開控制頁——沒有網址列、沒有分頁，
 * 看起來就是一個獨立的桌面程式。找不到 Edge 時退回預設瀏覽器。
 *
 * - 用專屬的 Edge 設定資料夾（%LOCALAPPDATA%\SVN遠端編輯\edge），不會動到使用者平常的瀏覽器設定，也不會出現首次啟動的歡迎畫面；
 * - 已經有視窗開著時，優先把那個視窗叫到最前面，不重複開（Windows 常擋背景程式搶前景，所以叫不到就退回再開一個）。
 *
 * 設定 `SVN_EDIT_NO_LAUNCH=1` 會完全不開任何視窗（給自動化測試用）。
 */
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FAVICON_ICO_BASE64 } from "./edit-icon-data.js";
import { openUrl } from "./os-open.js";
import { errorMessage } from "./util.js";

/** 視窗標題（等於控制頁的 <title>）；叫出既有視窗時靠它辨認。 */
export const WINDOW_TITLE = "SVN 遠端編輯";
export const DEFAULT_WINDOW_WIDTH = 560;
export const DEFAULT_WINDOW_HEIGHT = 820;
const ACTIVATE_TIMEOUT_MS = 8000;
/** 關掉 Edge 首次啟動、登入、同步、購物等干擾功能，讓它只是一個乾淨的視窗。 */
const EDGE_QUIET_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-sync",
  "--no-service-autorun",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-features=msImplicitSignIn,msSignInPromo,EdgeSyncPromotion,msWebOOBE,msEdgeWelcomePage,FirstRunExperience,msEdgeShoppingUI",
];

export function findEdge(): string | null {
  const roots = [process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", process.env.ProgramFiles || "C:\\Program Files"];
  for (const root of roots) {
    const file = path.join(root, "Microsoft", "Edge", "Application", "msedge.exe");
    if (existsSync(file)) return file;
  }
  return null;
}

function edgeProfileDir(): string {
  const override = process.env.SVN_EDIT_EDGE_PROFILE?.trim();
  const dir = override ? path.resolve(override) : path.join(process.env.LOCALAPPDATA || os.tmpdir(), "SVN遠端編輯", "edge");
  mkdirSync(dir, { recursive: true });
  // 這個檔案存在，Edge 就當作已經跑過首次啟動流程
  const firstRun = path.join(dir, "First Run");
  if (!existsSync(firstRun)) writeFileSync(firstRun, "");
  return dir;
}

/** 開一個獨立的應用程式視窗顯示 `url`；沒有 Edge 就用預設瀏覽器開。 */
export function openAppWindow(url: string, width = DEFAULT_WINDOW_WIDTH, height = DEFAULT_WINDOW_HEIGHT): void {
  if (process.env.SVN_EDIT_NO_LAUNCH === "1") return;
  const edge = process.platform === "win32" ? findEdge() : null;
  if (!edge) {
    openUrl(url);
    return;
  }
  try {
    const child = spawn(edge, [`--app=${url}`, `--user-data-dir=${edgeProfileDir()}`, `--window-size=${width},${height}`, ...EDGE_QUIET_FLAGS], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (e) => {
      console.error(`[svn-edit] 開啟 Edge 視窗失敗：${e.message}`);
      openUrl(url);
    });
    child.unref();
    applyWindowIconLater();
  } catch (e) {
    console.error(`[svn-edit] 開啟 Edge 視窗失敗：${errorMessage(e)}`);
    openUrl(url);
  }
}

// Edge 的應用程式視窗，工作列／標題列圖標是拿網頁的小圖標（16～32 像素）硬放大的，會糊。
// 所以視窗出現後，直接把我們多尺寸圖標檔裡「最接近目前螢幕縮放比例」的尺寸指定給這個視窗（WM_SETICON）。
// Edge 載入網頁圖標時可能又把它換回去，所以前幾秒重複指定幾次。
const ICON_FILE_NAME = "app.ico";
const ICON_APPLY_SECONDS = 90; // 等視窗第一次出現的上限秒數；出現後腳本會一直待命，直到 svn-edit 本身結束
const ICON_LOG_NAME = "icon.log";
const ICON_LOG_MAX_BYTES = 100_000;

function ensureIconFile(): string | null {
  try {
    const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "SVN遠端編輯");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, ICON_FILE_NAME);
    const bytes = Buffer.from(FAVICON_ICO_BASE64, "base64");
    if (!existsSync(file) || !readFileSync(file).equals(bytes)) writeFileSync(file, bytes);
    return file;
  } catch (e) {
    console.error(`[svn-edit] 寫入圖標檔失敗：${errorMessage(e)}`);
    return null;
  }
}

const WINDOW_ICON_SCRIPT = `
function Write-IconLog($text) {
  try { Add-Content -LiteralPath $logFile -Value ((Get-Date -Format 's') + ' ' + $text) -Encoding UTF8 } catch {}
}
Write-IconLog '腳本啟動'
try {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SvnEditIcon {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr LoadImage(IntPtr inst, string name, uint type, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int idx, uint dpi);
  // 標題相符的「所有」可見視窗：舊視窗還沒關又開新視窗時，兩個都要處理，不能只抓第一個
  public static IntPtr[] FindAll(string part) {
    var found = new System.Collections.Generic.List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString() == part) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size = 24)] struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint c);
    [PreserveSig] int GetAt(uint i, out PROPERTYKEY k);
    [PreserveSig] int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
    [PreserveSig] int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
  static readonly Guid AppUserModelFmt = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
  static void SetString(IPropertyStore store, uint pid, string value) {
    PROPERTYKEY key = new PROPERTYKEY(); key.fmtid = AppUserModelFmt; key.pid = pid;
    PROPVARIANT pv = new PROPVARIANT(); pv.vt = 31; pv.p = Marshal.StringToCoTaskMemUni(value);
    store.SetValue(ref key, ref pv);
  }
  // 登記這個視窗的 App ID 與圖標資源：工作列會自己從圖標檔挑出最合適的尺寸，不再拿網頁小圖標放大
  public static int RegisterApp(IntPtr hwnd, string id, string relaunchCommand, string iconResource, string displayName) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStore store;
    int hr = SHGetPropertyStoreForWindow(hwnd, ref iid, out store);
    if (hr != 0) return hr;
    SetString(store, 2, relaunchCommand);
    SetString(store, 3, iconResource);
    SetString(store, 4, displayName);
    SetString(store, 5, id);
    return store.Commit();
  }
  class Handles { public IntPtr Big, Small; public int BigSize, SmallSize; }
  static readonly System.Collections.Generic.Dictionary<long, Handles> cache = new System.Collections.Generic.Dictionary<long, Handles>();
  // 每個視窗各自記一份圖標控點（螢幕縮放可能不同），只在尺寸改變時才重新載入、只在 Edge 把圖標換掉時才重新指定，
  // 避免每次輪詢都洩漏一組 HICON、或兩個視窗互相蓋來蓋去
  public static bool Apply(IntPtr h, string ico) {
    uint dpi = GetDpiForWindow(h); if (dpi == 0) dpi = 96;
    int big = (int)Math.Round(24.0 * dpi / 96.0);
    int small = GetSystemMetricsForDpi(49, dpi);
    Handles c;
    if (!cache.TryGetValue(h.ToInt64(), out c)) { c = new Handles(); cache[h.ToInt64()] = c; }
    if (c.Big == IntPtr.Zero || c.Small == IntPtr.Zero || big != c.BigSize || small != c.SmallSize) {
      IntPtr hb = LoadImage(IntPtr.Zero, ico, 1, big, big, 0x10);
      IntPtr hs = LoadImage(IntPtr.Zero, ico, 1, small, small, 0x10);
      if (hb == IntPtr.Zero || hs == IntPtr.Zero) return false;
      c.Big = hb; c.Small = hs; c.BigSize = big; c.SmallSize = small;
    }
    if (SendMessage(h, 0x7F, (IntPtr)1, IntPtr.Zero) == c.Big && SendMessage(h, 0x7F, (IntPtr)0, IntPtr.Zero) == c.Small) return false;
    SendMessage(h, 0x80, (IntPtr)1, c.Big);
    SendMessage(h, 0x80, (IntPtr)0, c.Small);
    return true;
  }
}
'@
} catch { Write-IconLog ('Add-Type 失敗：' + $_.Exception.Message); exit 1 }
$deadline = (Get-Date).AddSeconds(__SECONDS__)
$applied = 0
$registered = @{}
$seen = $false
# 視窗還在就持續檢查圖標（Edge 之後重新載入網頁圖標時會換回小圖，換掉就再蓋回去）。
# 不再因為「暫時找不到視窗」就收工：只要 svn-edit 本身還活著就繼續待命，結束原因寫進 icon.log 方便追查。
$mutex = New-Object System.Threading.Mutex($false, 'Local\\UEC.SvnEditIconScript')
$owner = $false
while ($true) {
  if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { Write-IconLog ('svn-edit 已結束，圖標腳本收工（共指定 ' + $applied + ' 次）'); break }
  # 同時有兩個 svn-edit 時，兩支腳本會互相把對方設的圖標蓋掉；同一時間只讓一支負責（它會處理所有視窗），另一支待命，等前一支結束再接手
  if (-not $owner) {
    try { $owner = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owner = $true }
    if ($owner) { Write-IconLog '取得負責權' } else { Start-Sleep -Milliseconds 1500; continue }
  }
  $windows = [SvnEditIcon]::FindAll($title)
  if ($windows.Length -gt 0) {
    $seen = $true
    foreach ($h in $windows) {
      if (-not $registered.ContainsKey([string]$h)) {
        $hr = [SvnEditIcon]::RegisterApp($h, 'UEC.SvnRemoteEdit', $relaunch, $iconRes, $displayName)
        $registered[[string]$h] = $true
        Write-IconLog ('找到視窗 ' + $h + '，登記 App ID 結果 ' + $hr)
      }
      if ([SvnEditIcon]::Apply($h, $icon)) { $applied++; Write-IconLog ('已指定視窗圖標（視窗 ' + $h + '，累計第 ' + $applied + ' 次）') }
    }
  } elseif (-not $seen -and (Get-Date) -ge $deadline) {
    Write-IconLog '等不到視窗，放棄'
    break
  }
  Start-Sleep -Milliseconds 1500
}
`;

function applyWindowIconLater(): void {
  if (process.platform !== "win32" || process.env.SVN_EDIT_NO_LAUNCH === "1") return;
  const iconFile = ensureIconFile();
  if (!iconFile) return;
  const quote = (value: string): string => `"${value}"`;
  const isPackaged = Boolean((process as unknown as { pkg?: unknown }).pkg);
  const relaunch = isPackaged || !process.argv[1] ? quote(process.execPath) : `${quote(process.execPath)} ${quote(process.argv[1])}`;
  const psString = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const header = [
    `$title = ${psString(WINDOW_TITLE)}`,
    `$icon = ${psString(iconFile)}`,
    `$iconRes = ${psString(`${iconFile},0`)}`,
    `$relaunch = ${psString(relaunch)}`,
    `$displayName = ${psString(WINDOW_TITLE)}`,
    `$parentPid = ${process.pid}`,
    `$logFile = ${psString(path.join(path.dirname(iconFile), ICON_LOG_NAME))}`,
    "",
  ].join("\n");
  const script = header + WINDOW_ICON_SCRIPT.replace("__SECONDS__", String(ICON_APPLY_SECONDS));
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const logFile = path.join(path.dirname(iconFile), ICON_LOG_NAME);
  const log = (text: string): void => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} [svn-edit] ${text}\n`, "utf-8");
    } catch {
      // 記錄失敗不影響主流程
    }
  };
  try {
    // 只在記錄檔變大時才清空，平常保留，才看得到前幾次啟動的紀錄
    if (existsSync(logFile) && statSync(logFile).size > ICON_LOG_MAX_BYTES) writeFileSync(logFile, "", "utf-8");
  } catch {
    // 同上
  }
  log(`啟動圖標腳本（pid ${process.pid}）`);
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderrText = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrText.length < 2000) stderrText += chunk.toString("utf-8");
  });
  child.on("exit", (code) => log(`圖標腳本結束，結束碼 ${code}${stderrText.trim() ? `，錯誤輸出：${stderrText.trim().slice(0, 500)}` : ""}`));
  child.on("error", (e) => {
    log(`無法啟動 PowerShell：${e.message}`);
    console.error(`[svn-edit] 設定視窗圖標失敗：${e.message}`);
  });
  // 注意：不能加 detached:true。PowerShell 以「脫離主控台」方式啟動時會直接靜默不執行，圖標就永遠指定不上。
  child.unref();
}

// 把標題含有指定文字的可見視窗叫到最前面（還原最小化、按一下 Alt 讓背景程式可以搶前景）。標題以 base64 傳入，避免中文被命令列轉壞。
const ACTIVATE_SCRIPT = `
param([string]$TitleB64)
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleB64))
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SvnEditWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  public static bool Activate(string part) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString().Contains(part)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    if (IsIconic(found)) ShowWindow(found, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    BringWindowToTop(found);
    return SetForegroundWindow(found);
  }
}
'@
if ([SvnEditWin]::Activate($title)) { 'OK' } else { 'NOTFOUND' }
`;

/** 把已經開著的 svn-edit 視窗叫到最前面；回傳有沒有叫到（沒開著、或被 Windows 擋下都是 false）。 */
export function activateExistingWindow(title: string = WINDOW_TITLE): Promise<boolean> {
  if (process.platform !== "win32" || process.env.SVN_EDIT_NO_LAUNCH === "1") return Promise.resolve(false);
  const titleB64 = Buffer.from(title, "utf-8").toString("base64");
  // -EncodedCommand 要 UTF-16LE 的 base64；腳本裡的 param() 需要用 -File 才吃得到參數，所以把參數直接寫進腳本開頭
  const script = `$TitleB64 = '${titleB64}'\n${ACTIVATE_SCRIPT.replace("param([string]$TitleB64)\n", "")}`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: ACTIVATE_TIMEOUT_MS },
      (error, stdout) => resolve(!error && String(stdout).includes("OK"))
    );
  });
}
