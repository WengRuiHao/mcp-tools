// 圖示：exe、視窗、網頁分頁用的是同一份資料；網址帶內容雜湊，換圖後 Edge 不會沿用快取的舊圖。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAVICON_ICO_BASE64 } from "../dist/edit-icon-data.js";
import { ICON_VERSION, renderPage } from "../dist/edit-ui.js";
import { createEditServer } from "../dist/edit-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const icoFile = fs.readFileSync(path.join(root, "assets", "totoro.ico"));

/** 讀出 ICO 裡每個尺寸的邊長。 */
function icoSizes(buf) {
  const count = buf.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => buf[6 + 16 * i] || 256);
}

test("內嵌的圖示資料跟 assets/totoro.ico 完全相同（exe 圖標與視窗／分頁圖標不會分岔）", () => {
  assert.ok(Buffer.from(FAVICON_ICO_BASE64, "base64").equals(icoFile), "請重新執行 python scripts/make-icons.py");
});

test("圖示包含常用尺寸（含高 DPI 工作列的 30／36／42 與 256）", () => {
  const sizes = icoSizes(icoFile);
  for (const need of [16, 20, 24, 30, 32, 36, 40, 42, 48, 64, 96, 128, 256]) assert.ok(sizes.includes(need), `缺少 ${need}px`);
});

test("頁面的圖示網址帶內容雜湊，且雜湊是固定格式", () => {
  assert.match(ICON_VERSION, /^[0-9a-f]{10}$/);
  const html = renderPage("tok");
  assert.ok(html.includes(`href="/favicon.png?v=${ICON_VERSION}"`));
  assert.ok(!html.includes("__ICON_VER__"));
});

test("伺服器的 /favicon.png 回傳 256x256 的統一大圖（Edge 視窗只拿網頁圖標縮放，不能是小尺寸）", async () => {
  const edit = createEditServer();
  await new Promise((resolve) => edit.server.listen(0, "127.0.0.1", resolve));
  const port = edit.server.address().port;
  try {
    const body = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: `/favicon.png?v=${ICON_VERSION}` }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], data: Buffer.concat(chunks) }));
      }).on("error", reject);
    });
    assert.equal(body.status, 200);
    assert.equal(body.type, "image/png");
    assert.equal(body.data.subarray(1, 4).toString(), "PNG");
    assert.equal(body.data.readUInt32BE(16), 256);
    assert.equal(body.data.readUInt32BE(20), 256);
  } finally {
    edit.server.close();
  }
});

test("伺服器帶 ?v= 的圖示請求會回傳同一份圖示資料", async () => {
  const edit = createEditServer();
  await new Promise((resolve) => edit.server.listen(0, "127.0.0.1", resolve));
  const port = edit.server.address().port;
  try {
    const body = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: `/favicon.ico?v=${ICON_VERSION}` }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], data: Buffer.concat(chunks) }));
      }).on("error", reject);
    });
    assert.equal(body.status, 200);
    assert.equal(body.type, "image/x-icon");
    assert.ok(body.data.equals(icoFile));
  } finally {
    edit.server.close();
  }
});
