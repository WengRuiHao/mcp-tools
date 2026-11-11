// work_item：ER 圖相關（write 系統 ER 圖檔名、attach destDir=er、render 從 md 取 Mermaid 區塊）與圖片白名單。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv } from "./helpers/work-item-env.mjs";

const seen = [];
const renderer = {
  async isAvailable() { return { available: true }; },
  async renderHtmlToPng() { return { ok: false, reason: "timeout", hint: "x" }; },
  async renderMermaidToPng(o) {
    seen.push({ src: o.mmdPath, text: readFileSync(path.join(o.baseDir, o.mmdPath), "utf-8"), out: o.outPath });
    return { ok: true, outPath: o.outPath, bytes: 10 };
  },
};
const env = await setupEnv("wi-er-", { renderer });
const { id, dir } = await env.create();
const png = path.join(env.tmp, "x.png");
await writeFile(png, Buffer.from("89504e470d0a1a0a", "hex"));
after(() => env.cleanup());
const call = (a) => env.call({ workItemId: id, ...a });

test("write：系統 ER 圖 TableSchema/system-er.md 可寫；其他含連字號或變形的檔名與穿越拒絕", async () => {
  assert.equal((await call({ action: "write", filename: "TableSchema/system-er.md", content: "x" })).isError, false);
  assert.equal(readFileSync(path.join(dir, "TableSchema", "system-er.md"), "utf-8"), "x");
  for (const f of ["TableSchema/system-er2.md", "TableSchema/System-er.md", "TableSchema/system-er.md/", "TableSchema/../system-er.md", "TableSchema/er/system-er.md", "system-er.md", "TableSchema/a-b.md", "TableSchema\system-er.md"]) {
    assert.equal((await call({ action: "write", filename: f, content: "x" })).isError, true, f);
  }
});

test("attach destDir=er：存進 TableSchema/er/，name 必填且限 ASCII 檔名、副檔名一致，路徑穿越拒絕", async () => {
  const ok = await call({ action: "attach", srcPath: png, destDir: "er", name: "orders.png" });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(ok.json.savedAs, "TableSchema/er/orders.png");
  assert.equal(existsSync(path.join(dir, "TableSchema", "er", "orders.png")), true);
  assert.equal((await call({ action: "attach", srcPath: png, destDir: "er", name: "system-er.png" })).isError, false);
  for (const name of [undefined, "", "../x.png", "a/b.png", "中文.png", "x.jpg", "x", "..\\x.png"]) {
    assert.equal((await call({ action: "attach", srcPath: png, destDir: "er", ...(name === undefined ? {} : { name }) })).isError, true, String(name));
  }
  assert.equal(existsSync(path.join(path.dirname(dir), "x.png")), false);
});

test("render mermaid：src 為 TableSchema 內的 md 時取出唯一的 Mermaid 區塊轉圖，暫存檔轉完即刪", async () => {
  const fence = "```";
  await mkdir(path.join(dir, "TableSchema"), { recursive: true });
  writeFileSync(path.join(dir, "TableSchema", "orders.md"), `# x\n\n${fence}mermaid\nerDiagram\n  a {\n    INT id PK\n  }\n${fence}\n`);
  const r = await call({ action: "render", kind: "mermaid", src: "TableSchema/orders.md", out: "TableSchema/er/orders.png" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.ok, true);
  assert.match(seen.at(-1).text, /^erDiagram/);
  assert.match(seen.at(-1).src, /^TableSchema\/er\/\.render-[0-9a-f]+\.mmd$/);
  assert.equal(readdirSync(path.join(dir, "TableSchema", "er")).some((f) => f.startsWith(".render-")), false);
});

test("render mermaid：md 來源的限制（out 位置、沒有或多個區塊、檔案不存在、非白名單的 md）", async () => {
  const fence = "```";
  assert.equal((await call({ action: "render", kind: "mermaid", src: "TableSchema/orders.md", out: "flow.png" })).isError, true);
  assert.equal((await call({ action: "render", kind: "mermaid", src: "TableSchema/orders.md", out: "TableSchema/er/../x.png" })).isError, true);
  assert.equal((await call({ action: "render", kind: "mermaid", src: "TableSchema/none.md", out: "TableSchema/er/none.png" })).isError, true);
  writeFileSync(path.join(dir, "TableSchema", "two.md"), `${fence}mermaid\nerDiagram\n${fence}\n${fence}mermaid\nerDiagram\n${fence}\n`);
  assert.equal((await call({ action: "render", kind: "mermaid", src: "TableSchema/two.md", out: "TableSchema/er/two.png" })).isError, true);
  const before = seen.length;
  const r = await call({ action: "render", kind: "mermaid", src: "01-sa.md", out: "flow.png" });
  assert.equal(r.isError, true);
  assert.equal(seen.length, before);
});
