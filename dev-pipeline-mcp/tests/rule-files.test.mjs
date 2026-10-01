// 規則檔讀取（新舊位置）、快照歷史、list_rule_history / restore_rule_file。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir, writeFile, connectClient, callTool, isolateDataDir } from "./helpers/support.mjs";
import { ROLE_FILE_CANDIDATES, COMMON_RULES_FILE_CANDIDATES, GATES_FILE_CANDIDATES, readFirstExisting, readProjectSettings } from "../dist/project-rule-files.js";
import { isRuleFilePath, isValidSnapshotName, listSnapshots, listTrackedFiles, readSnapshot, snapshotIfChanged } from "../dist/rule-history.js";
import { registerRuleHistoryTools } from "../dist/rule-history-tools.js";

const data = isolateDataDir();
test.after(() => data.cleanup());

function withProject(fn) {
  return async (t) => {
    const dir = makeTmpDir("dpm-rules-");
    try {
      await fn(dir, t);
    } finally {
      removeDir(dir);
    }
  };
}

test("readFirstExisting: .pipeline/ is preferred over the legacy location", withProject(async (dir) => {
  writeFile(dir, ".claude/pipeline-roles/engineer.md", "old");
  writeFile(dir, ".pipeline/roles/engineer.md", "new");
  const found = await readFirstExisting(dir, ROLE_FILE_CANDIDATES("engineer"));
  assert.equal(found.relPath, ".pipeline/roles/engineer.md");
  assert.equal(found.content, "new");
}));

test("readFirstExisting: falls back to the legacy location when only it exists", withProject(async (dir) => {
  writeFile(dir, ".claude/pipeline-roles/all.md", "legacy common");
  const found = await readFirstExisting(dir, COMMON_RULES_FILE_CANDIDATES);
  assert.equal(found.relPath, ".claude/pipeline-roles/all.md");
  assert.equal(found.content, "legacy common");
}));

test("readFirstExisting: returns null when nothing exists (gates too)", withProject(async (dir) => {
  assert.equal(await readFirstExisting(dir, GATES_FILE_CANDIDATES), null);
}));

test("readFirstExisting: errors other than not-found (e.g. a directory in place of the file) are thrown", withProject(async (dir) => {
  // .pipeline/roles/engineer.md 是目錄 -> EISDIR 不是「找不到」，必須往外丟
  fs.mkdirSync(path.join(dir, ".pipeline/roles/engineer.md"), { recursive: true });
  await assert.rejects(() => readFirstExisting(dir, ROLE_FILE_CANDIDATES("engineer")));
}));

test("readProjectSettings: present / absent / malformed JSON throws", withProject(async (dir) => {
  assert.deepEqual(await readProjectSettings(dir), {});
  writeFile(dir, ".pipeline/settings.json", JSON.stringify({ onlyAssignedToMe: true }));
  assert.deepEqual(await readProjectSettings(dir), { onlyAssignedToMe: true });
  writeFile(dir, ".pipeline/settings.json", "{ not json");
  await assert.rejects(() => readProjectSettings(dir), /settings\.json/);
}));

test("isRuleFilePath accepts rule locations and rejects everything else", () => {
  assert.equal(isRuleFilePath(".pipeline/roles/engineer.md"), true);
  assert.equal(isRuleFilePath(".claude/pipeline-roles/all.md"), true);
  assert.equal(isRuleFilePath(".pipeline\\roles\\engineer.md"), true);
  assert.equal(isRuleFilePath("README.md"), false);
  assert.equal(isRuleFilePath("src/index.ts"), false);
  assert.equal(isRuleFilePath(".pipeline/../secret.md"), false);
  assert.equal(isRuleFilePath(".pipeline\\..\\secret.md"), false);
  assert.equal(isRuleFilePath(".pipeline/.history/x/20260101-000000-000.md"), false);
});

test("isValidSnapshotName", () => {
  assert.equal(isValidSnapshotName("20261001-101500-123.md"), true);
  assert.equal(isValidSnapshotName("20261001-101500-123"), true);
  assert.equal(isValidSnapshotName("../20261001-101500-123.md"), false);
  assert.equal(isValidSnapshotName("_source.txt"), false);
  assert.equal(isValidSnapshotName("20261001-101500-123.md/../x"), false);
});

test("snapshotIfChanged: first snapshot, identical content is not duplicated, change adds one", withProject(async (dir) => {
  const rel = ".pipeline/roles/engineer.md";
  await snapshotIfChanged(dir, rel, "A");
  assert.equal((await listSnapshots(dir, rel)).length, 1);
  await snapshotIfChanged(dir, rel, "A");
  assert.equal((await listSnapshots(dir, rel)).length, 1);
  await snapshotIfChanged(dir, rel, "B");
  const snaps = await listSnapshots(dir, rel);
  assert.equal(snaps.length, 2);
  // 由新到舊
  assert.equal(await readSnapshot(dir, rel, snaps[0].name), "B");
  assert.equal(await readSnapshot(dir, rel, snaps[1].name), "A");
  assert.equal(snaps[0].bytes, 1);
}));

