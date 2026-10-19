// 「升級版本」：舊版複製到同目錄的 old 資料夾，新內容以版本號 +1 的新檔名上傳（同一個 commit）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSvnFixture } from "./helpers/svn-fixture.mjs";
import { archiveFileName, bumpParts, formatVersion, nextVersionName, parseVersion, suggestUpgradeName, versionLabel } from "../dist/version-bump.js";
import { commitEdit, discardEdit, EditError, getEditStatus, getUpgradePlan, listEdits, openEdit } from "../dist/remote-edit-client.js";

// ---- 版本號規則（純函式）----

test("版本號 +1：兩段版本後面那段加一；個位數滿 9 進位；三段只加最後一段", () => {
  assert.equal(nextVersionName("SPEC_MF04_營業人銷售額與稅額申報書_v0.7.docx"), "SPEC_MF04_營業人銷售額與稅額申報書_v0.8.docx");
  assert.equal(nextVersionName("SPEC_OC06_銷項折讓查詢_v0.9.docx"), "SPEC_OC06_銷項折讓查詢_v1.0.docx");
  assert.equal(nextVersionName("a_v1.9.xlsx"), "a_v2.0.xlsx");
  assert.equal(nextVersionName("a_v0.12.docx"), "a_v0.13.docx", "兩位數的小版本不進位");
  assert.equal(nextVersionName("a_v1.2.3.docx"), "a_v1.2.4.docx");
  assert.equal(nextVersionName("a_v1.9.9.docx"), "a_v1.9.10.docx", "三段版本不進位");
});

test("版本號辨識：大小寫 V、前面是點、版本號後面還有字、取最後一個、沒有副檔名", () => {
  assert.equal(nextVersionName("SPEC_OC03_(電)銷項折讓(非AR CM_匯入)_V1.3.docx"), "SPEC_OC03_(電)銷項折讓(非AR CM_匯入)_V1.4.docx", "大寫 V 維持大寫");
  assert.equal(nextVersionName("SPEC_JOB02_專案甲字軌取號排程.v0.3.docx"), "SPEC_JOB02_專案甲字軌取號排程.v0.4.docx", "版本號前面是點");
  assert.equal(nextVersionName("SPEC_IC02_進項折讓維護(無AP CM) _v0.5.docx"), "SPEC_IC02_進項折讓維護(無AP CM) _v0.6.docx", "括號、空白都沒關係");
  assert.equal(nextVersionName("a_v1.0_備份_v2.3.docx"), "a_v1.0_備份_v2.4.docx", "取最後一個版本號");
  assert.equal(nextVersionName("a_v0.7最終.docx"), "a_v0.8最終.docx", "版本號後面還有字");
  assert.equal(nextVersionName("notes_v0.7"), "notes_v0.8", "沒有副檔名");
  assert.equal(nextVersionName("report_v10.20.pdf"), "report_v10.21.pdf");
});

test("沒有版本號（或不是版本號）就回 null：rev1.2、v1、純數字、沒有 v", () => {
  for (const name of ["報告.docx", "rev1.2.docx", "a_v1.docx", "readme.md", "2026.10.15.txt", "a_version2.docx", ".docx"]) {
    assert.equal(nextVersionName(name), null, name);
  }
  assert.equal(parseVersion("報告.docx"), null);
  assert.equal(versionLabel("x_v0.7.docx"), "v0.7");
  assert.equal(versionLabel("x.docx"), null);
});

test("沒有版次的檔名升級：原檔當第一版，檔名後面（副檔名前）自動加上 _v0.2；有版次就照 +1", () => {
  assert.deepEqual(suggestUpgradeName("營業人申報書.docx"), { name: "營業人申報書_v0.2.docx", implicit: true });
  assert.deepEqual(suggestUpgradeName("readme.md"), { name: "readme_v0.2.md", implicit: true });
  assert.deepEqual(suggestUpgradeName("notes"), { name: "notes_v0.2", implicit: true }, "沒有副檔名");
  assert.deepEqual(suggestUpgradeName("SPEC_A (最終).xlsx"), { name: "SPEC_A (最終)_v0.2.xlsx", implicit: true });
  assert.deepEqual(suggestUpgradeName("rev1.2.docx"), { name: "rev1.2_v0.2.docx", implicit: true }, "rev1.2 不是版本號");
  assert.deepEqual(suggestUpgradeName("a_v1.docx"), { name: "a_v1_v0.2.docx", implicit: true }, "只有一段的 v1 不算版本號");
  assert.deepEqual(suggestUpgradeName("SPEC_a_v0.7.docx"), { name: "SPEC_a_v0.8.docx", implicit: false }, "有版次就正常 +1");
});

