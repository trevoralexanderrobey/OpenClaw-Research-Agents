"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createBackupManifestManager } = require("../../workflows/recovery-assurance/backup-manifest-manager.js");

function sampleCheckpoint() {
  return {
    checkpoint_id: "CHK-20260305-abcdef123456",
    checkpoint_hash: "sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    prev_checkpoint_hash: "",
    chain_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    timestamp: "2026-03-05T00:00:00.000Z",
    artifacts: [
      {
        file: "audit/evidence/observability/hash-manifest.json",
        sha256: "aaaa",
        size_bytes: 10
      },
      {
        file: "audit/evidence/governance-automation/hash-manifest.json",
        sha256: "bbbb",
        size_bytes: 20
      }
    ]
  };
}

test("phase11 backup manifest manager builds deterministic manifests", () => {
  const manager = createBackupManifestManager({});
  const first = manager.buildBackupManifest(sampleCheckpoint());
  const second = manager.buildBackupManifest(sampleCheckpoint());
  assert.deepEqual(second, first);
  assert.ok(first.manifest.manifest_id.startsWith("MAN-20260305-"));
  assert.ok(first.manifest_hash.startsWith("sha256:"));
});

test("phase11 backup manifest manager enforces checkpoint references", () => {
  const manager = createBackupManifestManager({});
  assert.throws(
    () => manager.buildBackupManifest({}),
    (error) => error && error.code === "PHASE11_MANIFEST_CHECKPOINT_REQUIRED"
  );
});
