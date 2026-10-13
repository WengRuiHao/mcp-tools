// 打包 svn-edit.exe / svn-http-bridge.exe，並把 assets/totoro.ico 設為 exe 圖標。
// 用法：node scripts/build-exe.mjs [edit|bridge|all] [輸出資料夾，預設 dist-exe]
//
// 圖標做法：pkg 會驗證自己快取的 Node 基底 hash，直接改快取會被它重新下載蓋掉；
// 所以複製一份基底、用 rcedit 改圖標，再以 PKG_NODE_PATH 指給 pkg（設了就跳過 hash 檢查）。
import { execFileSync } from "node:child_process";
import { closeSync, copyFileSync, mkdirSync, openSync, readSync, readdirSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { rcedit } = require("rcedit");

// gui：改成「視窗程式」，雙擊時不會跳出黑色主控台視窗（svn-edit 自己會開桌面視窗）；背景服務類的 exe 維持主控台程式。
const TARGETS = {
  edit: { entry: "dist/svn-edit.bundle.cjs", out: "svn-edit.exe", bundle: true, gui: true },
  bridge: { entry: "pkg/http-server.cjs", out: "svn-http-bridge.exe", bundle: false, gui: false },
};

const SUBSYSTEM_WINDOWS_GUI = 2;
/** 改 PE 檔頭的 Subsystem 欄位（選用標頭第 68 個位元組；32／64 位元格式位置相同）。 */
function setGuiSubsystem(file) {
  const fd = openSync(file, "r+");
  try {
    const dos = Buffer.alloc(64);
    readSync(fd, dos, 0, 64, 0);
    const peOffset = dos.readUInt32LE(0x3c);
    const sig = Buffer.alloc(4);
    readSync(fd, sig, 0, 4, peOffset);
    if (sig.toString("latin1") !== "PE\0\0") throw new Error(`不是有效的 PE 檔：${file}`);
    const subsystemOffset = peOffset + 24 + 68;
    const value = Buffer.alloc(2);
    value.writeUInt16LE(SUBSYSTEM_WINDOWS_GUI);
    writeSync(fd, value, 0, 2, subsystemOffset);
  } finally {
    closeSync(fd);
  }
}

const which = process.argv[2] ?? "all";
const outDir = resolve(process.argv[3] ?? "dist-exe");
if (which !== "all" && !TARGETS[which]) {
  console.error("用法：node scripts/build-exe.mjs [edit|bridge|all] [輸出資料夾]");
  process.exit(1);
}

const cacheDir = join(homedir(), ".pkg-cache", "v3.6");
const baseName = readdirSync(cacheDir).find((f) => /^fetched-.*-win-x64$/.test(f));
if (!baseName) {
  console.error(`找不到 pkg 基底執行檔（${cacheDir}），先正常跑一次 pkg 讓它下載`);
  process.exit(1);
}

const workDir = resolve("dist", ".exe-base");
mkdirSync(workDir, { recursive: true });
const iconBase = join(workDir, "node-win-x64-icon.exe");
copyFileSync(join(cacheDir, baseName), iconBase);
await rcedit(iconBase, { icon: resolve("assets/totoro.ico") });

mkdirSync(outDir, { recursive: true });
const run = (cmd, args, env = process.env) =>
  execFileSync(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32" });

for (const key of which === "all" ? Object.keys(TARGETS) : [which]) {
  const t = TARGETS[key];
  if (t.bundle) run("npm", ["run", "bundle:edit"]);
  run("npx", ["pkg", t.entry, "--targets", "node22-win-x64", "--output", join(outDir, t.out)], {
    ...process.env,
    PKG_NODE_PATH: iconBase,
  });
  if (t.gui) setGuiSubsystem(join(outDir, t.out));
  console.log(`已輸出 ${join(outDir, t.out)}${t.gui ? "（視窗程式，無主控台）" : ""}`);
}
