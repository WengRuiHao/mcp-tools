import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");

export interface PythonToolResult {
  success: boolean;
  message?: string;
  [key: string]: unknown;
}

/**
 * 呼叫 scripts/ 底下的一支 python 腳本（docx_tool.py / xlsx_tool.py / pdf_tool.py），
 * 把 { action, ...params } 這個物件整個以 JSON 字串餵進腳本的 stdin，腳本印一行 JSON 到 stdout。
 * 這裡故意不用命令列參數傳遞（避免路徑/中文字元在 shell 層被誤斷字或編碼跑掉），全部走 stdin/stdout 的 JSON。
 */
export function runPythonTool(scriptName: string, payload: Record<string, unknown>): PythonToolResult {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  const result = spawnSync("python", [scriptPath], {
    cwd: SCRIPTS_DIR,
    encoding: "utf8",
    input: JSON.stringify(payload),
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.error) {
    return { success: false, message: `執行 ${scriptName} 失敗: ${result.error.message}` };
  }
  const stdout = (result.stdout ?? "").trim();
  if (!stdout) {
    return {
      success: false,
      message: `${scriptName} 沒有任何輸出 (exit ${result.status})\n${result.stderr ?? ""}`,
    };
  }
  try {
    return JSON.parse(stdout) as PythonToolResult;
  } catch {
    return { success: false, message: `${scriptName} 輸出不是合法 JSON:\n${stdout}\n${result.stderr ?? ""}` };
  }
}