test("snapshotIfChanged: keeps only the latest 10 snapshots (oldest removed)", withProject(async (dir) => {
  const rel = ".pipeline/roles/analyst.md";
  for (let i = 1; i <= 13; i++) await snapshotIfChanged(dir, rel, `v${i}`);
  const snaps = await listSnapshots(dir, rel);
  assert.equal(snaps.length, 10);
  const contents = [];
  for (const s of snaps) contents.push(await readSnapshot(dir, rel, s.name));
  assert.deepEqual(contents, ["v13", "v12", "v11", "v10", "v9", "v8", "v7", "v6", "v5", "v4"]);
}));

test("snapshotIfChanged: ignores files that are not rule files", withProject(async (dir) => {
  await snapshotIfChanged(dir, "README.md", "x");
  await snapshotIfChanged(dir, ".pipeline/.history/a/b.md", "x");
  assert.equal(fs.existsSync(path.join(dir, ".pipeline")), false);
}));

test("readFirstExisting records a snapshot; listTrackedFiles reports it", withProject(async (dir) => {
  writeFile(dir, ".pipeline/roles/all.md", "common");
  await readFirstExisting(dir, COMMON_RULES_FILE_CANDIDATES);
  const tracked = await listTrackedFiles(dir);
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].file, ".pipeline/roles/all.md");
  assert.equal(tracked[0].snapshots, 1);
  assert.deepEqual(await listTrackedFiles(path.join(dir, "nope")), []);
}));

test("list_rule_history / restore_rule_file: happy path saves the current content before restoring", withProject(async (dir) => {
  const rel = ".pipeline/roles/engineer.md";
  writeFile(dir, rel, "A");
  await readFirstExisting(dir, ROLE_FILE_CANDIDATES("engineer"));
  writeFile(dir, rel, "B"); // 外部修改，尚未被快照
  const { client, close } = await connectClient(registerRuleHistoryTools);
  try {
    const listed = await callTool(client, "list_rule_history", { projectDir: dir, file: rel });
    assert.equal(listed.json.success, true);
    assert.equal(listed.json.snapshots.length, 1);
    const snapshot = listed.json.snapshots[0].name;

    const restored = await callTool(client, "restore_rule_file", { projectDir: dir, file: rel, snapshot });
    assert.equal(restored.json.success, true);
    assert.equal(restored.json.restoredFrom, snapshot);
    assert.equal(fs.readFileSync(path.join(dir, rel), "utf-8"), "A");

    const after = await callTool(client, "list_rule_history", { projectDir: dir, file: rel });
    const contents = [];
    for (const s of after.json.snapshots) contents.push(await readSnapshot(dir, rel, s.name));
    assert.deepEqual(contents, ["B", "A"]);

    const all = await callTool(client, "list_rule_history", { projectDir: dir });
    assert.equal(all.json.files[0].file, rel);
    assert.equal(all.json.files[0].snapshots, 2);
  } finally {
    await close();
  }
}));

test("restore_rule_file: works when the current file no longer exists", withProject(async (dir) => {
  const rel = ".pipeline/roles/verifier.md";
  await snapshotIfChanged(dir, rel, "keep me");
  const [snap] = await listSnapshots(dir, rel);
  const { client, close } = await connectClient(registerRuleHistoryTools);
  try {
    const res = await callTool(client, "restore_rule_file", { projectDir: dir, file: rel, snapshot: snap.name });
    assert.equal(res.json.success, true);
    assert.equal(fs.readFileSync(path.join(dir, rel), "utf-8"), "keep me");
  } finally {
    await close();
  }
}));

test("rule history tools reject bad targets", withProject(async (dir) => {
  const good = "20261001-101500-123.md";
  const { client, close } = await connectClient(registerRuleHistoryTools);
  try {
    const bad = [
      { file: "README.md", snapshot: good },
      { file: ".pipeline/../README.md", snapshot: good },
      { file: ".claude/pipeline-roles/../../x.md", snapshot: good },
      { file: ".pipeline/.history/x/20260101-000000-000.md", snapshot: good },
      { file: ".pipeline/roles/engineer.md", snapshot: "../../etc/passwd" },
      { file: ".pipeline/roles/engineer.md", snapshot: "not-a-snapshot.md" },
      { file: ".pipeline/roles/engineer.md", snapshot: good }, // 格式合法但不存在
    ];
    for (const args of bad) {
      const res = await callTool(client, "restore_rule_file", { projectDir: dir, ...args });
      assert.equal(res.isError, true, JSON.stringify(args));
      assert.equal(res.json.success, false);
    }
    assert.equal(fs.existsSync(path.join(dir, ".pipeline/roles/engineer.md")), false);

    const noTarget = await callTool(client, "restore_rule_file", { file: ".pipeline/roles/engineer.md", snapshot: good });
    assert.equal(noTarget.isError, true);
    const listBad = await callTool(client, "list_rule_history", { projectDir: dir, file: "README.md" });
    assert.equal(listBad.isError, true);
    const listNone = await callTool(client, "list_rule_history", {});
    assert.equal(listNone.isError, true);
    const listEmpty = await callTool(client, "list_rule_history", { projectDir: dir });
    assert.deepEqual(listEmpty.json.files, []);
  } finally {
    await close();
  }
}));
