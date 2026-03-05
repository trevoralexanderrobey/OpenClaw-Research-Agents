"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const { verifyPhase12StartupIntegrity } = require("../../security/phase12-startup-integrity.js");
const { setupPhase12Harness, makeTmpDir } = require("./_phase12-helpers.js");

const root = path.resolve(__dirname, "../..");

const REQUIRED_FILES = [
  "workflows/supply-chain/supply-chain-schema.js",
  "workflows/supply-chain/supply-chain-common.js",
  "workflows/supply-chain/sbom-generator.js",
  "workflows/supply-chain/dependency-integrity-verifier.js",
  "workflows/supply-chain/build-provenance-attestor.js",
  "workflows/supply-chain/dependency-update-governor.js",
  "workflows/supply-chain/vulnerability-reporter.js",
  "workflows/supply-chain/supply-chain-policy-engine.js",
  "workflows/supply-chain/artifact-signing-manager.js",
  "scripts/generate-sbom.js",
  "scripts/verify-dependency-integrity.js",
  "scripts/generate-build-provenance.js",
  "scripts/approve-dependency-update.js",
  "scripts/scan-vulnerabilities.js",
  "scripts/sign-artifact.js",
  "scripts/verify-artifact-signature.js",
  "scripts/generate-phase12-artifacts.js",
  "scripts/verify-phase12-policy.sh",
  "security/known-good-dependencies.json",
  "security/vulnerability-advisories.json",
  "security/supply-chain-policy.json",
  "security/artifact-signing-key.sample.json"
];

async function createFixtureRoot() {
  const tmp = await makeTmpDir();
  for (const rel of REQUIRED_FILES) {
    const src = path.join(root, rel);
    const dst = path.join(tmp, rel);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  }
  return tmp;
}

test("phase12 startup integrity succeeds when all modules are available", async () => {
  const harness = await setupPhase12Harness();
  const result = await verifyPhase12StartupIntegrity({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    rootDir: root
  });
  assert.equal(result.healthy, true, JSON.stringify(result.failures, null, 2));
});

test("phase12 startup integrity fails when required script is missing", async () => {
  const harness = await setupPhase12Harness();
  const fixtureRoot = await createFixtureRoot();
  await fsp.unlink(path.join(fixtureRoot, "scripts", "approve-dependency-update.js"));

  const result = await verifyPhase12StartupIntegrity({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    rootDir: fixtureRoot
  });
  assert.equal(result.healthy, false);
  assert.ok(result.failures.some((entry) => entry.file === "scripts/approve-dependency-update.js"));
});

test("phase12 startup integrity fails when supply-chain artifact path is not writable", async () => {
  const harness = await setupPhase12Harness();
  const nonDirectoryPath = path.join(harness.dir, "not-a-directory");
  fs.writeFileSync(nonDirectoryPath, "x", "utf8");

  const result = await verifyPhase12StartupIntegrity({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    rootDir: root,
    supplyChainArtifactPath: nonDirectoryPath
  });
  assert.equal(result.healthy, false);
  assert.ok(result.failures.some((entry) => entry.check === "supply_chain_artifact_path"));
});