test("舊版放進 old 的檔名：有版次維持原檔名；沒有版次（有人忘了寫）自動補 _v0.1", () => {
  assert.deepEqual(archiveFileName("SPEC_a_v0.7.docx"), { name: "SPEC_a_v0.7.docx", implicit: false });
  assert.deepEqual(archiveFileName("營業人申報書.docx"), { name: "營業人申報書_v0.1.docx", implicit: true });
  assert.deepEqual(archiveFileName("readme.md"), { name: "readme_v0.1.md", implicit: true });
  assert.deepEqual(archiveFileName("notes"), { name: "notes_v0.1", implicit: true });
  // 舊版 _v0.1、新版 _v0.2：兩個名稱永遠不會互相衝突，而且順序接得起來
  const old = archiveFileName("報告.docx").name;
  assert.equal(old, "報告_v0.1.docx");
  assert.equal(nextVersionName(old), suggestUpgradeName("報告.docx").name, "v0.1 的下一版剛好就是自動加的 v0.2");
});

test("parseVersion／bumpParts／formatVersion 組得回原樣", () => {
  const parsed = parseVersion("SPEC_a_v0.7.docx");
  assert.deepEqual([parsed.before, parsed.marker, parsed.parts, parsed.after, parsed.ext], ["SPEC_a_", "v", [0, 7], "", ".docx"]);
  assert.equal(formatVersion(parsed, parsed.parts), "SPEC_a_v0.7.docx");
  assert.deepEqual(bumpParts([0, 7]), [0, 8]);
  assert.deepEqual(bumpParts([0, 9]), [1, 0]);
});

// ---- 實際升級流程（本機臨時 SVN 儲存庫）----

const { repoDir, repoUrl, svn, seed } = createSvnFixture({ prefix: "svn-upgrade-test-" });
const cat = (rel) => svn("cat", `${repoUrl}/${rel}`);
const list = (rel) => svn("list", `${repoUrl}/${rel}`).split(/\r?\n/).filter(Boolean).sort();
const head = () => Number(/(\d+)/.exec(svn("info", "--show-item", "revision", repoUrl))[1]);
const logHead = () => svn("log", "-v", "-r", "HEAD", repoUrl);
const lockInfo = (rel) => svn("info", "--xml", `${repoUrl}/${rel}`);

async function assertEditError(promise, code, pattern) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof EditError, `應該是 EditError，實際：${e?.constructor?.name}：${e?.message}`);
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

test("升級計畫：舊版放進 old、新版檔名版本號 +1；遠端還沒有 old 資料夾就標示會新建", async () => {
  seed("p1/SPEC_A_v0.7.docx", "v0.7 內容");
  const session = await openEdit({ connectionId: "t1", path: "p1/SPEC_A_v0.7.docx" });
  try {
    const plan = await getUpgradePlan(session.id);
    assert.equal(plan.applicable, true);
    assert.equal(plan.reason, null);
    assert.deepEqual([plan.currentName, plan.currentVersion, plan.newName, plan.newVersion], ["SPEC_A_v0.7.docx", "v0.7", "SPEC_A_v0.8.docx", "v0.8"]);
    assert.deepEqual([plan.archiveDirName, plan.archiveDirExists], ["old", false]);
    assert.equal(plan.archivePath, "p1/old/SPEC_A_v0.7.docx");
    assert.equal(plan.newPath, "p1/SPEC_A_v0.8.docx");
  } finally {
    await discardEdit(session.id);
  }
});

