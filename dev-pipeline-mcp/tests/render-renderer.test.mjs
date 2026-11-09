// S8b：選用產圖功能。只用注入的假 loader，不需要安裝 Playwright／mermaid。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";
import { createRenderer } from "../dist/render/index.js";

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5]);

/** 假 loader：calls 記錄頁面操作，可個別設定缺什麼。 */
function fakeLoader(opts = {}) {
  const calls = { routes: [], gotos: [], scripts: 0, closed: 0, handlers: [] };
  const page = {
    async route(pattern, handler) { calls.routes.push(pattern); calls.handlers.push(handler); },
    async goto(url) {
      calls.gotos.push(url);
      if (opts.hang) await new Promise(() => {});
    },
    async setContent() {},
    async addScriptTag() { calls.scripts += 1; },
    async evaluate() {},
    async screenshot() { return opts.png ?? PNG; },
  };
  const playwright = {
    chromium: { async launch() { return { async newPage() { return page; }, async close() { calls.closed += 1; } }; } },
  };
  const loader = {
    async loadPlaywright() { if (opts.noPlaywright) throw new Error("x"); return playwright; },
    async isBrowserInstalled() { return !opts.noBrowser; },
    async loadMermaidScript() { if (opts.noMermaid) throw new Error("x"); return "/*mermaid*/"; },
  };
  return { loader, calls };
}

function setup() {
  const base = makeTmpDir("dpm-render-");
  fs.writeFileSync(path.join(base, "a.html"), "<p>hi</p>");
  fs.writeFileSync(path.join(base, "flow.mmd"), "graph TD; A-->B;");
  return base;
}

test("isAvailable：全部齊備為 available", async () => {
  const { loader } = fakeLoader();
  assert.deepEqual(await createRenderer(loader).isAvailable(), { available: true });
});

for (const [flag, reason, pattern] of [
  ["noPlaywright", "playwright-not-installed", /Playwright/],
  ["noBrowser", "browser-not-installed", /playwright install/],
  ["noMermaid", "mermaid-not-installed", /mermaid/],
]) {
  test(`isAvailable：${reason} 附繁體中文提示`, async () => {
    const { loader } = fakeLoader({ [flag]: true });
    const r = await createRenderer(loader).isAvailable();
    assert.equal(r.available, false);
    assert.equal(r.reason, reason);
    assert.match(r.hint, pattern);
    assert.match(r.hint, /安裝|下載|截圖/);
  });
}

test("缺 mermaid 時 HTML 渲染仍可用，Mermaid 渲染回 ok:false 不拋錯", async () => {
  const base = setup();
  try {
    const { loader } = fakeLoader({ noMermaid: true });
    const r = createRenderer(loader);
    assert.equal((await r.isAvailable("html")).available, true);
    const html = await r.renderHtmlToPng({ baseDir: base, htmlPath: "a.html", outPath: "a.png" });
    assert.equal(html.ok, true);
    const mmd = await r.renderMermaidToPng({ baseDir: base, mmdPath: "flow.mmd", outPath: "f.png" });
    assert.equal(mmd.ok, false);
    assert.equal(mmd.reason, "mermaid-not-installed");
  } finally { removeDir(base); }
});

