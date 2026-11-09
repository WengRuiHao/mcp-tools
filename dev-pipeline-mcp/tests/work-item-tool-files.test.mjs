// work_item：write 白名單、attach 安全檢查、render 可用／不可用。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv } from "./helpers/work-item-env.mjs";

const calls = [];
const fakeRenderer = {
  available: true,
  async isAvailable() {
    return this.available ? { available: true } : { available: false, reason: "playwright-not-installed", hint: "尚未安裝 Playwright" };
  },
  async renderHtmlToPng(o) { calls.push(["html", o]); return { ok: true, outPath: o.outPath, bytes: 1234 }; },
  async renderMermaidToPng(o) { calls.push(["mermaid", o]); return { ok: false, reason: "timeout", hint: "逾時" }; },
};
const env = await setupEnv("wi-files-", { renderer: fakeRenderer });
const { id, dir } = await env.create();
const srcDir = path.join(env.tmp, "src");
await mkdir(srcDir, { recursive: true });
const png = path.join(srcDir, "shot.png");
await writeFile(png, Buffer.from("89504e47", "hex"));
after(() => env.cleanup());

test("write：只能寫流程定義的產出檔，寫入後不自動完成", async () => {
  for (const f of ["01-sa.md", "02-db.sql", "02-db.md", "flow.mmd", "03-sd.md", "spec-check.md", "impl-fe.md", "impl-be.md", "verify.md", "test.md", "baseline.md", "impact.md"]) {
    const r = await env.call({ action: "write", workItemId: id, filename: f, content: `內容 ${f}` });
    assert.equal(r.isError, false, f);
    assert.equal(readFileSync(path.join(dir, f), "utf-8"), `內容 ${f}`);
  }
  const g = await env.call({ action: "get", workItemId: id });
  assert.deepEqual(g.json.doneRoles, []);
});

test("write：路徑穿越、子路徑、非白名單檔名、過大內容、缺 content 都拒絕", async () => {
  for (const f of ["../evil.md", "..\\evil.md", "sa-images/x.md", "status.json", "item.md", "flow.png", "C:\\x.md", "/etc/x.md", "01-sa.md/"]) {
    const r = await env.call({ action: "write", workItemId: id, filename: f, content: "x" });
    assert.equal(r.isError, true, f);
  }
  assert.equal(existsSync(path.join(path.dirname(dir), "evil.md")), false);
  const big = await env.call({ action: "write", workItemId: id, filename: "01-sa.md", content: "a".repeat(512 * 1024 + 1) });
  assert.equal(big.isError, true);
  assert.match(big.json.message, /太大/);
  assert.equal((await env.call({ action: "write", workItemId: id, filename: "01-sa.md" })).isError, true);
});

test("attach：複製到 sa-images／evidence／sa-mockup，flow 目的地固定為 flow.png", async () => {
  const a = await env.call({ action: "attach", workItemId: id, srcPath: png, destDir: "sa-images", name: "登入 畫面.png" });
  assert.equal(a.isError, false);
  assert.ok(existsSync(path.join(dir, a.json.savedAs)));
  assert.match(a.json.savedAs, /^sa-images\//);
  assert.equal((await env.call({ action: "attach", workItemId: id, srcPath: png, destDir: "evidence" })).json.savedAs, "evidence/shot.png");
  assert.equal((await env.call({ action: "attach", workItemId: id, srcPath: png, destDir: "flow", name: "whatever.png" })).json.savedAs, "flow.png");
  const html = path.join(srcDir, "m.html");
  await writeFile(html, "<html></html>");
  assert.equal((await env.call({ action: "attach", workItemId: id, srcPath: html, destDir: "sa-mockup" })).json.savedAs, "sa-mockup/m.html");
});

test("attach：副檔名依 destDir 限制、name 不可含路徑、來源必須是存在的絕對路徑檔案", async () => {
  const html = path.join(srcDir, "m.html");
  assert.equal((await env.call({ action: "attach", workItemId: id, srcPath: html, destDir: "sa-images" })).isError, true);
  assert.equal((await env.call({ action: "attach", workItemId: id, srcPath: html, destDir: "flow" })).isError, true);
  const exe = path.join(srcDir, "a.exe");
  await writeFile(exe, "x");
  assert.equal((await env.call({ action: "attach", workItemId: id, srcPath: exe, destDir: "evidence" })).isError, true);
  for (const name of ["../x.png", "a/b.png", "..\\x.png"]) {
    assert.equal((await env.call({ action: "attach", workItemId: id, srcPath: png, destDir: "evidence", name })).isError, true, name);
  }
  assert.equal((await env.call({ action: "attach", workItemId: id, srcPath: png, destDir: "evidence", name: "x.jpg" })).isError, true);
  assert.equal((await env.call({ action: "attach", workItemId: id, srcPath: path.join(srcDir, "no.png"), destDir: "evidence" })).isError, true);
  assert.equal((await env.call({ action: "attach", workItemId: id, srcPath: srcDir, destDir: "evidence" })).isError, true);
  assert.equal((await env.call({ action: "attach", workItemId: id, srcPath: "shot.png", destDir: "evidence" })).isError, true);
  const empty = path.join(srcDir, "empty.png");
  await writeFile(empty, "");
  assert.equal((await env.call({ action: "attach", workItemId: id, srcPath: empty, destDir: "evidence" })).isError, true);
});

test("attach：名稱淨化；符號連結來源被拒絕", async () => {
  const r = await env.call({ action: "attach", workItemId: id, srcPath: png, destDir: "evidence", name: "a:b*c?.png" });
  assert.equal(r.isError, false);
  assert.match(r.json.savedAs, /^evidence\/a_b_c_\.png$/);
  const link = path.join(srcDir, "link.png");
  try { symlinkSync(png, link); } catch { return; } // 無權限建立符號連結的環境略過
  const bad = await env.call({ action: "attach", workItemId: id, srcPath: link, destDir: "evidence" });
  assert.equal(bad.isError, true);
  assert.match(bad.json.message, /符號連結/);
});

test("render：可用時渲染並回位元組數；baseDir 為工作項目目錄", async () => {
  const r = await env.call({ action: "render", workItemId: id, kind: "html", src: "sa-mockup/m.html", out: "sa-images/m.png" });
  assert.equal(r.isError, false);
  assert.equal(r.json.bytes, 1234);
  assert.equal(calls.at(-1)[1].baseDir, dir);
});

test("render：不可用或失敗回 ok:false 與 hint（引導 attach），缺參數回 isError", async () => {
  fakeRenderer.available = false;
  const r = await env.call({ action: "render", workItemId: id, kind: "html", src: "a.html", out: "a.png" });
  assert.equal(r.json.ok, false);
  assert.match(r.json.hint, /attach/);
  fakeRenderer.available = true;
  const f = await env.call({ action: "render", workItemId: id, kind: "mermaid", src: "flow.mmd", out: "flow.png" });
  assert.equal(f.json.ok, false);
  assert.equal(f.json.reason, "timeout");
  assert.equal((await env.call({ action: "render", workItemId: id, kind: "html" })).isError, true);
});
