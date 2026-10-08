/**
 * svn-mcp 啟動時順便確保 svn-edit 服務在跑（冪等）：先打 /health，沒有回應才以分離模式拉起。
 * svn-mcp 每個對話都會啟動一份（dev-pipeline 還會再開一份子程序），所以「已經在跑就什麼都不做」是必要的；
 * 固定埠號本身也保證同一時間只會有一個實例。
 *
 * 這個模組只負責「啟動另一個程式」，**不得引用任何寫入 SVN 的模組**（remote-edit 與 workcopy 那兩個），
 * 才不會讓 AI 呼叫端間接拿到寫入能力——`tests/read-only-surface.test.mjs` 會檢查 index.ts，
 * 而這個模組的 import 由 `tests/edit-autostart.test.mjs` 檢查。
 * 設定 `SVN_EDIT_AUTOSTART=0` 可關閉自動拉起。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSvnMcpRoot } from "./config-store.js";

const HEALTH_TIMEOUT_MS = 800;
const LAUNCHER_WAIT_MS = 30_000;

function getPort(): number {
  return Number(process.env.SVN_EDIT_PORT) || 8096;
}

/** 這個埠上跑的是不是 svn-edit（打 /health 並檢查回應內容，埠被別的東西占用不算）。 */
export function isEditServerRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: HEALTH_TIMEOUT_MS }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 && JSON.parse(body).service === "svn-edit");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

/** 優先用打包好的執行檔；沒有的話退而求其次，用目前這個 node 執行同目錄的 edit-main.js。 */
export function resolveLaunchCommand(): { command: string; args: string[] } | null {
  const exe = path.join(getSvnMcpRoot(), "dist-exe", process.platform === "win32" ? "svn-edit.exe" : "svn-edit");
  if (existsSync(exe)) return { command: exe, args: ["--no-open"] };
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "edit-main.js");
  if (existsSync(script)) return { command: process.execPath, args: [script, "--no-open"] };
  return null;
}

export async function ensureEditServer(): Promise<"already-running" | "started" | "disabled" | "unavailable"> {
  if (process.env.SVN_EDIT_AUTOSTART === "0") return "disabled";
  if (await isEditServerRunning(getPort())) return "already-running";
  const launch = resolveLaunchCommand();
  if (!launch) return "unavailable";
  const child = buildSpawn(launch);
  child.on("error", (e) => console.error(`[svn-mcp] 自動啟動 svn-edit 失敗：${e.message}`));
  child.unref();
  if (process.platform === "win32") await waitForExit(child, LAUNCHER_WAIT_MS);
  return "started";
}

/** 等啟動器（PowerShell）拉完服務後自己結束；卡住也不無限等。 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
  });
}

function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * 子程序絕不能握著 svn-mcp 自己的 stdout／stdin：那是 MCP 通訊管道，服務會活得比 MCP 久，握著它會讓
 * 等待管道結束的一方（Claude Code、dev-pipeline 管理子程序時）一直等不到結束。
 * 光設 `stdio: "ignore"` 在 Windows 上不夠——子程序仍可能繼承其他可繼承的控制代碼；所以 Windows 改由
 * PowerShell 的 Start-Process 建立（建立時不繼承控制代碼），PowerShell 自己拉完就結束。
 * `tests/edit-autostart.test.mjs` 有專門的測試鎖住「父程序結束後管道一定會關閉」。
 */
function buildSpawn(launch: { command: string; args: string[] }): ChildProcess {
  if (process.platform !== "win32") {
    return spawn(launch.command, launch.args, { detached: true, stdio: "ignore" });
  }
  const argumentList = launch.args.map((a) => quoteForPowerShell(quoteArg(a))).join(",");
  const script = `Start-Process -FilePath ${quoteForPowerShell(launch.command)} -ArgumentList ${argumentList} -WindowStyle Hidden`;
  // 不能加 detached：沒有主控台的 PowerShell 拉不起服務。代價是 Windows 上 Node 會把它放進「父程序結束就一起被殺」
  // 的 Job，所以呼叫端必須等它拉完（見 ensureEditServer）；Start-Process 拉出來的服務會脫離那個 Job，不會跟著結束。
  return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], { stdio: "ignore", windowsHide: true });
}
