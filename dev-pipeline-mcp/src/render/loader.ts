import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { PlaywrightLike, RenderLoader } from "./types.js";

// 用變數當套件名稱：TypeScript 不會解析型別，沒安裝套件也不影響編譯。
const PLAYWRIGHT_PACKAGE = "playwright";
const MERMAID_PACKAGE = "mermaid";
const MERMAID_DIST_FILE = join("dist", "mermaid.min.js");

async function loadPlaywright(): Promise<PlaywrightLike> {
  const mod = (await import(PLAYWRIGHT_PACKAGE)) as { default?: PlaywrightLike } & Partial<PlaywrightLike>;
  const candidate = (mod.chromium ? mod : mod.default) as PlaywrightLike | undefined;
  if (!candidate?.chromium) throw new Error("playwright 模組缺少 chromium");
  return candidate;
}

async function isBrowserInstalled(playwright: PlaywrightLike): Promise<boolean> {
  try {
    const exe = playwright.chromium.executablePath?.();
    return typeof exe === "string" && exe.length > 0 && existsSync(exe);
  } catch {
    return false;
  }
}

/** 由 mermaid 入口往上找到套件根目錄，再讀 dist/mermaid.min.js（避開 exports 限制）。 */
async function loadMermaidScript(): Promise<string> {
  const require = createRequire(import.meta.url);
  let dir = dirname(require.resolve(MERMAID_PACKAGE));
  for (let i = 0; i < 8; i += 1) {
    const pkgFile = join(dir, "package.json");
    if (existsSync(pkgFile)) {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { name?: string };
      if (pkg.name === MERMAID_PACKAGE) return readFileSync(join(dir, MERMAID_DIST_FILE), "utf8");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("找不到 mermaid 套件根目錄");
}

export const defaultRenderLoader: RenderLoader = {
  loadPlaywright,
  isBrowserInstalled,
  loadMermaidScript,
};
