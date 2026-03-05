"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const { verifyPhase11StartupIntegrity } = require("../../security/phase11-startup-integrity.js");
const { setupPhase11Harness, makeTmpDir } = require("./_phase11-helpers.js");

const root = path.resolve(__dirname, "../..");

const REQUIRED_FILES = [
  "workflows/recovery-assurance/recovery-schema.js",
  "workflows/recovery-assurance/recovery-common.js",
  "workflows/recovery-assurance/checkpoint-coordinator.js",
  "workflows/recovery-assurance/backup-manifest-manager.js",
  "workflows/recovery-assurance/backup-integrity-verifier.js",
  "workflows/recovery-assurance/restore-orchestrator.js",
  "workflows/recovery-assurance/continuity-slo-engine.js",
  "workflows/recovery-assurance/chaos-drill-simulator.js",
  "workflows/recovery-assurance/failover-readiness-validator.js",
  "scripts/create-recovery-checkpoint.js",
  "scripts/verify-backup-integrity.js",
  "scripts/execute-restore.js",
  "scripts/run-recovery-drill.js",
  "scripts/generate-phase11-artifacts.js",
  "scripts/verify-phase11-policy.sh"
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

test("phase11 startup integrity succeeds when all modules are available", async () => {
  const harness = await setupPhase11Harness();
  const result = await verifyPhase11StartupIntegrity({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    rootDir: root
  });
  assert.equal(result.healthy, true, JSON.stringify(result.failures, null, 2));
});

test("phase11 startup integrity fails when required script is missing", async () => {
  const harness = await setupPhase11Harness();
  const fixtureRoot = await createFixtureRoot();
  await fsp.unlink(path.join(fixtureRoot, "scripts", "execute-restore.js"));

  const result = await verifyPhase11StartupIntegrity({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    rootDir: fixtureRoot
  });
  assert.equal(result.healthy, false);
  assert.ok(result.failures.some((entry) => entry.file === "scripts/execute-restore.js"));
});

test("phase11 startup integrity fails when recovery artifact path is not writable", async () => {
  const harness = await setupPhase11Harness();
  const nonDirectoryPath = path.join(harness.dir, "not-a-directory");
  fs.writeFileSync(nonDirectoryPath, "x", "utf8");

  const result = await verifyPhase11StartupIntegrity({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    rootDir: root,
    recoveryArtifactPath: nonDirectoryPath
  });
  assert.equal(result.healthy, false);
  assert.ok(result.failures.some((entry) => entry.check === "recovery_artifact_path"));
});
