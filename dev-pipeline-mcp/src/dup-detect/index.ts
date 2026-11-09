// S11 自動重複程式碼偵測模組（內建、無外部依賴；尚未接到任何 MCP 工具）。
export { detectDuplicates, isTestPath, resolveOptions, type DetectInput } from "./detect.js";
export { formatDupReport } from "./report.js";
export { getChangedFiles } from "./changed-files.js";
export { normalizeSource, stripComments, SUPPORTED_EXTENSIONS } from "./normalize.js";
export { applyWaivers, isValidWaiver, MIN_WAIVER_REASON_CHARS } from "./waivers.js";
export * from "./types.js";
