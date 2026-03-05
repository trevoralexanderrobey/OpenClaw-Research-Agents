"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { createBackupManifestManager } = require("../../workflows/recovery-assurance/backup-manifest-manager.js");
const { createBackupIntegrityVerifier } = require("../../workflows/recovery-assurance/backup-integrity-verifier.js");
const { makeTmpDir } = require("./_phase11-helpers.js");

async function sampleManifestFixture() {
  const dir = await makeTmpDir();
  const file = path.join(dir, "artifact.json");
  fs.writeFileSync(file, "{\"ok\":true}\n", "utf8");
  const artifactHash = require("../../workflows/governance-automation/common.js").hashFile(file);

  const manager = createBackupManifestManager({});
  const checkpoint = {
    checkpoint_id: "CHK-20260305-abcdef123456",
    checkpoint_hash: "sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    prev_checkpoint_hash: "",
    chain_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    timestamp: "2026-03-05T00:00:00.000Z",
    artifacts: [
      {
        file: "artifact.json",
        sha256: artifactHash,
        size_bytes: 12
      }
    ]
  };

  const built = manager.buildBackupManifest(checkpoint);
  return { dir, manifest: built.manifest };
}

test("phase11 backup integrity verifier passes for valid manifest and artifacts", async () => {
  const fixture = await sampleManifestFixture();
  const verifier = createBackupIntegrityVerifier({});
  const result = verifier.verifyBackupIntegrity({ manifest: fixture.manifest, rootDir: fixture.dir });
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
  assert.equal(result.tamper_detected, false);
});

test("phase11 backup integrity verifier detects missing artifacts and tamper", async () => {
  const fixture = await sampleManifestFixture();
  const verifier = createBackupIntegrityVerifier({});

  fs.unlinkSync(path.join(fixture.dir, "artifact.json"));
  const missing = verifier.verifyBackupIntegrity({ manifest: fixture.manifest, rootDir: fixture.dir });
  assert.equal(missing.valid, false);
  assert.equal(missing.tamper_detected, true);
  assert.equal(missing.missing_artifacts.includes("artifact.json"), true);
});

test("phase11 backup integrity verifier fails closed for malformed input", () => {
  const verifier = createBackupIntegrityVerifier({});
  const result = verifier.verifyBackupIntegrity(null);
  assert.equal(result.valid, false);
  assert.equal(result.tamper_detected, true);
});
