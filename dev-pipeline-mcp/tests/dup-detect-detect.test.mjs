import test from "node:test";
import assert from "node:assert/strict";
import { mod, makeTmp, cleanup, write, codeLines, jsFile } from "./helpers/dup-helpers.mjs";

const { detectDuplicates, DupPathError } = mod;

test("明顯複製貼上被抓到，含兩邊行號", async () => {
  const root = makeTmp();
  try {
    const shared = codeLines(10, "x");
    write(root, "src/old.js", jsFile([...codeLines(3, "o"), ...shared]));
    write(root, "src/new.js", jsFile([...codeLines(2, "n"), ...shared, ...codeLines(2, "m")]));
    const r = await detectDuplicates({ projectDir: root, changedFiles: ["src/new.js"] });
    assert.equal(r.blocking, true);
    assert.equal(r.duplicates.length, 1);
    const b = r.duplicates[0];
    assert.equal(b.file, "src/new.js");
    assert.equal(b.otherFile, "src/old.js");
    assert.equal(b.kind, "existing");
    assert.equal(b.matchedLines, 10);
    assert.deepEqual([b.startLine, b.endLine], [4, 13]);
    assert.deepEqual([b.otherStartLine, b.otherEndLine], [5, 14]);
  } finally { cleanup(root); }
});

test("只差空白與註解的重複也被抓到", async () => {
  const root = makeTmp();
  try {
    const shared = codeLines(9, "y");
    write(root, "a.js", jsFile(shared));
    const messy = shared.flatMap((l, i) => (i % 2 ? [`   ${l.trim()}   // changed note ${i}`] : ["", l.replace(/ = /, "   =   ")]));
    write(root, "b.js", jsFile(messy));
    const r = await detectDuplicates({ projectDir: root, changedFiles: ["b.js"] });
    assert.equal(r.duplicates.length, 1);
    assert.equal(r.duplicates[0].matchedLines, 10);
  } finally { cleanup(root); }
});

test("短於門檻不抓（行數不足或字元太少）", async () => {
  const root = makeTmp();
  try {
    write(root, "a.js", jsFile(codeLines(6, "z")));
    write(root, "b.js", jsFile(codeLines(6, "z")));
    const r = await detectDuplicates({ projectDir: root, changedFiles: ["b.js"] });
    assert.equal(r.blocking, false);
    const tiny = Array.from({ length: 10 }, (_, i) => `  f(${i});`);
    write(root, "c.js", jsFile(tiny));
    write(root, "d.js", jsFile(tiny));
    const r2 = await detectDuplicates({ projectDir: root, changedFiles: ["d.js"] });
    assert.equal(r2.blocking, false, "字元數不足 120 不算");
  } finally { cleanup(root); }
});

test("大量相同的 import 與欄位宣告不誤判", async () => {
  const root = makeTmp();
  try {
    const head = [
      ...Array.from({ length: 20 }, (_, i) => `import com.example.longpackagename.module${i}.SomeVeryLongClassName${i};`),
      "public class Foo {",
      ...Array.from({ length: 20 }, (_, i) => `    private SomeVeryLongClassName${i} someVeryLongFieldName${i};`),
      "}",
    ].join("\n");
    write(root, "A.java", head);
    write(root, "B.java", head);
    const r = await detectDuplicates({ projectDir: root, changedFiles: ["B.java"] });
    assert.equal(r.blocking, false);
  } finally { cleanup(root); }
});

test("測試檔門檻較寬（12 行不抓、16 行才抓）", async () => {
  const root = makeTmp();
  try {
    write(root, "tests/a.test.js", jsFile(codeLines(12, "t")));
    write(root, "tests/b.test.js", jsFile(codeLines(12, "t")));
    const r = await detectDuplicates({ projectDir: root, changedFiles: ["tests/b.test.js"] });
    assert.equal(r.blocking, false);
    write(root, "tests/c.test.js", jsFile(codeLines(16, "u")));
    write(root, "tests/d.test.js", jsFile(codeLines(16, "u")));
    const r2 = await detectDuplicates({ projectDir: root, changedFiles: ["tests/d.test.js"] });
    assert.equal(r2.blocking, true);
    assert.equal(mod.isTestPath("src/FooTest.java"), true);
    assert.equal(mod.isTestPath("src/latest.js"), false);
  } finally { cleanup(root); }
});

test("改動檔案內部自我重複、改動檔案之間重複", async () => {
  const root = makeTmp();
  try {
    const shared = codeLines(9, "s");
    write(root, "self.js", jsFile([...shared, ...codeLines(2, "gap"), ...shared]));
    const r = await detectDuplicates({ projectDir: root, changedFiles: ["self.js"] });
    assert.equal(r.duplicates.length, 1);
    assert.equal(r.duplicates[0].kind, "within-change");
    assert.equal(r.duplicates[0].file, r.duplicates[0].otherFile);
    assert.ok(r.duplicates[0].startLine < r.duplicates[0].otherStartLine);

    const blk = codeLines(9, "p");
    write(root, "p1.js", jsFile(blk));
    write(root, "p2.js", jsFile(blk));
    const r2 = await detectDuplicates({ projectDir: root, changedFiles: ["p1.js", "p2.js"] });
    const cross = r2.duplicates.filter((d) => d.file !== d.otherFile);
    assert.equal(cross.length, 1, "兩個改動檔案之間只回報一次");
    assert.equal(cross[0].kind, "within-change");
  } finally { cleanup(root); }
});

test("路徑穿越被拒；不存在的改動檔案略過", async () => {
  const root = makeTmp();
  try {
    write(root, "a.js", jsFile(codeLines(3, "q")));
    await assert.rejects(detectDuplicates({ projectDir: root, changedFiles: ["../outside.js"] }), DupPathError);
    const r = await detectDuplicates({ projectDir: root, changedFiles: ["gone.js", "a.js"] });
    assert.deepEqual(r.skippedChanged, ["gone.js"]);
  } finally { cleanup(root); }
});