test("升級計畫：遠端已經有 Old（大小寫不同）就沿用它原本的名稱", async () => {
  seed("p2/SPEC_B_v0.7.docx", "b");
  seed("p2/Old/SPEC_B_v0.6.docx", "舊的舊版");
  const session = await openEdit({ connectionId: "t1", path: "p2/SPEC_B_v0.7.docx" });
  try {
    const plan = await getUpgradePlan(session.id);
    assert.deepEqual([plan.applicable, plan.archiveDirName, plan.archiveDirExists], [true, "Old", true]);
    assert.equal(plan.archivePath, "p2/Old/SPEC_B_v0.7.docx");
  } finally {
    await discardEdit(session.id);
  }
});

test("升級計畫：沒有版次的檔案自動加 _v0.2；不能升級的情況都講清楚原因（新檔名已存在、old 裡已有同名舊版、old 是檔案、亂改新檔名）", async () => {
  seed("p3/noversion.docx", "x");
  let session = await openEdit({ connectionId: "t1", path: "p3/noversion.docx" });
  let plan = await getUpgradePlan(session.id);
  assert.deepEqual([plan.applicable, plan.currentVersion, plan.newName, plan.newVersion, plan.implicitVersion], [true, null, "noversion_v0.2.docx", "v0.2", true], "沒有版次：自動加上 _v0.2，而且可以升級");
  assert.equal(plan.archivePath, "p3/old/noversion_v0.1.docx", "舊版放進 old 時也補上 _v0.1，這樣 old 裡每個檔案都看得出是哪一版");
  assert.equal(plan.archiveFileName, "noversion_v0.1.docx");
  await discardEdit(session.id);

  seed("p3/clash.docx", "x");
  seed("p3/clash_v0.2.docx", "已經有 _v0.2 了");
  session = await openEdit({ connectionId: "t1", path: "p3/clash.docx" });
  plan = await getUpgradePlan(session.id);
  assert.equal(plan.applicable, false);
  assert.equal(plan.newName, "clash_v0.2.docx");
  assert.match(plan.reason, /已經有「clash_v0\.2\.docx」/);
  assert.equal((await getUpgradePlan(session.id, "clash_v0.3.docx")).applicable, true, "使用者可以自己改版次");
  await discardEdit(session.id);

  seed("p3/C_v0.7.docx", "c");
  seed("p3/C_v0.8.docx", "已經有 0.8 了");
  session = await openEdit({ connectionId: "t1", path: "p3/C_v0.7.docx" });
  plan = await getUpgradePlan(session.id);
  assert.equal(plan.applicable, false);
  assert.equal(plan.newName, "C_v0.8.docx", "仍回傳預設新檔名，讓畫面可以讓使用者改");
  assert.match(plan.reason, /已經有「C_v0\.8\.docx」/);
  assert.equal((await getUpgradePlan(session.id, "C_v0.9.docx")).applicable, true, "使用者改成別的檔名就可以");
  assert.match((await getUpgradePlan(session.id, "C_V0.8.DOCX")).reason, /已經有/, "檔名比對不分大小寫");
  for (const [bad, pattern] of [["a/b_v0.8.docx", /不能包含/], ["C_v0.8:x.docx", /不能包含/], ["C_v0.8.xlsx", /副檔名/], ["C_v0.7.docx", /一樣/]]) {
    const p = await getUpgradePlan(session.id, bad);
    assert.equal(p.applicable, false, bad);
    assert.match(p.reason, pattern, bad);
  }
  await discardEdit(session.id);

  seed("p3/D_v0.7.docx", "d");
  seed("p3/old/D_v0.7.docx", "之前存過的舊版");
  session = await openEdit({ connectionId: "t1", path: "p3/D_v0.7.docx" });
  plan = await getUpgradePlan(session.id);
  assert.equal(plan.applicable, false);
  assert.match(plan.reason, /已經有「D_v0\.7\.docx」/);
  await discardEdit(session.id);

  seed("p4/E_v0.7.docx", "e");
  seed("p4/old", "我是檔案不是資料夾");
  session = await openEdit({ connectionId: "t1", path: "p4/E_v0.7.docx" });
  assert.match((await getUpgradePlan(session.id)).reason, /不是資料夾/);
  await discardEdit(session.id);
});

