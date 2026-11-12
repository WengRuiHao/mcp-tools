import { readdir } from "node:fs/promises";
import path from "node:path";

/** Bash 當機會在目前目錄留下 *.stackdump（例如 bash.exe.stackdump）。只看指定目錄的第一層，不遞迴（不會掃進 node_modules）。 */
async function stackdumpsIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".stackdump")).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** 工作項目目錄與專案目錄根殘留的 *.stackdump 絕對路徑（去重；目錄不存在視為沒有）。 */
export async function findStackdumps(itemDir: string, projectDir: string | null | undefined): Promise<string[]> {
  const dirs = [...new Set([itemDir, ...(projectDir ? [projectDir] : [])].map((d) => path.resolve(d)))];
  return (await Promise.all(dirs.map(stackdumpsIn))).flat();
}

/** 給 done 回傳用的警告文字；沒有殘留回 undefined。 */
export async function stackdumpWarning(itemDir: string, projectDir: string | null | undefined): Promise<string | undefined> {
  const found = await findStackdumps(itemDir, projectDir);
  if (found.length === 0) return undefined;
  return `發現 Bash 當機遺留的 stackdump 檔（${found.join("、")}）：代表先前有指令當機，請確認該指令是否真的執行完成，並刪除這些檔案（不擋交件）。`;
}
