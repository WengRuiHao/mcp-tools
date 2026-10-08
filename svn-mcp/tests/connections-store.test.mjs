// svn-edit 設定頁用的連線設定讀寫：與 svn-mcp 唯讀工具共用同一份 svn-connections.json。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listPublicConnections, saveConnection, ConnectionInputError } from "../dist/connections-store.js";
import { getConnectionsFilePath } from "../dist/config-store.js";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "svn-conn-test-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** 每個測試用自己的設定檔路徑（放在還不存在的子目錄裡，順便驗證會自動建立目錄）。 */
function useFreshFile() {
  const file = path.join(root, `case${counter++}`, "info", "svn-connections.json");
  process.env.SVN_CONNECTIONS_FILE = file;
  return file;
}
const readRaw = (file) => JSON.parse(fs.readFileSync(file, "utf-8"));
const good = { name: "規格書庫", url: "https://svn.example.com/repo/", username: "alice", password: "s3cret" };

test("SVN_CONNECTIONS_FILE 環境變數決定設定檔路徑", () => {
  const file = useFreshFile();
  assert.equal(getConnectionsFilePath(), path.resolve(file));
});

test("新增連線：自動建立目錄、網址去掉結尾斜線、公開清單不含密碼", async () => {
  const file = useFreshFile();
  assert.deepEqual(await listPublicConnections(), []); // 檔案不存在視為沒有任何連線
  const saved = await saveConnection(good);
  assert.equal(saved.url, "https://svn.example.com/repo");
  assert.equal("password" in saved, false);
  const [listed] = await listPublicConnections();
  assert.deepEqual(Object.keys(listed).sort(), ["id", "name", "url", "username"]);
  assert.equal(readRaw(file)[0].password, "s3cret"); // 檔案裡有存，但不會從 API 出去
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["svn-connections.json"]); // 沒留下暫存檔
});

test("編輯連線：密碼留空代表不變更，並保留檔案裡其他未知欄位", async () => {
  const file = useFreshFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([{ id: "c1", name: "舊名", url: "https://a.example/r", username: "u1", password: "pw1", note: "人工加的欄位" }]));
  await saveConnection({ id: "c1", name: "新名", url: "https://a.example/r2", username: "u2", password: "" });
  assert.deepEqual(readRaw(file), [{ id: "c1", name: "新名", url: "https://a.example/r2", username: "u2", password: "pw1", note: "人工加的欄位" }]);
  await saveConnection({ id: "c1", name: "新名", url: "https://a.example/r2", username: "u2", password: "pw2" });
  assert.equal(readRaw(file)[0].password, "pw2");
});

test("不合法的輸入一律拒絕，且不動檔案", async () => {
  const file = useFreshFile();
  await saveConnection(good);
  const before = fs.readFileSync(file, "utf-8");
  const bad = [
    [{ ...good, name: " " }, /名稱/],
    [{ ...good, name: "x".repeat(61) }, /太長/],
    [{ ...good, name: "另一個", url: "file:///c:/repo" }, /網址/],
    [{ ...good, name: "另一個", url: "ftp://x/y" }, /網址/],
    [{ ...good, name: "另一個", username: "" }, /帳號/],
    [{ ...good, name: "另一個", password: "" }, /密碼/],
    [{ ...good }, /已經有名稱/], // 名稱重複
    [{ ...good, id: "不存在", name: "另一個" }, /找不到/],
  ];
  for (const [input, pattern] of bad) {
    await assert.rejects(saveConnection(input), (e) => e instanceof ConnectionInputError && pattern.test(e.message), JSON.stringify(input));
  }
  assert.equal(fs.readFileSync(file, "utf-8"), before);
});

test("設定檔壞掉（不是合法 JSON）時拒絕寫入，絕不覆蓋", async () => {
  const file = useFreshFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "[ 人工編輯到一半 {");
  await assert.rejects(saveConnection(good), /不是合法的 JSON/);
  await assert.rejects(listPublicConnections(), /不是合法的 JSON/);
  assert.equal(fs.readFileSync(file, "utf-8"), "[ 人工編輯到一半 {");
});

test("同時送出多個新增請求不會互相蓋掉", async () => {
  const file = useFreshFile();
  await Promise.all(["甲", "乙", "丙", "丁"].map((name) => saveConnection({ ...good, name })));
  assert.deepEqual(readRaw(file).map((c) => c.name).sort(), ["丁", "乙", "丙", "甲"].sort());
});

test("設定檔有 UTF-8 BOM 也讀得進來", async () => {
  const file = useFreshFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `\uFEFF${JSON.stringify([{ id: "c1", name: "bom", url: "https://a/b", username: "u", password: "p" }])}`);
  assert.equal((await listPublicConnections())[0].name, "bom");
});