test("升級上傳：同一個 commit 完成——舊版（原內容）進 old、新內容成為新檔名、舊檔名從原目錄消失、歷史保留、鎖放掉", async () => {
  seed("up1/SPEC_MF_v0.7.docx", "舊版內容 v0.7");
  const session = await openEdit({ connectionId: "t1", path: "up1/SPEC_MF_v0.7.docx" });
  assert.equal(session.locked, true);
  fs.writeFileSync(session.filePath, "新版內容 v0.8");
  const before = head();

  const result = await commitEdit(session.id, "升級版本", true);

  assert.equal(head(), before + 1, "只產生一個 revision");
  assert.equal(result.committedRevision, before + 1);
  assert.deepEqual(result.upgrade, { archivedTo: "up1/old/SPEC_MF_v0.7.docx", renamedTo: "up1/SPEC_MF_v0.8.docx", newName: "SPEC_MF_v0.8.docx", fromVersion: "v0.7", toVersion: "v0.8" });
  assert.equal(result.path, "up1/SPEC_MF_v0.8.docx");

  assert.deepEqual(list("up1"), ["SPEC_MF_v0.8.docx", "old/"], "原目錄只剩新版與 old");
  assert.equal(cat("up1/SPEC_MF_v0.8.docx"), "新版內容 v0.8");
  assert.equal(cat("up1/old/SPEC_MF_v0.7.docx"), "舊版內容 v0.7", "old 裡是升級前 SVN 上的原內容，不是編輯後的");

  const log = logHead();
  assert.match(log, /A \/up1\/old\s*$/m, "新建 old 資料夾");
  assert.match(log, /A \/up1\/old\/SPEC_MF_v0\.7\.docx \(from \/up1\/SPEC_MF_v0\.7\.docx:\d+\)/, "舊版是 svn copy，保留歷史");
  assert.match(log, /A \/up1\/SPEC_MF_v0\.8\.docx \(from \/up1\/SPEC_MF_v0\.7\.docx:\d+\)/, "新版是 svn move，保留歷史");
  assert.match(log, /D \/up1\/SPEC_MF_v0\.7\.docx/);
  assert.doesNotMatch(lockInfo("up1/SPEC_MF_v0.8.docx"), /<lock>/, "沒有殘留的鎖");
  assert.equal((await listEdits()).length, 0, "編輯項目已清掉");
});

test("升級上傳：old 已存在（Old）就沿用，不會多建一個 old", async () => {
  seed("up2/SPEC_X_v0.7.xlsx", "x7");
  seed("up2/Old/SPEC_X_v0.6.xlsx", "x6");
  const session = await openEdit({ connectionId: "t1", path: "up2/SPEC_X_v0.7.xlsx" });
  fs.writeFileSync(session.filePath, "x8");
  const result = await commitEdit(session.id, "升級", { });
  assert.equal(result.upgrade.archivedTo, "up2/Old/SPEC_X_v0.7.xlsx");
  assert.deepEqual(list("up2"), ["Old/", "SPEC_X_v0.8.xlsx"], "沒有另外出現小寫 old");
  assert.deepEqual(list("up2/Old"), ["SPEC_X_v0.6.xlsx", "SPEC_X_v0.7.xlsx"], "舊的舊版還在");
  assert.equal(cat("up2/Old/SPEC_X_v0.7.xlsx"), "x7");
  assert.equal(cat("up2/SPEC_X_v0.8.xlsx"), "x8");
});

test("升級上傳：可以指定自己的新版檔名；版本號進位（v0.9 → v1.0）", async () => {
  seed("up3/SPEC_Y_v0.9.docx", "y9");
  let session = await openEdit({ connectionId: "t1", path: "up3/SPEC_Y_v0.9.docx" });
  assert.equal((await getUpgradePlan(session.id)).newName, "SPEC_Y_v1.0.docx");
  fs.writeFileSync(session.filePath, "y-new");
  const result = await commitEdit(session.id, "升到 2.0", { newName: "SPEC_Y_v2.0.docx" });
  assert.equal(result.upgrade.newName, "SPEC_Y_v2.0.docx");
  assert.deepEqual(list("up3"), ["SPEC_Y_v2.0.docx", "old/"]);
  assert.equal(cat("up3/old/SPEC_Y_v0.9.docx"), "y9");
});

