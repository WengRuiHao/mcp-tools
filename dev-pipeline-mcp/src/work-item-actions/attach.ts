import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isInside } from "../render/path-safety.js";
import { WorkItemActionError, errorMessage, need, okReply, type ToolReply } from "./common.js";
import { loadWorkItem } from "./context.js";
import type { WorkItemArgs } from "./schema.js";

type DestDir = NonNullable<WorkItemArgs["destDir"]>;

const IMAGE_EXT = ["png", "jpg", "jpeg", "webp"];
const ALLOWED_EXT: Record<DestDir, readonly string[]> = {
  "sa-mockup": [...IMAGE_EXT, "html", "css", "js"],
  "sa-images": IMAGE_EXT,
  evidence: IMAGE_EXT,
  flow: ["png"],
  er: ["png"],
};
/** er：ER 圖 PNG 固定放 TableSchema/er/，檔名由 name 指定（<文件名>.png 或 system-er.png）。 */
const ER_DIR = "TableSchema/er";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_NAME_LEN = 80;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const FLOW_IMAGE_NAME = "flow.png";

/** 檔名淨化：不接受路徑；非字母數字與 ._- 換成底線、去前導點、限長、避開 Windows 保留字。 */
export function sanitizeAttachName(raw: string): string {
  if (/[\\/]/.test(raw)) throw new WorkItemActionError("name 不可含路徑分隔字元，只能是檔名。");
  const ext = path.extname(raw);
  const stem = raw.slice(0, raw.length - ext.length).replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._]+/, "").slice(0, MAX_NAME_LEN);
  const safeStem = !stem ? "file" : WINDOWS_RESERVED.test(stem) ? `${stem}_` : stem;
  return `${safeStem}${ext.replace(/[^A-Za-z0-9.]/g, "")}`;
}

async function assertRegularSource(src: string): Promise<number> {
  if (!path.isAbsolute(src)) throw new WorkItemActionError("srcPath 必須是絕對路徑。");
  const st = await lstat(src).catch(() => null);
  if (!st) throw new WorkItemActionError(`來源檔不存在：${src}`);
  if (st.isSymbolicLink()) throw new WorkItemActionError("來源檔是符號連結，拒絕複製。");
  if (!st.isFile()) throw new WorkItemActionError("srcPath 不是檔案。");
  return st.size;
}

export async function handleAttach(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId, srcPath, destDir } = need("attach", a, ["workItemId", "srcPath", "destDir"]);
  const size = await assertRegularSource(srcPath);
  const srcExt = path.extname(srcPath).slice(1).toLowerCase();
  const allowed = ALLOWED_EXT[destDir];
  if (!allowed.includes(srcExt)) throw new WorkItemActionError(`destDir=${destDir} 只接受副檔名：${allowed.join("、")}（收到「${srcExt || "無"}」）。`);
  const limit = IMAGE_EXT.includes(srcExt) ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
  if (size === 0) throw new WorkItemActionError("來源檔是空的。");
  if (size > limit) throw new WorkItemActionError(`來源檔太大（${size} bytes），上限 ${limit} bytes。`);
  if (destDir === "er" && !/^[A-Za-z0-9_-]+\.png$/.test(a.name?.trim() ?? "")) throw new WorkItemActionError("destDir=er 必須帶 name（ER 圖檔名，限英數字、底線與連字號，例如 orders.png 或 system-er.png）。");
  let fileName = FLOW_IMAGE_NAME;
  if (destDir !== "flow") {
    fileName = sanitizeAttachName(a.name?.trim() ? a.name.trim() : path.basename(srcPath));
    const nameExt = path.extname(fileName).slice(1).toLowerCase();
    if (nameExt !== srcExt) throw new WorkItemActionError(`存檔檔名的副檔名（${nameExt || "無"}）必須與來源檔一致（${srcExt}）。`);
  }
  const ctx = await loadWorkItem(workItemId);
  try {
    const target = destDir === "flow" ? ctx.dir : path.join(ctx.dir, destDir === "er" ? ER_DIR : destDir);
    await mkdir(target, { recursive: true });
    const realTarget = await realpath(target);
    const realDir = await realpath(ctx.dir);
    if (!isInside(realDir, realTarget)) throw new WorkItemActionError("目的資料夾經符號連結逃出工作項目目錄，拒絕寫入。");
    const dest = path.join(realTarget, fileName);
    if ((await lstat(dest).catch(() => null))?.isSymbolicLink()) throw new WorkItemActionError("目的檔是符號連結，拒絕覆寫。");
    await copyFile(srcPath, dest);
    const rel = path.relative(realDir, dest).split(path.sep).join("/");
    return okReply({ workItemId: ctx.id, savedAs: rel, bytes: size });
  } catch (e) {
    if (e instanceof WorkItemActionError) throw e;
    throw new WorkItemActionError(`複製失敗：${errorMessage(e)}`);
  }
}
