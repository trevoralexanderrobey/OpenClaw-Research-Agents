"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { createDependencyIntegrityVerifier } = require("../../workflows/supply-chain/dependency-integrity-verifier.js");
const { makeTmpDir } = require("./_phase12-helpers.js");

function manifest(componentHash) {
  return {
    schema_version: "phase12-supply-chain-v1",
    generated_at: "2026-03-05T00:00:00.000Z",
    components: [{
      name: "zod",
      version: "3.24.1",
      purl: "pkg:npm/zod@3.24.1",
      license: "MIT",
      package_hash_sha256: componentHash,
      dependency_depth: 1,
      direct_dependency: true
    }]
  };
}

function sbom(componentHash) {
  return {
    components: [{
      name: "zod",
      version: "3.24.1",
      purl: "pkg:npm/zod@3.24.1",
      license: "MIT",
      package_hash_sha256: componentHash,
      dependency_depth: 1,
      direct_dependency: true
    }]
  };
}

test("phase12 dependency integrity verifier passes on exact match", async () => {
  const dir = await makeTmpDir();
  const knownGoodPath = path.join(dir, "known-good.json");
  fs.writeFileSync(knownGoodPath, JSON.stringify(manifest("abc123"), null, 2));

  const verifier = createDependencyIntegrityVerifier({ knownGoodPath });
  const result = verifier.verifyDependencyIntegrity(sbom("abc123"));

  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
  assert.equal(result.violations.length, 0);
});

test("phase12 dependency integrity verifier fails closed on hash mismatch", async () => {
  const dir = await makeTmpDir();
  const knownGoodPath = path.join(dir, "known-good.json");
  fs.writeFileSync(knownGoodPath, JSON.stringify(manifest("abc123"), null, 2));

  const verifier = createDependencyIntegrityVerifier({ knownGoodPath });
  const result = verifier.verifyDependencyIntegrity(sbom("def456"));

  assert.equal(result.valid, false);
  assert.ok(result.hash_mismatches.includes("zod@3.24.1"));
  assert.ok(result.violations.some((entry) => entry.code === "dependency_hash_mismatch"));
});