test("沒有版次的檔案升級上傳：舊版放進 old 時補 _v0.1、新版自動叫 xxx_v0.2（沒有 old 就自動建立）", async () => {
  seed("up4/plain.md", "原文");
  const session = await openEdit({ connectionId: "t1", path: "up4/plain.md" });
  fs.writeFileSync(session.filePath, "改過的內容");
  const before = head();
  const result = await commitEdit(session.id, "第一次升級", true);
  assert.equal(head(), before + 1, "只產生一個 revision");
  assert.deepEqual(result.upgrade, { archivedTo: "up4/old/plain_v0.1.md", renamedTo: "up4/plain_v0.2.md", newName: "plain_v0.2.md", fromVersion: null, toVersion: "v0.2" });
  assert.deepEqual(list("up4"), ["old/", "plain_v0.2.md"], "old 資料夾自動建立，原檔名從目錄消失");
  assert.equal(cat("up4/old/plain_v0.1.md"), "原文", "old 裡是升級前的原內容，檔名補上 _v0.1");
  assert.equal(cat("up4/plain_v0.2.md"), "改過的內容");
  assert.match(logHead(), /A \/up4\/plain_v0\.2\.md \(from \/up4\/plain\.md:\d+\)/, "新版保留歷史");
  assert.match(logHead(), /A \/up4\/old\/plain_v0\.1\.md \(from \/up4\/plain\.md:\d+\)/, "舊版（補了 _v0.1 的檔名）也保留歷史");

  // 下一次升級：已經有版次了，照 +1（v0.2 → v0.3），舊版 v0.2 也進 old
  const again = await openEdit({ connectionId: "t1", path: "up4/plain_v0.2.md" });
  fs.writeFileSync(again.filePath, "第二次改");
  const second = await commitEdit(again.id, "第二次升級", true);
  assert.equal(second.upgrade.newName, "plain_v0.3.md");
  assert.deepEqual(list("up4/old"), ["plain_v0.1.md", "plain_v0.2.md"], "歷代舊版都留在 old，而且每個都有版次");
  assert.deepEqual(list("up4"), ["old/", "plain_v0.3.md"]);
});

test("升級上傳被拒絕時（新檔名已存在）：遠端完全不動、編輯項目與內容都保留，可以改名重試或改成一般上傳", async () => {
  seed("up5/Z_v0.1.docx", "z1");
  seed("up5/Z_v0.2.docx", "擋路的檔案");
  const s2 = await openEdit({ connectionId: "t1", path: "up5/Z_v0.1.docx" });
  fs.writeFileSync(s2.filePath, "z-edit");
  await assertEditError(commitEdit(s2.id, "升級", true), "ALREADY_EXISTS", /已經有/);
  assert.equal(cat("up5/Z_v0.2.docx"), "擋路的檔案");
  assert.equal(fs.readFileSync(s2.filePath, "utf-8"), "z-edit");
  const retry = await commitEdit(s2.id, "改名後重試", { newName: "Z_v0.3.docx" });
  assert.equal(retry.upgrade.newName, "Z_v0.3.docx");
  assert.equal(cat("up5/old/Z_v0.1.docx"), "z1");
});

