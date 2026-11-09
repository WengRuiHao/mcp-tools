import test from "node:test";
import assert from "node:assert/strict";
import { mod } from "./helpers/dup-helpers.mjs";

const texts = (src, ext) => mod.normalizeSource(src, ext).map((l) => l.text);

test("c 系語言：去行註解與區塊註解，保留字串內的註解符號", () => {
  const src = ["int a = 1; // note", "/* block", "still comment */ int b = 2;", 'String s = "// not comment";'].join("\n");
  assert.deepEqual(texts(src, "java"), ["int a = 1;", "int b = 2;", 'String s = "// not comment";']);
});

test("python 與 sql 的註解", () => {
  assert.deepEqual(texts("x = 1  # c\n# only\ny = '#keep'", "py"), ["x = 1", "y = '#keep'"]);
  assert.deepEqual(texts('"""doc\nstring"""\nz = 3', "py"), ["z = 3"]);
  assert.deepEqual(texts("select 1 -- c\n/* x */\nfrom t", "sql"), ["select 1", "from t"]);
});

test("html 與 xml 註解、css 區塊註解", () => {
  assert.deepEqual(texts("<a>\n<!-- gone -->\n<b/>", "html"), ["<a>", "<b/>"]);
  assert.deepEqual(texts("/* c */ .a { color: red; }", "css"), [".a { color: red; }"]);
});

test("空白壓成單一空格並去頭尾，保留原始行號", () => {
  const r = mod.normalizeSource("\n\n   foo(  a,\t b )   \n", "ts");
  assert.deepEqual(r, [{ text: "foo( a, b )", line: 3 }]);
});

test("忽略括號行、import/package/using/require、無參數註記、欄位宣告與 getter/setter", () => {
  const src = [
    "package a.b;", "import x.y.Z;", "using System;", "const fs = require('fs');", "import { a } from 'b';",
    "}", "});", "@Override", "@Test()", "@RequestMapping(\"/x\")", "private String name;",
    "return this.name;", "this.name = name;", "doWork(1);",
  ].join("\n");
  assert.deepEqual(texts(src, "java"), ['@RequestMapping("/x")', "doWork(1);"]);
});

test("return x; 這類不是宣告，不能被忽略", () => {
  assert.deepEqual(texts("return value;\nthrow error;", "ts"), ["return value;", "throw error;"]);
});

test("未知副檔名不去註解，其餘規則照常", () => {
  assert.deepEqual(texts("a // b\n\n  c", "txt"), ["a // b", "c"]);
});
