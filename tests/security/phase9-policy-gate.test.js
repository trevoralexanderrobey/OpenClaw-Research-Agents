"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase9-policy.sh");

const REQUIRED_FIXTURE_FILES = [
  "workflows/governance-automation/compliance-monitor.js",
  "workflows/governance-automation/policy-drift-detector.js",
  "workflows/governance-automation/remediation-recommender.js",
  "workflows/governance-automation/operator-override-ledger.js",
  "workflows/governance-automation/phase-completeness-validator.js",
  "workflows/governance-automation/phase9-baseline-contracts.js",
  "security/phase9-startup-integrity.js",
  "openclaw-bridge/mcp/mcp-service.js",
  "security/runtime-policy.js",
  "scripts/apply-operator-override.js",
  "scripts/apply-remediation-delta.js",
  "scripts/generate-phase9-artifacts.js",
  "tests/security/phase9-compliance-monitor.test.js",
  "tests/security/phase9-drift-detector.test.js",
  "tests/security/phase9-remediation-recommender.test.js",
  "tests/security/phase9-override-ledger.test.js",
  "tests/security/phase9-completeness-validator.test.js",
  "tests/security/phase9-policy-gate.test.js"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase9-policy-"));
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

test("phase9 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 9 policy verification passed/);
});

test("phase9 policy gate fails when restricted globals are introduced", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "workflows", "governance-automation", "compliance-monitor.js");
  fs.appendFileSync(file, "\nconst _phase9_bad_clock = Date.now();\n", "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Determinism violation/);
});

test("phase9 policy gate fails when override ledger lacks approval-token checks", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "workflows", "governance-automation", "operator-override-ledger.js");
  const current = fs.readFileSync(file, "utf8");
  const mutated = current
    .replace(/consumeScopedApprovalToken/g, "consumeScopedApproval_REMOVED")
    .replace(/consumeApprovalToken/g, "consumeApproval_REMOVED");
  fs.writeFileSync(file, mutated, "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /override-ledger missing approval-token checks/);
});

test("phase9 policy gate is deterministic when rg is unavailable", async () => {
  const fixture = await createFixture();

  const passRun = runPolicy(fixture, { PHASE9_POLICY_FORCE_NO_RG: "1" });
  assert.equal(passRun.status, 0, passRun.stderr || passRun.stdout);

  const file = path.join(fixture, "workflows", "governance-automation", "compliance-monitor.js");
  fs.appendFileSync(file, "\nconst _phase9_bad_rng = Math.random();\n", "utf8");

  const failRun = runPolicy(fixture, { PHASE9_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(failRun.status, 0);
  assert.match(failRun.stderr, /Determinism violation/);
});