test("commit 在最後一步失敗（伺服器 hook 拒絕）：工作副本還原、你編輯的內容原封不動放回去、遠端沒變、移除 hook 後可以重試成功", { skip: process.platform !== "win32" }, async () => {
  seed("up6/SPEC_R_v0.7.docx", "r7");
  const session = await openEdit({ connectionId: "t1", path: "up6/SPEC_R_v0.7.docx" });
  fs.writeFileSync(session.filePath, "我辛苦編輯的內容");
  const hook = path.join(repoDir, "hooks", "pre-commit.bat");
  fs.writeFileSync(hook, "@echo off\r\necho rejected-by-test-hook 1>&2\r\nexit /b 1\r\n");
  const before = head();
  try {
    await assert.rejects(commitEdit(session.id, "會被擋", true), /rejected-by-test-hook|hook|pre-commit/i);
  } finally {
    fs.rmSync(hook, { force: true });
  }
  assert.equal(head(), before, "遠端沒有任何變化");
  assert.deepEqual(list("up6"), ["SPEC_R_v0.7.docx"]);
  assert.equal(fs.readFileSync(session.filePath, "utf-8"), "我辛苦編輯的內容", "編輯內容一個字都不能少");
  const wcFiles = fs.readdirSync(session.wcDir).filter((n) => n !== ".svn").sort();
  assert.deepEqual(wcFiles, ["SPEC_R_v0.7.docx"], "工作副本裡沒有殘留的 old 資料夾或新檔名");
  assert.equal((await getEditStatus(session.id)).modified, true, "還是被認得是已修改");

  const retry = await commitEdit(session.id, "hook 拿掉後重試", true);
  assert.equal(retry.upgrade.newName, "SPEC_R_v0.8.docx");
  assert.equal(cat("up6/SPEC_R_v0.8.docx"), "我辛苦編輯的內容");
  assert.equal(cat("up6/old/SPEC_R_v0.7.docx"), "r7");
});

// ---- Windows 8.3 短檔名路徑（C:\\Users\\RUIHAO~1\\…）：svn move 在這種路徑底下的工作副本會回 E155004 ----

const shortTmp = os.tmpdir();
const longTmp = fs.realpathSync.native(os.tmpdir());
const hasShortNames = shortTmp !== longTmp;

test("暫存位置寫成 8.3 短檔名形式：編輯項目一律建在真實長路徑底下，升級上傳照樣成功", async () => {
  const savedDir = process.env.SVN_EDIT_TEMP_DIR;
  process.env.SVN_EDIT_TEMP_DIR = path.join(shortTmp, `svn-upgrade-short-${Date.now()}`);
  try {
    seed("sh1/SPEC_S_v0.7.docx", "s7");
    const session = await openEdit({ connectionId: "t1", path: "sh1/SPEC_S_v0.7.docx" });
    assert.equal(session.wcDir, fs.realpathSync.native(session.wcDir), "工作副本路徑是真實長路徑，不含 8.3 短檔名");
    assert.equal(session.filePath, fs.realpathSync.native(session.filePath));
    fs.writeFileSync(session.filePath, "s8");
    const result = await commitEdit(session.id, "短路徑也要能升級", true);
    assert.equal(result.upgrade.newName, "SPEC_S_v0.8.docx");
    assert.equal(cat("sh1/SPEC_S_v0.8.docx"), "s8");
    assert.equal(cat("sh1/old/SPEC_S_v0.7.docx"), "s7");
  } finally {
    process.env.SVN_EDIT_TEMP_DIR = savedDir;
  }
});

test("舊程式建立的編輯項目（session.json 記的是短檔名路徑）：升級上傳時自動改用真實路徑，不會再 E155004", { skip: !hasShortNames }, async () => {
  seed("sh2/SPEC_T_v0.7.docx", "t7");
  const session = await openEdit({ connectionId: "t1", path: "sh2/SPEC_T_v0.7.docx" });
  fs.writeFileSync(session.filePath, "t8");
  // 模擬舊版：session.json 裡的三個路徑改成短檔名形式
  const sessionFile = path.join(session.sessionDir, "session.json");
  const record = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
  for (const key of ["sessionDir", "wcDir", "filePath"]) record[key] = record[key].replace(longTmp, shortTmp);
  assert.notEqual(record.wcDir, session.wcDir, "測試前提：路徑真的變成短檔名形式了");
  fs.writeFileSync(sessionFile, JSON.stringify(record, null, 2));

  const result = await commitEdit(session.id, "舊項目升級", true);
  assert.equal(result.upgrade.newName, "SPEC_T_v0.8.docx");
  assert.equal(cat("sh2/SPEC_T_v0.8.docx"), "t8");
  assert.equal(cat("sh2/old/SPEC_T_v0.7.docx"), "t7");
});
