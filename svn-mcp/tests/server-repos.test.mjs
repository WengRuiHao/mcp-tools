// 伺服器（上層網址）→ repo 清單解析，以及展開成一般 repo 連線的規則。不連網路。
import test from "node:test";
import assert from "node:assert/strict";
import { parseRepoIndex } from "../dist/server-repos.js";
import { expandConnections, repoConnectionId } from "../dist/connection-expand.js";

const SAMPLE = `<?xml version="1.0"?>
<svn version="1.10.6 (r1863367)" href="http://subversion.apache.org/">
  <index rev="0" path="Collection of Repositories">
    <dir name="zeta" href="zeta/" />
    <dir name="規格 &amp; 設計" href="%e8%a6%8f/" />
    <dir name="alpha" href="alpha/" />
    <dir name="alpha" href="alpha/" />
  </index>
</svn>`;

test("parseRepoIndex 取出 repo 名稱、解碼 XML、去重並排序", () => {
  assert.deepEqual(parseRepoIndex(SAMPLE), ["alpha", "zeta", "規格 & 設計"]);
});

test("parseRepoIndex 遇到不是 SVN 索引的內容回 null", () => {
  assert.equal(parseRepoIndex("<html><body>hello</body></html>"), null);
  assert.equal(parseRepoIndex(""), null);
});

test("parseRepoIndex 不把單一 repo 內部的目錄索引當成伺服器", () => {
  const repoIndex = '<svn version="1.10.6" href="http://subversion.apache.org/"><index rev="1483" path="/" base="trunk"><dir name="2-PM" href="2-PM/" /></index></svn>';
  assert.equal(parseRepoIndex(repoIndex), null);
});

const server = { id: "srv1", name: "S", url: "https://svn.example.com/svn/", username: "bob", password: "pw", kind: "server", repos: ["alpha", "beta"] };

test("伺服器項目展開成每個 repo 一筆連線，共用帳密", () => {
  const list = expandConnections([server]);
  assert.deepEqual(list.map((c) => c.name), ["alpha", "beta"]);
  assert.equal(list[0].url, "https://svn.example.com/svn/alpha");
  assert.equal(list[0].id, repoConnectionId("srv1", "alpha"));
  assert.equal(list[0].username, "bob");
  assert.equal(list[0].password, "pw");
});

test("使用者明確登記的一般連線優先，同名或同網址的 repo 不重複", () => {
  const own = { id: "c1", name: "我的 alpha", url: "https://SVN.example.com/svn/alpha", username: "alice", password: "x" };
  const list = expandConnections([server, own]);
  assert.deepEqual(list.map((c) => c.name), ["我的 alpha", "beta"]);
  assert.equal(list[0].username, "alice");
});

test("沒有載入過 repo 的伺服器不產生任何連線", () => {
  assert.deepEqual(expandConnections([{ ...server, repos: undefined }]), []);
});
