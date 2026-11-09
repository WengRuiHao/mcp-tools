// 選用產圖功能的最小介面型別：不依賴 playwright／mermaid 的型別宣告，沒安裝也能編譯。

export interface RouteLike {
  request(): { url(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}

export interface PageLike {
  route(pattern: string, handler: (route: RouteLike) => unknown): Promise<void>;
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  setContent(html: string, options?: { timeout?: number }): Promise<void>;
  addScriptTag(options: { content: string }): Promise<unknown>;
  evaluate<T>(fn: (arg: string) => T | Promise<T>, arg: string): Promise<T>;
  screenshot(options: { fullPage?: boolean; type: "png" }): Promise<Uint8Array>;
  setDefaultTimeout?(ms: number): void;
}

export interface BrowserLike {
  newPage(options?: { viewport?: { width: number; height: number } }): Promise<PageLike>;
  close(): Promise<void>;
}

export interface PlaywrightLike {
  chromium: {
    launch(options?: { headless?: boolean }): Promise<BrowserLike>;
    executablePath?(): string;
  };
}

/** 可注入的載入器：測試用假的，正式用動態 import。 */
export interface RenderLoader {
  /** 載入 playwright；沒安裝要拋錯。 */
  loadPlaywright(): Promise<PlaywrightLike>;
  /** 瀏覽器核心是否已下載。 */
  isBrowserInstalled(playwright: PlaywrightLike): Promise<boolean>;
  /** 讀取本機 mermaid 的 dist 腳本內容；沒安裝要拋錯。 */
  loadMermaidScript(): Promise<string>;
}

export type UnavailableReason =
  | "playwright-not-installed"
  | "browser-not-installed"
  | "mermaid-not-installed";

export type FailureReason =
  | UnavailableReason
  | "invalid-path"
  | "invalid-extension"
  | "input-not-found"
  | "input-too-large"
  | "timeout"
  | "output-too-large"
  | "render-failed";

export interface Availability {
  available: boolean;
  reason?: UnavailableReason;
  hint?: string;
}

export type RenderResult =
  | { ok: true; outPath: string; bytes: number }
  | { ok: false; reason: FailureReason; hint: string };

export interface RenderHtmlOptions {
  baseDir: string;
  htmlPath: string;
  outPath: string;
  width?: number;
  height?: number;
  fullPage?: boolean;
}

export interface RenderMermaidOptions {
  baseDir: string;
  mmdPath: string;
  outPath: string;
}

export interface RendererOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}