test("不可用時回 ok:false 與 hint，且不產生檔案", async () => {
  const base = setup();
  try {
    const r = createRenderer(fakeLoader({ noPlaywright: true }).loader);
    const res = await r.renderHtmlToPng({ baseDir: base, htmlPath: "a.html", outPath: "a.png" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "playwright-not-installed");
    assert.ok(res.hint.length > 0);
    assert.equal(fs.existsSync(path.join(base, "a.png")), false);
  } finally { removeDir(base); }
});

test("可用：擋外網 route、goto file://、回傳位元組數並寫檔", async () => {
  const base = setup();
  try {
    const { loader, calls } = fakeLoader();
    const res = await createRenderer(loader).renderHtmlToPng({ baseDir: base, htmlPath: "a.html", outPath: "out/a.png" });
    assert.equal(res.ok, true);
    assert.equal(res.bytes, PNG.byteLength);
    assert.equal(fs.readFileSync(res.outPath).length, PNG.byteLength);
    assert.equal(calls.routes.length, 1);
    assert.match(calls.gotos[0], /^file:/);
    assert.equal(calls.closed, 1);

    // 路由處理：http／https 與 baseDir 外的 file 都 abort，baseDir 內 file 放行
    const seen = [];
    const mkRoute = (url) => ({ request: () => ({ url: () => url }), abort: async () => seen.push(["abort", url]), continue: async () => seen.push(["continue", url]) });
    const inside = pathToFileURL(path.join(fs.realpathSync.native(base), "a.html")).href;
    const outside = pathToFileURL(path.join(path.dirname(fs.realpathSync.native(base)), "zzz.html")).href;
    for (const u of ["http://evil.test/x", "https://evil.test/x", outside, inside]) await calls.handlers[0](mkRoute(u));
    assert.deepEqual(seen.map((s) => s[0]), ["abort", "abort", "abort", "continue"]);
  } finally { removeDir(base); }
});

test("Mermaid 可用：載入本機腳本並回傳位元組數", async () => {
  const base = setup();
  try {
    const { loader, calls } = fakeLoader();
    const res = await createRenderer(loader).renderMermaidToPng({ baseDir: base, mmdPath: "flow.mmd", outPath: "flow.png" });
    assert.equal(res.ok, true);
    assert.equal(res.bytes, PNG.byteLength);
    assert.equal(calls.scripts, 1);
    assert.equal(calls.routes.length, 1);
  } finally { removeDir(base); }
});

test("路徑穿越、baseDir 之外、非 .png 皆被拒", async () => {
  const base = setup();
  const outside = makeTmpDir("dpm-render-out-");
  fs.writeFileSync(path.join(outside, "x.html"), "x");
  try {
    const r = createRenderer(fakeLoader().loader);
    const cases = [
      [{ htmlPath: "../x.html", outPath: "a.png" }, "invalid-path"],
      [{ htmlPath: path.join(outside, "x.html"), outPath: "a.png" }, "invalid-path"],
      [{ htmlPath: "a.html", outPath: "../evil.png" }, "invalid-path"],
      [{ htmlPath: "a.html", outPath: path.join(outside, "evil.png") }, "invalid-path"],
      [{ htmlPath: "a.html", outPath: "a.jpg" }, "invalid-extension"],
      [{ htmlPath: "a.html", outPath: "a" }, "invalid-extension"],
      [{ htmlPath: "missing.html", outPath: "a.png" }, "input-not-found"],
    ];
    for (const [args, reason] of cases) {
      const res = await r.renderHtmlToPng({ baseDir: base, ...args });
      assert.equal(res.ok, false, JSON.stringify(args));
      assert.equal(res.reason, reason, JSON.stringify(args));
    }
    const m = await r.renderMermaidToPng({ baseDir: base, mmdPath: "../x.mmd", outPath: "a.png" });
    assert.equal(m.reason, "invalid-path");
    assert.equal(fs.existsSync(path.join(outside, "evil.png")), false);
  } finally { removeDir(base); removeDir(outside); }
});

test("符號連結逃逸被拒（平台不允許建立連結時略過）", async (t) => {
  const base = setup();
  const outside = makeTmpDir("dpm-render-out-");
  fs.writeFileSync(path.join(outside, "x.html"), "x");
  try {
    let dirLink = false;
    let fileLink = false;
    try { fs.symlinkSync(outside, path.join(base, "linkdir"), "junction"); dirLink = true; } catch { /* 略過 */ }
    try { fs.symlinkSync(path.join(outside, "x.html"), path.join(base, "link.html"), "file"); fileLink = true; } catch { /* 略過 */ }
    if (!dirLink && !fileLink) {
      t.skip("此平台無法建立符號連結（需要權限），略過");
      return;
    }
    const r = createRenderer(fakeLoader().loader);
    if (fileLink) {
      const a = await r.renderHtmlToPng({ baseDir: base, htmlPath: "link.html", outPath: "a.png" });
      assert.equal(a.reason, "invalid-path");
    }
    if (dirLink) {
      const b = await r.renderHtmlToPng({ baseDir: base, htmlPath: "linkdir/x.html", outPath: "a.png" });
      assert.equal(b.reason, "invalid-path");
      const c = await r.renderHtmlToPng({ baseDir: base, htmlPath: "a.html", outPath: "linkdir/evil.png" });
      assert.equal(c.reason, "invalid-path");
      assert.equal(fs.existsSync(path.join(outside, "evil.png")), false);
    }
  } finally { removeDir(base); removeDir(outside); }
});

test("逾時回 timeout 且會關閉瀏覽器", async () => {
  const base = setup();
  try {
    const { loader, calls } = fakeLoader({ hang: true });
    const res = await createRenderer(loader, { timeoutMs: 50 }).renderHtmlToPng({ baseDir: base, htmlPath: "a.html", outPath: "a.png" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "timeout");
    assert.equal(calls.closed, 1);
  } finally { removeDir(base); }
});

test("輸出超過大小上限回 output-too-large 且不寫檔", async () => {
  const base = setup();
  try {
    const { loader } = fakeLoader();
    const res = await createRenderer(loader, { maxOutputBytes: 4 }).renderHtmlToPng({ baseDir: base, htmlPath: "a.html", outPath: "a.png" });
    assert.equal(res.reason, "output-too-large");
    assert.equal(fs.existsSync(path.join(base, "a.png")), false);
  } finally { removeDir(base); }
});

test("瀏覽器操作拋錯時回 render-failed 而非拋出", async () => {
  const base = setup();
  try {
    const { loader } = fakeLoader();
    const bad = { ...loader, async loadPlaywright() { return { chromium: { async launch() { throw new Error("boom"); } } }; } };
    const res = await createRenderer(bad).renderHtmlToPng({ baseDir: base, htmlPath: "a.html", outPath: "a.png" });
    assert.equal(res.reason, "render-failed");
    assert.match(res.hint, /boom/);
  } finally { removeDir(base); }
});
