"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { createArtifactSigningManager } = require("../../workflows/supply-chain/artifact-signing-manager.js");
const { makeTmpDir } = require("./_phase12-helpers.js");

test("phase12 artifact signing manager signs and verifies deterministically", async () => {
  const dir = await makeTmpDir();
  const artifactPath = path.join(dir, "artifact.txt");
  const keyPath = path.join(dir, "artifact-signing-key.json");

  fs.writeFileSync(artifactPath, "artifact-data\n", "utf8");
  fs.writeFileSync(keyPath, JSON.stringify({
    schema_version: "phase12-artifact-signing-key-v1",
    key_id: "test-key",
    hmac_secret: "secret-value"
  }, null, 2));

  const manager = createArtifactSigningManager({
    keyPath,
    timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" }
  });

  const first = manager.signArtifact({
    artifact_path: artifactPath,
    sbom_hash: "sha256:sbom",
    provenance_hash: "sha256:prov"
  });
  const second = manager.signArtifact({
    artifact_path: artifactPath,
    sbom_hash: "sha256:sbom",
    provenance_hash: "sha256:prov"
  });

  assert.equal(first.signature_hash, second.signature_hash);
  assert.deepEqual(second.signature_record, first.signature_record);

  const verify = manager.verifySignature(first.signature_record, keyPath);
  assert.equal(verify.valid, true, JSON.stringify(verify, null, 2));

  fs.writeFileSync(artifactPath, "tampered\n", "utf8");
  const tampered = manager.verifySignature(first.signature_record, keyPath);
  assert.equal(tampered.valid, false);
});
