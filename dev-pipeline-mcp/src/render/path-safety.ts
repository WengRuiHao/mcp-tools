import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

export class RenderPathError extends Error {
  constructor(
    readonly reason: "invalid-path" | "invalid-extension" | "input-not-found",
    message: string,
  ) {
    super(message);
  }
}

export function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function nearestExistingRealPath(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new RenderPathError("invalid-path", "路徑無有效上層目錄");
      current = parent;
    }
  }
}

/** 輸入檔：必須存在、是檔案，且真實路徑（解開符號連結後）在 baseDir 內。 */
export async function resolveInputFile(baseDir: string, file: string): Promise<string> {
  const realBase = await realpath(resolve(baseDir));
  const lexical = resolve(realBase, file);
  if (!isInside(realBase, lexical)) throw new RenderPathError("invalid-path", "輸入路徑超出 baseDir");
  let real: string;
  try {
    real = await realpath(lexical);
  } catch {
    throw new RenderPathError("input-not-found", "輸入檔不存在");
  }
  if (!isInside(realBase, real)) throw new RenderPathError("invalid-path", "輸入路徑經符號連結逃出 baseDir");
  if (!(await stat(real)).isFile()) throw new RenderPathError("input-not-found", "輸入路徑不是檔案");
  return real;
}

/** 輸出檔：副檔名必須 .png，上層真實目錄在 baseDir 內，且目標本身不可是符號連結。 */
export async function resolveOutputFile(baseDir: string, file: string): Promise<string> {
  if (extname(file).toLowerCase() !== ".png") {
    throw new RenderPathError("invalid-extension", "輸出檔副檔名必須是 .png");
  }
  const realBase = await realpath(resolve(baseDir));
  const lexical = resolve(realBase, file);
  if (!isInside(realBase, lexical)) throw new RenderPathError("invalid-path", "輸出路徑超出 baseDir");
  const realAncestor = await nearestExistingRealPath(dirname(lexical));
  if (!isInside(realBase, realAncestor)) {
    throw new RenderPathError("invalid-path", "輸出目錄經符號連結逃出 baseDir");
  }
  await mkdir(dirname(lexical), { recursive: true });
  if (!isInside(realBase, await realpath(dirname(lexical)))) {
    throw new RenderPathError("invalid-path", "輸出目錄經符號連結逃出 baseDir");
  }
  try {
    if ((await lstat(lexical)).isSymbolicLink()) {
      throw new RenderPathError("invalid-path", "輸出檔不可是符號連結");
    }
  } catch (err) {
    if (err instanceof RenderPathError) throw err;
  }
  return lexical;
}
