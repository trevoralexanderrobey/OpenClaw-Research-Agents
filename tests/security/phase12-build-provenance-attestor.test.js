"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createBuildProvenanceAttestor } = require("../../workflows/supply-chain/build-provenance-attestor.js");

const artifactPath = path.resolve(__dirname, "../..", "package-lock.json");

test("phase12 build provenance attestor is deterministic", () => {
  const attestor = createBuildProvenanceAttestor({
    timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" }
  });

  const input = {
    commit_sha: "03295ceea3e4620507fa6d88df4f6a2324c899f8",
    builder_identity: "phase12-test",
    sbom_hash: "sha256:test",
    artifacts: [{ artifact_path: artifactPath }],
    policy_gates: { phase12: "pass" }
  };

  const first = attestor.generateProvenance(input);
  const second = attestor.generateProvenance(input);

  assert.equal(first.provenance_hash, second.provenance_hash);
  assert.deepEqual(second.provenance, first.provenance);
});

test("phase12 build provenance attestor requires explicit commit and builder", () => {
  const attestor = createBuildProvenanceAttestor({
    timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" }
  });

  assert.throws(() => attestor.generateProvenance({
    builder_identity: "phase12-test",
    sbom_hash: "sha256:test",
    artifacts: [{ artifact_path: artifactPath }]
  }), /commit_sha is required/);

  assert.throws(() => attestor.generateProvenance({
    commit_sha: "03295ceea3e4620507fa6d88df4f6a2324c899f8",
    sbom_hash: "sha256:test",
    artifacts: [{ artifact_path: artifactPath }]
  }), /builder_identity is required/);
});
