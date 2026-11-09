import { readFile, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { defaultRenderLoader } from "./loader.js";
import { RenderPathError, isInside, resolveInputFile, resolveOutputFile } from "./path-safety.js";
import type {
  Availability,
  BrowserLike,
  FailureReason,
  PageLike,
  PlaywrightLike,
  RenderHtmlOptions,
  RenderLoader,
  RenderMermaidOptions,
  RenderResult,
  RendererOptions,
  RouteLike,
  UnavailableReason,
} from "./types.js";

export const DEFAULT_RENDER_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_MERMAID_INPUT_BYTES = 1024 * 1024;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

type Feature = "html" | "mermaid" | "all";

const HINTS: Record<UnavailableReason, string> = {
  "playwright-not-installed":
    "尚未安裝 Playwright。請在 dev-pipeline-mcp 目錄執行 npm install playwright（選用），或改由 AI 用自己的瀏覽器工具截圖後再附上。",
  "browser-not-installed":
    "已安裝 Playwright 但尚未下載瀏覽器核心。請執行 npx playwright install chromium，或改由 AI 自行截圖後再附上。",
  "mermaid-not-installed":
    "尚未安裝 mermaid。請在 dev-pipeline-mcp 目錄執行 npm install mermaid（選用），或改由 AI 自行把流程圖轉成 PNG 後再附上。",
};

class RenderTimeoutError extends Error {}

const fail = (reason: FailureReason, hint: string): RenderResult => ({ ok: false, reason, hint });

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RenderTimeoutError(`逾時（${ms} ms）`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** 只放行 baseDir 內的 file:// 請求，其餘（含 http／https）一律擋掉。 */
function buildRouteHandler(realBase: string) {
  return async (route: RouteLike): Promise<void> => {
    const url = route.request().url();
    if (url.startsWith("file:")) {
      try {
        if (isInside(realBase, resolve(fileURLToPath(url)))) {
          await route.continue();
          return;
        }
      } catch {
        // 無法解析的 file URL 視為不允許
      }
    }
    await route.abort();
  };
}

interface Environment {
  playwright?: PlaywrightLike;
  script?: string;
  reason?: UnavailableReason;
}

export interface Renderer {
  isAvailable(feature?: Feature): Promise<Availability>;
  renderHtmlToPng(options: RenderHtmlOptions): Promise<RenderResult>;
  renderMermaidToPng(options: RenderMermaidOptions): Promise<RenderResult>;
}

export function createRenderer(loader: RenderLoader = defaultRenderLoader, options: RendererOptions = {}): Renderer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  async function checkEnvironment(feature: Feature): Promise<Environment> {
    let playwright: PlaywrightLike;
    try {
      playwright = await loader.loadPlaywright();
    } catch {
      return { reason: "playwright-not-installed" };
    }
    let installed = false;
    try {
      installed = await loader.isBrowserInstalled(playwright);
    } catch {
      installed = false;
    }
    if (!installed) return { reason: "browser-not-installed" };
    if (feature === "html") return { playwright };
    try {
      return { playwright, script: await loader.loadMermaidScript() };
    } catch {
      return { reason: "mermaid-not-installed" };
    }
  }

  async function isAvailable(feature: Feature = "all"): Promise<Availability> {
    const { reason } = await checkEnvironment(feature);
    return reason ? { available: false, reason, hint: HINTS[reason] } : { available: true };
  }

  /** 開瀏覽器、擋外網、執行 draw、截圖、檢查大小並寫檔；整體受逾時限制。 */
  async function capture(
    playwright: PlaywrightLike,
    realBase: string,
    outPath: string,
    viewport: { width: number; height: number } | undefined,
    draw: (page: PageLike) => Promise<{ fullPage: boolean }>,
  ): Promise<RenderResult> {
    let browser: BrowserLike | undefined;
    try {
      const work = (async (): Promise<RenderResult> => {
        browser = await playwright.chromium.launch({ headless: true });
        const page = await browser.newPage(viewport ? { viewport } : undefined);
        page.setDefaultTimeout?.(timeoutMs);
        await page.route("**/*", buildRouteHandler(realBase));
        const { fullPage } = await draw(page);
        const png = await page.screenshot({ fullPage, type: "png" });
        if (png.byteLength > maxOutputBytes) {
          return fail("output-too-large", `輸出 PNG 超過上限 ${maxOutputBytes} bytes，請縮小頁面或解析度。`);
        }
        await writeFile(outPath, png);
        return { ok: true, outPath, bytes: png.byteLength };
      })();
      work.catch(() => undefined); // 逾時後 work 若再失敗，不要變成未處理例外
      return await withTimeout(work, timeoutMs);
    } catch (err) {
      if (err instanceof RenderTimeoutError) return fail("timeout", `產圖逾時（${timeoutMs} ms），請簡化內容後重試。`);
      return fail("render-failed", `產圖失敗：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  async function safePaths(
    baseDir: string,
    input: string,
    out: string,
  ): Promise<{ input: string; out: string; realBase: string } | RenderResult> {
    try {
      const realBase = await realpath(resolve(baseDir));
      return { input: await resolveInputFile(baseDir, input), out: await resolveOutputFile(baseDir, out), realBase };
    } catch (err) {
      if (err instanceof RenderPathError) return fail(err.reason, err.message);
      return fail("invalid-path", `路徑檢查失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function renderHtmlToPng(opts: RenderHtmlOptions): Promise<RenderResult> {
    const paths = await safePaths(opts.baseDir, opts.htmlPath, opts.outPath);
    if ("ok" in paths) return paths;
    const env = await checkEnvironment("html");
    if (env.reason || !env.playwright) {
      const reason = env.reason ?? "playwright-not-installed";
      return fail(reason, HINTS[reason]);
    }
    const viewport = { width: opts.width ?? DEFAULT_WIDTH, height: opts.height ?? DEFAULT_HEIGHT };
    return capture(env.playwright, paths.realBase, paths.out, viewport, async (page) => {
      await page.goto(pathToFileURL(paths.input).href, { timeout: timeoutMs, waitUntil: "load" });
      return { fullPage: opts.fullPage ?? true };
    });
  }

  async function renderMermaidToPng(opts: RenderMermaidOptions): Promise<RenderResult> {
    const paths = await safePaths(opts.baseDir, opts.mmdPath, opts.outPath);
    if ("ok" in paths) return paths;
    const env = await checkEnvironment("mermaid");
    if (env.reason || !env.playwright || env.script === undefined) {
      const reason = env.reason ?? "playwright-not-installed";
      return fail(reason, HINTS[reason]);
    }
    const source = await readFile(paths.input, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_MERMAID_INPUT_BYTES) {
      return fail("input-too-large", "Mermaid 原始檔超過 1 MB 上限。");
    }
    const script = env.script;
    return capture(env.playwright, paths.realBase, paths.out, undefined, async (page) => {
      await page.setContent(
        '<!doctype html><html><body style="margin:16px;background:#fff"><div id="c"></div></body></html>',
      );
      await page.addScriptTag({ content: script });
      await page.evaluate(async (definition: string) => {
        // 在瀏覽器頁面內執行；以 any 存取全域，避免依賴 DOM 型別。
        const g = globalThis as any;
        g.mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
        const { svg } = await g.mermaid.render("dpm-diagram", definition);
        g.document.getElementById("c").innerHTML = svg;
      }, source);
      return { fullPage: true };
    });
  }

  return { isAvailable, renderHtmlToPng, renderMermaidToPng };
}
