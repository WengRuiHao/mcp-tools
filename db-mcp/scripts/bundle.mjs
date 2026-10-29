// 把 tsc 編出的 dist/ 打成單檔 dist/index.bundle.js，啟動時不必載入上百個小檔，冷啟動從數秒降到不到 1 秒。
// 用法：npm run build && npm run bundle（或直接 npm run build:bundle）
import { build } from "esbuild";

await build({
  entryPoints: ["dist/index.js"],
  outfile: "dist/index.bundle.js",
  bundle: true,
  platform: "node",
  format: "esm",
  // 資料庫驅動（含原生模組）與 drivers/* 要維持執行期動態載入：打進去會讓 esbuild 把動態 import 提升成靜態，
  // 每次啟動都載入四種驅動，反而慢到 17～60 秒。
  external: ["pg", "mysql2", "mssql", "oracledb", "./drivers/*"],
  // ESM 打包後仍有依賴用 require()，補上 createRequire
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
  logLevel: "warning",
});
console.log("已產生 dist/index.bundle.js（驅動維持外部載入，需要 node_modules 內的 pg／mysql2／mssql／oracledb）");
