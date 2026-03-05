"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase12-policy.sh");

const REQUIRED_FIXTURE_FILES = [
  "workflows/supply-chain/supply-chain-schema.js",
  "workflows/supply-chain/supply-chain-common.js",
  "workflows/supply-chain/sbom-generator.js",
  "workflows/supply-chain/dependency-integrity-verifier.js",
  "workflows/supply-chain/build-provenance-attestor.js",
  "workflows/supply-chain/dependency-update-governor.js",
  "workflows/supply-chain/vulnerability-reporter.js",
  "workflows/supply-chain/supply-chain-policy-engine.js",
  "workflows/supply-chain/artifact-signing-manager.js",
  "security/phase12-startup-integrity.js",
  "openclaw-bridge/mcp/mcp-service.js",
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
  "security/artifact-signing-key.sample.json",
  "security/supply-chain-policy.json",
  "tests/security/phase12-supply-chain-schema.test.js",
  "tests/security/phase12-sbom-generator.test.js",
  "tests/security/phase12-dependency-integrity-verifier.test.js",
  "tests/security/phase12-build-provenance-attestor.test.js",
  "tests/security/phase12-dependency-update-governor.test.js",
  "tests/security/phase12-vulnerability-reporter.test.js",
  "tests/security/phase12-supply-chain-policy-engine.test.js",
  "tests/security/phase12-artifact-signing-manager.test.js",
  "tests/security/phase12-policy-gate.test.js",
  "tests/security/phase12-startup-integrity.test.js",
  "docs/phase12-supply-chain-security.md"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase12-policy-"));
  for (const rel of REQUIRED_FIXTURE_FILES) {
    const src = path.join(root, rel);
    const dst = path.join(tmp, rel);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  }
  return tmp;
}

function runPolicy(rootDir, env = {}) {
  return spawnSync("bash", [scriptPath, "--root", rootDir], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });
}

test("phase12 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 12 policy verification passed/);
});

test("phase12 policy gate fails on restricted globals in phase12 modules", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "workflows", "supply-chain", "sbom-generator.js");
  fs.appendFileSync(file, "\nconst _bad = Date.now();\n", "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Determinism violation/);
});

test("phase12 policy gate fails when update approval contract is removed", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "workflows", "supply-chain", "dependency-update-governor.js");
  const current = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, current.replace(/approvalToken/g, "tokenRemoved"), "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing approval token contract/);
});

test("phase12 policy gate deterministic fallback works without rg", async () => {
  const fixture = await createFixture();
  const passRun = runPolicy(fixture, { PHASE12_POLICY_FORCE_NO_RG: "1" });
  assert.equal(passRun.status, 0, passRun.stderr || passRun.stdout);

  const file = path.join(fixture, "workflows", "supply-chain", "artifact-signing-manager.js");
  fs.appendFileSync(file, "\nconst _bad = Math.random();\n", "utf8");
  const failRun = runPolicy(fixture, { PHASE12_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(failRun.status, 0);
  assert.match(failRun.stderr, /Determinism violation/);
});
