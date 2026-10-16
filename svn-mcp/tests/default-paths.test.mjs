// 暫存資料夾與稽核紀錄的預設位置在專案裡（不是系統 Temp），環境變數可以覆蓋。
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAuditLogPath, getEditTempDir } from "../dist/config-store.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test("沒設環境變數：暫存與稽核紀錄都直接放專案的 logs", () => {
  withEnv({ SVN_EDIT_TEMP_DIR: undefined, SVN_EDIT_AUDIT_LOG: undefined }, () => {
    assert.equal(getEditTempDir(), path.join(projectRoot, "logs"));
    assert.equal(getAuditLogPath(), path.join(projectRoot, "logs", "svn-edit-audit.log"));
  });
});

test("環境變數可以覆蓋位置；空白字串視為沒設", () => {
  withEnv({ SVN_EDIT_TEMP_DIR: path.join(projectRoot, "x-temp"), SVN_EDIT_AUDIT_LOG: path.join(projectRoot, "x.log") }, () => {
    assert.equal(getEditTempDir(), path.join(projectRoot, "x-temp"));
    assert.equal(getAuditLogPath(), path.join(projectRoot, "x.log"));
  });
  withEnv({ SVN_EDIT_TEMP_DIR: "  ", SVN_EDIT_AUDIT_LOG: " " }, () => {
    assert.equal(getEditTempDir(), path.join(projectRoot, "logs"));
    assert.equal(getAuditLogPath(), path.join(projectRoot, "logs", "svn-edit-audit.log"));
  });
});

test("測試過程沒有把稽核紀錄寫進專案真正的 logs/（測試都該指到臨時檔）", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const real = path.join(projectRoot, "logs", "svn-edit-audit.log");
  if (existsSync(real)) assert.doesNotMatch(readFileSync(real, "utf-8"), /svn-edit-test|svn-batch-test|svn-csvpdf-test/);
});
