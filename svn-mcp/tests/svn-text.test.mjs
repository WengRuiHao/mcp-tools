// decodeSvnText：svn.exe 在繁中 Windows 輸出 cp950，diff 內文卻是 UTF-8，要逐行判斷編碼。
import test from "node:test";
import assert from "node:assert/strict";
import { decodeSvnText } from "../dist/svn-text.js";

// 任意一個 Big5 雙位元組字（0xB6 開頭不是合法的 UTF-8 起始位元組，所以一定會走 Big5 分支）。
const BIG5_ZHOU_SI = Buffer.from([0xb6, 0xb3]);

test("純 ASCII 與合法 UTF-8 原樣回傳", () => {
  assert.equal(decodeSvnText(Buffer.from("Index: a.txt\n+中文內容\n", "utf-8")), "Index: a.txt\n+中文內容\n");
});

test("整段是 Big5：整行以 Big5 解碼", () => {
  const big5 = new TextDecoder("big5");
  const bytes = Buffer.from([...Buffer.from("Date: "), ...BIG5_ZHOU_SI, 0x0a]);
  const expected = "Date: " + big5.decode(BIG5_ZHOU_SI) + "\n";
  assert.equal(decodeSvnText(bytes), expected);
  assert.ok(!decodeSvnText(bytes).includes("�"));
});

test("混合：標頭行是 Big5、內文行是 UTF-8，各自正確解碼（svn diff 的真實情況）", () => {
  const big5Line = Buffer.from([...Buffer.from("Path: "), ...BIG5_ZHOU_SI, 0x0a]);
  const utf8Line = Buffer.from("+這是 UTF-8 內文\n", "utf-8");
  const out = decodeSvnText(Buffer.concat([big5Line, utf8Line]));
  const lines = out.split("\n");
  assert.equal(lines[0], "Path: " + new TextDecoder("big5").decode(BIG5_ZHOU_SI));
  assert.equal(lines[1], "+這是 UTF-8 內文");
  assert.ok(!out.includes("�"));
});

test("沒有結尾換行的最後一行也會解碼；CRLF 保留", () => {
  const bytes = Buffer.concat([Buffer.from("a\r\n"), BIG5_ZHOU_SI]);
  const out = decodeSvnText(bytes);
  assert.equal(out, "a\r\n" + new TextDecoder("big5").decode(BIG5_ZHOU_SI));
});

test("空輸入回傳空字串", () => {
  assert.equal(decodeSvnText(Buffer.alloc(0)), "");
});
