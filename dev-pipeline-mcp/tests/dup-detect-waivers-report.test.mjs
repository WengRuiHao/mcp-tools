import test from "node:test";
import assert from "node:assert/strict";
import { mod, makeTmp, cleanup, write, codeLines, jsFile } from "./helpers/dup-helpers.mjs";

const { detectDuplicates, formatDupReport } = mod;

function setup() {
  const root = makeTmp();
  const shared = codeLines(10, "w");
  write(root, "src/a.js", jsFile(shared));
  write(root, "src/b.js", jsFile(shared));
  write(root, "src/c.js", jsFile(codeLines(10, "unique")));
  return root;
}

test("有效豁免移到 waived，blocking 不再成立", async () => {
  const root = setup();
  try {
    const r = await detectDuplicates({
      projectDir: root, changedFiles: ["src/b.js"],
      waivers: [{ file: "src/b.js", otherFile: "src/a.js", reason: "兩邊刻意獨立演進" }],
    });
    assert.equal(r.blocking, false);
    assert.equal(r.duplicates.length, 0);
    assert.equal(r.waived.length, 1);
    assert.equal(r.waived[0].reason, "兩邊刻意獨立演進");
  } finally { cleanup(root); }
});

test("理由太短（去空白不足 4 字元）無效，仍擋下並列在 invalidWaivers", async () => {
  const root = setup();
  try {
    const r = await detectDuplicates({
      projectDir: root, changedFiles: ["src/b.js"],
      waivers: [{ file: "src/b.js", reason: " 好 的 " }],
    });
    assert.equal(r.blocking, true);
    assert.equal(r.waived.length, 0);
    assert.equal(r.invalidWaivers.length, 1);
  } finally { cleanup(root); }
});

test("豁免只對指定的對象有效，blocking 只看未豁免的區塊", async () => {
  const root = setup();
  try {
    const other = codeLines(10, "v");
    write(root, "src/d.js", jsFile(other));
    write(root, "src/e.js", jsFile(other));
    const r = await detectDuplicates({
      projectDir: root, changedFiles: ["src/b.js", "src/e.js"],
      waivers: [{ file: "src/b.js", reason: "已評估過不抽共用" }],
    });
    assert.equal(r.waived.length, 1);
    assert.equal(r.duplicates.length, 1);
    assert.equal(r.blocking, true);
    assert.ok(r.duplicates[0].file === "src/e.js" || r.duplicates[0].otherFile === "src/e.js");
  } finally { cleanup(root); }
});

test("formatDupReport：總結、兩處路徑與行號、豁免理由、修正建議", async () => {
  const root = setup();
  try {
    const dup = await detectDuplicates({ projectDir: root, changedFiles: ["src/b.js"] });
    const md = formatDupReport(dup);
    assert.match(md, /擋下交件/);
    assert.match(md, /掃描檔案數：\d+/);
    assert.match(md, /是否截斷：否/);
    assert.match(md, /`src\/b\.js` 第 \d+～\d+ 行/);
    assert.match(md, /`src\/a\.js` 第 \d+～\d+ 行/);
    assert.match(md, /共用方法/);

    const ok = await detectDuplicates({
      projectDir: root, changedFiles: ["src/b.js"],
      waivers: [{ file: "src/b.js", reason: "刻意獨立演進" }, { file: "x.js", reason: "短" }],
    });
    const md2 = formatDupReport(ok);
    assert.match(md2, /通過/);
    assert.match(md2, /已豁免的重複區塊/);
    assert.match(md2, /豁免理由：刻意獨立演進/);
    assert.match(md2, /無效的豁免/);
  } finally { cleanup(root); }
});

test("formatDupReport 標示截斷原因", () => {
  const md = formatDupReport({
    blocking: false, duplicates: [], waived: [], invalidWaivers: [], scannedFiles: 3, truncated: true,
    truncatedReason: "檔案數超過上限 3", skippedChanged: [], options: mod.DEFAULT_DUP_OPTIONS,
  });
  assert.match(md, /是否截斷：是（檔案數超過上限 3）/);
});
