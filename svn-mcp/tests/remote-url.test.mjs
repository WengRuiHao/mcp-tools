// 「貼 SVN 網址直接跳到位置」：網址對應到專案與路徑，只讀取、不改動任何東西。
import test from "node:test";
import assert from "node:assert/strict";
import { createSvnFixture } from "./helpers/svn-fixture.mjs";
import { EditError } from "../dist/remote-edit-client.js";
import { resolveRemoteUrl } from "../dist/remote-url.js";

const { repoUrl, seed, svn } = createSvnFixture({ prefix: "svn-url-test-", v2: true });
const CONN = "s1:myrepo";

async function assertEditError(promise, code, pattern) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof EditError, `應該是 EditError，實際：${e?.constructor?.name}：${e?.message}`);
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

test("資料夾網址：回專案、路徑、kind=dir，要進入的就是這個資料夾", async () => {
  seed("u1/sub/a.md", "a");
  const r = await resolveRemoteUrl(`${repoUrl}/u1/sub`);
  assert.deepEqual([r.connection, r.path, r.kind, r.dir, r.fileName], [CONN, "u1/sub", "dir", "u1/sub", null]);
  assert.equal(r.connectionName, "myrepo");
});

test("檔案網址：回 kind=file，要進入的是所在資料夾，並帶檔名", async () => {
  seed("u2/sub/b.md", "b");
  const r = await resolveRemoteUrl(`${repoUrl}/u2/sub/b.md`);
  assert.deepEqual([r.path, r.kind, r.dir, r.fileName], ["u2/sub/b.md", "file", "u2/sub", "b.md"]);
});

test("中文與 %E4%... 編碼都能還原；結尾斜線、前後空白、?query、#fragment 都不影響", async () => {
  seed("u3/規格 文件/需求 說明.md", "x");
  const encoded = `${repoUrl}/u3/${encodeURIComponent("規格 文件")}/${encodeURIComponent("需求 說明.md")}`;
  const r = await resolveRemoteUrl(`  ${encoded}?p=1#top  `);
  assert.deepEqual([r.path, r.kind, r.dir, r.fileName], ["u3/規格 文件/需求 說明.md", "file", "u3/規格 文件", "需求 說明.md"]);
  const raw = await resolveRemoteUrl(`${repoUrl}/u3/規格 文件/`);
  assert.deepEqual([raw.path, raw.kind], ["u3/規格 文件", "dir"]);
});

test("專案根目錄網址：path 是空字串", async () => {
  const r = await resolveRemoteUrl(repoUrl + "/");
  assert.deepEqual([r.connection, r.path, r.kind, r.dir], [CONN, "", "dir", ""]);
});

test("專案網址本身的大小寫不同也認得（SVN 底下的子路徑仍分大小寫）", async () => {
  seed("u4/Folder/file.md", "x");
  const shouty = repoUrl.replace(/myrepo$/, "MYREPO");
  assert.notEqual(shouty, repoUrl);
  const r = await resolveRemoteUrl(`${shouty}/u4/Folder`);
  assert.deepEqual([r.connection, r.path, r.kind], [CONN, "u4/Folder", "dir"]);
  await assertEditError(resolveRemoteUrl(`${repoUrl}/u4/folder`), "NOT_FOUND", /找不到/);
});

test("拒絕：空白、不是網址、不是 SVN 協定、不在任何已設定專案底下、遠端找不到", async () => {
  await assertEditError(resolveRemoteUrl("   "), "INVALID_INPUT", /請貼上/);
  await assertEditError(resolveRemoteUrl("不是網址"), "INVALID_INPUT", /不是 SVN 網址/);
  await assertEditError(resolveRemoteUrl("ftp://example.com/x"), "INVALID_INPUT", /不是 SVN 網址/);
  await assertEditError(resolveRemoteUrl("https://svn.other-company.example/svn/proj/trunk"), "NOT_FOUND", /不在任何已設定/);
  await assertEditError(resolveRemoteUrl(`${repoUrl}/u5/ghost/none.md`), "NOT_FOUND", /找不到/);
});

test("只讀取：解析網址不會產生新的 revision", async () => {
  seed("u6/a.md", "a");
  const rev = () => svn("info", "--show-item", "revision", repoUrl);
  const before = rev();
  await resolveRemoteUrl(`${repoUrl}/u6/a.md`);
  await resolveRemoteUrl(`${repoUrl}/u6`);
  assert.equal(rev(), before);
});
