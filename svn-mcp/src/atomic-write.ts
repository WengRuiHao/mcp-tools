/**
 * 原子寫檔：先寫同目錄的暫存檔再改名，讀的人永遠不會讀到寫到一半的內容。
 *
 * Windows 上「改名蓋掉既有檔案」偶爾會因為防毒軟體正在掃描、或剛好有人在讀而短暫失敗（EPERM／EBUSY／EACCES），
 * 過一下就會好，所以失敗時稍等重試幾次再放棄；暫存檔在最後失敗時會清掉，不留垃圾。
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
const MAX_ATTEMPTS = 8;

export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, content, "utf-8");
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(tmp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "";
        if (!RETRYABLE.has(code) || attempt >= MAX_ATTEMPTS) throw e;
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}
