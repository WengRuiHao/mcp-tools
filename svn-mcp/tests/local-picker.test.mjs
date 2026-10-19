// 系統的「選擇資料夾」視窗：腳本組裝、路徑整理、自動化測試模式、API。（真的叫出視窗要人操作，這裡不測）
import test from "node:test";
import assert from "node:assert/strict";
import { buildPickerScript, normalizePickedPath, pickLocalFolder } from "../dist/local-picker.js";
import { createEditServer } from "../dist/edit-server.js";

const BS = String.fromCharCode(92); // 反斜線
const savedLaunch = process.env.SVN_EDIT_NO_LAUNCH;
const savedResult = process.env.SVN_EDIT_PICK_RESULT;
test.after(() => {
  if (savedLaunch === undefined) delete process.env.SVN_EDIT_NO_LAUNCH; else process.env.SVN_EDIT_NO_LAUNCH = savedLaunch;
  if (savedResult === undefined) delete process.env.SVN_EDIT_PICK_RESULT; else process.env.SVN_EDIT_PICK_RESULT = savedResult;
});

test("腳本：標題與起始資料夾的單引號會跳脫，起始路徑轉成 Windows 的反斜線，輸出用 base64", () => {
  const script = buildPickerScript("選 '專案' 資料夾", "D:/svn/my repo");
  assert.ok(script.includes("$title = '選 ''專案'' 資料夾'"), "單引號要重複一次才不會截斷字串");
  assert.ok(script.includes(`$start = 'D:${BS}svn${BS}my repo'`), "起始路徑要用反斜線");
  assert.ok(script.includes("[Convert]::ToBase64String"), "輸出用 base64，中文才不會被主控台字碼頁弄壞");
  assert.ok(script.includes("0x20"), "要設成選資料夾模式（FOS_PICKFOLDERS）");
});

test("路徑整理：磁碟機路徑用正斜線、結尾斜線去掉；網路路徑維持原樣；不能用的回傳空字串", () => {
  assert.equal(normalizePickedPath(`D:${BS}svn${BS}proj${BS}`), "D:/svn/proj");
  assert.equal(normalizePickedPath(`  C:${BS}Users${BS}中文 資料夾  `), "C:/Users/中文 資料夾");
  const unc = `${BS}${BS}server${BS}share${BS}repo`;
  assert.equal(normalizePickedPath(unc), unc);
  assert.equal(normalizePickedPath("relative"), "");
  assert.equal(normalizePickedPath(""), "");
});

test("自動化測試模式（SVN_EDIT_NO_LAUNCH=1）：不叫視窗，回傳 SVN_EDIT_PICK_RESULT；沒設就是取消（空字串）", async () => {
  process.env.SVN_EDIT_NO_LAUNCH = "1";
  delete process.env.SVN_EDIT_PICK_RESULT;
  assert.deepEqual(await pickLocalFolder({ title: "x" }), { path: "" });
  process.env.SVN_EDIT_PICK_RESULT = "D:/svn/picked";
  assert.deepEqual(await pickLocalFolder({}), { path: "D:/svn/picked" });
});

test("API：POST /api/local/pick 要 token，通過後回傳選到的路徑", async () => {
  process.env.SVN_EDIT_NO_LAUNCH = "1";
  process.env.SVN_EDIT_PICK_RESULT = "D:/svn/from-api";
  const edit = createEditServer();
  await new Promise((resolve) => edit.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${edit.server.address().port}`;
  try {
    const noToken = await fetch(`${base}/api/local/pick`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(noToken.status, 401);
    const ok = await fetch(`${base}/api/local/pick`, { method: "POST", headers: { "Content-Type": "application/json", "X-Edit-Token": edit.token }, body: JSON.stringify({ title: "選擇" }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { path: "D:/svn/from-api" });
  } finally {
    edit.server.close();
  }
});
