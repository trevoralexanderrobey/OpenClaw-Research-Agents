"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  EXPORT_MANIFEST_SCHEMA,
  REENTRY_MANIFEST_SCHEMA,
  createSiderHandoffManager
} = require("../../openclaw-bridge/bridge/sider-handoff-manager.js");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-phase27-sider-"));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("phase27 exportBrief writes deterministic redacted artifacts", async () => {
  const rootDir = makeTmpDir();
  const manager = createSiderHandoffManager({
    rootDir,
    timeProvider: { nowIso: () => "2026-03-15T01:02:03.000Z" }
  });

  const result = await manager.exportBrief({
    exchange_id: "exchange_001",
    operator_id: "operator_1",
    source_task_ids: ["task-b", "task-a", "task-a"],
    brief_markdown: "Use Bearer sk_secret_token and security/token-store.json in notes."
  });

  const brief = fs.readFileSync(result.brief_path, "utf8");
  assert.match(brief, /\[REDACTED\]/);
  assert.doesNotMatch(brief, /Bearer\s+sk_secret_token/);
  assert.doesNotMatch(brief, /security\/token-store\.json/);

  const manifest = readJson(result.manifest_path);
  assert.equal(manifest.schema_version, EXPORT_MANIFEST_SCHEMA);
  assert.equal(manifest.data_policy, "redacted_only");
  assert.deepEqual(manifest.source_task_ids, ["task-a", "task-b"]);
  assert.equal(manifest.exported_at, "2026-03-15T01:02:03.000Z");
  assert.equal(manifest.brief_sha256, result.brief_sha256);
});

test("phase27 importApprovedResponse requires export hash linkage and writes reentry manifest", async () => {
  const rootDir = makeTmpDir();
  const manager = createSiderHandoffManager({
    rootDir,
    timeProvider: { nowIso: () => "2026-03-15T04:05:06.000Z" }
  });

  const exported = await manager.exportBrief({
    exchange_id: "exchange_002",
    operator_id: "operator_2",
    source_task_ids: ["task-1"],
    brief_markdown: "Safe brief content."
  });

  await assert.rejects(
    () =>
      manager.importApprovedResponse({
        exchange_id: "exchange_002",
        operator_id: "operator_2",
        task_reference_id: "task-next",
        source_export_hash: "deadbeef",
        approved_response_markdown: "Approved response"
      }),
    (error) => error && error.code === "PHASE27_SOURCE_EXPORT_HASH_MISMATCH"
  );

  const imported = await manager.importApprovedResponse({
    exchange_id: "exchange_002",
    operator_id: "operator_2",
    task_reference_id: "task-next",
    source_export_hash: exported.brief_sha256,
    approved_response_markdown: "Approved response with token=abc should redact token=abc"
  });

  const manifest = readJson(imported.manifest_path);
  assert.equal(manifest.schema_version, REENTRY_MANIFEST_SCHEMA);
  assert.equal(manifest.source_export_hash, exported.brief_sha256);
  assert.equal(manifest.task_reference_id, "task-next");
  assert.equal(manifest.imported_at, "2026-03-15T04:05:06.000Z");
});
