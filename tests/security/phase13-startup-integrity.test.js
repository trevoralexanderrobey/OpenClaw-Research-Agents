"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const { verifyPhase13StartupIntegrity } = require("../../security/phase13-startup-integrity.js");
const { root, makeTmpDir, setupPhase13Harness } = require("./_phase13-helpers.js");

const REQUIRED_FILES = [
  "workflows/access-control/access-control-schema.js",
  "workflows/access-control/access-control-common.js",
  "workflows/access-control/role-permission-registry.js",
  "workflows/access-control/scope-registry.js",
  "workflows/access-control/access-decision-ledger.js",
  "workflows/access-control/token-lifecycle-manager.js",
  "workflows/access-control/permission-boundary-enforcer.js",
  "workflows/access-control/privilege-escalation-detector.js",
  "workflows/access-control/session-governance-manager.js",
  "workflows/access-control/legacy-access-bridge.js",
  "scripts/_phase13-access-utils.js",
  "scripts/issue-token.js",
  "scripts/rotate-token.js",
  "scripts/revoke-token.js",
  "scripts/validate-token.js",
  "scripts/list-active-tokens.js",
  "scripts/create-session.js",
  "scripts/validate-session.js",
  "scripts/check-access.js",
  "scripts/detect-escalation.js",
  "scripts/generate-phase13-artifacts.js",
  "scripts/verify-phase13-policy.sh",
  "security/rbac-policy.json",
  "security/scope-registry.json",
  "security/token-store.sample.json"
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

test("phase13 startup integrity succeeds when all modules are available", async () => {
  const harness = await setupPhase13Harness();
  const result = await verifyPhase13StartupIntegrity({
    apiGovernance: harness.governance,
    rootDir: root
  });
  assert.equal(result.healthy, true, JSON.stringify(result.failures, null, 2));
});

test("phase13 startup integrity fails when required file is missing", async () => {
  const harness = await setupPhase13Harness();
  const fixtureRoot = await createFixtureRoot();
  await fsp.unlink(path.join(fixtureRoot, "scripts", "issue-token.js"));

  const result = await verifyPhase13StartupIntegrity({
    apiGovernance: harness.governance,
    rootDir: fixtureRoot
  });
  assert.equal(result.healthy, false);
  assert.ok(result.failures.some((entry) => entry.file === "scripts/issue-token.js"));
});

test("phase13 startup integrity fails when access-control artifact path is not writable", async () => {
  const harness = await setupPhase13Harness();
  const nonDirectoryPath = path.join(harness.dir, "not-a-directory");
  fs.writeFileSync(nonDirectoryPath, "x", "utf8");

  const result = await verifyPhase13StartupIntegrity({
    apiGovernance: harness.governance,
    rootDir: root,
    accessControlArtifactPath: nonDirectoryPath
  });
  assert.equal(result.healthy, false);
  assert.ok(result.failures.some((entry) => entry.check === "access_control_artifact_path"));
});
