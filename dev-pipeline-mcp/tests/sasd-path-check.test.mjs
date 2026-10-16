// register_sasd_config 的 saRoot／sdRoot 檢查：語法（正斜線、相對於 repo 根）＋ 實際在 SVN 上存在。
import test from "node:test";
import assert from "node:assert/strict";
import { findSvnRootSyntaxProblem, verifySvnRoots } from "../dist/sasd-path-check.js";

test("語法：正常的相對路徑通過（含中文、括號、空白）", () => {
  assert.equal(findSvnRootSyntaxProblem("2-SA/6-需求規格書(前端SPEC)"), null);
  assert.equal(findSvnRootSyntaxProblem("doc/sa"), null);
  assert.equal(findSvnRootSyntaxProblem("2.系統分析/2026年度/支付系統報表文件_115"), null);
});

test("語法：反斜線、磁碟代號、開頭斜線、.. 都擋下", () => {
  assert.match(findSvnRootSyntaxProblem("WC-FOLDER\\2-SA\\6-需求規格書"), /反斜線/);
  assert.match(findSvnRootSyntaxProblem("C:/work/2-SA"), /本機絕對路徑/);
  assert.match(findSvnRootSyntaxProblem("/2-SA"), /本機絕對路徑/);
  assert.match(findSvnRootSyntaxProblem("2-SA/../3-SD"), /\.\./);
});

test("verifySvnRoots：全部存在 → null，且每個 root 都用同一個連線瀏覽", async () => {
  const calls = [];
  const browse = async (args) => (calls.push(args), { success: true });
  const problem = await verifySvnRoots("conn1", [
    { field: "saRoot", value: "2-SA/規格" },
    { field: "sdRoot", value: "3-SD/規格" },
  ], browse);
  assert.equal(problem, null);
  assert.deepEqual(calls, [
    { path: "2-SA/規格", connectionId: "conn1" },
    { path: "3-SD/規格", connectionId: "conn1" },
  ]);
});

test("verifySvnRoots：路徑在 SVN 上不存在 → 拒絕，訊息帶欄位名與 SVN 錯誤", async () => {
  const browse = async () => ({ success: false, message: "path not found" });
  const problem = await verifySvnRoots("conn1", [{ field: "saRoot", value: "不存在/路徑" }], browse);
  assert.match(problem, /saRoot「不存在\/路徑」/);
  assert.match(problem, /path not found/);
});

test("verifySvnRoots：語法有問題就不打 SVN；空白 root 略過", async () => {
  let called = 0;
  const browse = async () => (called++, { success: true });
  const problem = await verifySvnRoots("conn1", [{ field: "saRoot", value: "   " }, { field: "sdRoot", value: "a\\b" }], browse);
  assert.match(problem, /sdRoot「a\\b」.*反斜線/);
  assert.equal(called, 0);
});

test("verifySvnRoots：browse 回傳 null/undefined 視為失敗", async () => {
  const problem = await verifySvnRoots("c", [{ field: "saRoot", value: "x" }], async () => undefined);
  assert.match(problem, /未知錯誤/);
});

test("verifySvnRoots：browse 丟例外（callSvnTool 的真實失敗型態）也轉成帶欄位名的拒絕訊息", async () => {
  const browse = async () => {
    throw new Error("svn: E170013: path not found");
  };
  const problem = await verifySvnRoots("conn1", [{ field: "sdRoot", value: "3-SD/不存在" }], browse);
  assert.match(problem, /sdRoot「3-SD\/不存在」/);
  assert.match(problem, /path not found/);
  assert.match(problem, /register_sasd_config/);
});

import { isNoSaPlaceholder, requiresSvnConnection } from "../dist/sasd-path-check.js";

test("N/A 開頭的 saRoot 是「沒有 SA」的占位，不是真實路徑", () => {
  assert.equal(isNoSaPlaceholder("N/A-無SA文件"), true);
  assert.equal(isNoSaPlaceholder("  n/a"), true);
  assert.equal(isNoSaPlaceholder("N/A無SA文件"), true);
  assert.equal(isNoSaPlaceholder("2-SA/規格"), false);
  assert.equal(isNoSaPlaceholder("NA-docs/sa"), false);
});

test("requiresSvnConnection：external／self 一律要；其他模式只要 saRoot 是真實路徑也要", () => {
  assert.equal(requiresSvnConnection("external", "N/A-無SA文件"), true);
  assert.equal(requiresSvnConnection("self", "N/A-無SA文件"), true);
  assert.equal(requiresSvnConnection("self-generated", "2-SA/規格"), true); // 過去漏掉的情況：SA 在 SVN 卻沒登記連線
  assert.equal(requiresSvnConnection("unregistered", "2-SA/規格"), true);
  assert.equal(requiresSvnConnection("self-generated", "N/A-無SA文件"), false);
  assert.equal(requiresSvnConnection("unregistered", "N/A-無SA文件"), false);
});
