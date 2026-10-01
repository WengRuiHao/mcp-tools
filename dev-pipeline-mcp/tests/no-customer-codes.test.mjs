// 客戶代號守門：公開檔案不得出現真實客戶代號。本檔的代號一律拆字串或用 \u 逃脫，避免掃到自己。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const j = (...parts) => parts.join("");

const FORBIDDEN = [
  j("UEC", "-F"),
  j("電子", "發票"),
  j("ofe", "invoice"),
  j("SC", "SB"),
  j("上海", "商銀"),
  j("Alv", "en"),
  j("高", "銀"),
  j("sow", "ffd"),
  j("社家", "署"),
  j("boke", "ps"),
  j("KS", "BS"),
];

function walk(target, accept) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return accept(target) ? [target] : [];
  return fs.readdirSync(target).flatMap((name) => walk(path.join(target, name), accept));
}

const SCAN = [
  ...walk(path.join(root, "src"), (f) => f.endsWith(".ts")),
  ...walk(path.join(root, "templates"), () => true),
  ...walk(path.join(root, "tests"), (f) => /\.(mjs|md)$/.test(f)),
  ...[path.join(root, "README.md"), path.join(root, "docs", "MANUAL.html")].filter((f) => fs.existsSync(f)),
];

test("the scan covers the expected public files", () => {
  const rel = SCAN.map((f) => path.relative(root, f).replace(/\\/g, "/"));
  assert.ok(rel.some((f) => f.startsWith("src/") && f.endsWith(".ts")));
  assert.ok(rel.some((f) => f.startsWith("templates/")));
  assert.ok(rel.includes("README.md"));
  assert.ok(rel.some((f) => f.startsWith("tests/")));
});

// 已知既有違規（HEAD 當時就有，本測試不改 src／templates）。清掉之後請把對應項目從這裡刪除，
// 否則下面的 stale 檢查會提醒你。
const KNOWN_EXISTING = {
  "src/pipeline-store.ts": [j("SC", "SB")],
  "templates/pending-actions.html": [j("SC", "SB")],
};

test("no real customer codes in src/, README.md, docs/MANUAL.html, templates/ or tests/ (beyond the known allowlist)", () => {
  const hits = [];
  const seenKnown = new Set();
  for (const file of SCAN) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    const text = fs.readFileSync(file, "utf-8").toLowerCase();
    for (const word of FORBIDDEN) {
      if (!text.includes(word.toLowerCase())) continue;
      if ((KNOWN_EXISTING[rel] ?? []).includes(word)) seenKnown.add(`${rel}#${word}`);
      else hits.push(`${rel} contains a forbidden code (#${FORBIDDEN.indexOf(word)})`);
    }
  }
  assert.deepEqual(hits, []);
  const stale = Object.entries(KNOWN_EXISTING).flatMap(([rel, words]) => words.filter((w) => !seenKnown.has(`${rel}#${w}`)).map((w) => `${rel}#${w}`));
  assert.deepEqual(stale, [], "allowlist entry no longer needed; remove it from KNOWN_EXISTING");
});
