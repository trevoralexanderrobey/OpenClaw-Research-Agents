"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase11-policy.sh");

const REQUIRED_FIXTURE_FILES = [
  "workflows/recovery-assurance/recovery-schema.js",
  "workflows/recovery-assurance/recovery-common.js",
  "workflows/recovery-assurance/checkpoint-coordinator.js",
  "workflows/recovery-assurance/backup-manifest-manager.js",
  "workflows/recovery-assurance/backup-integrity-verifier.js",
  "workflows/recovery-assurance/restore-orchestrator.js",
  "workflows/recovery-assurance/continuity-slo-engine.js",
  "workflows/recovery-assurance/chaos-drill-simulator.js",
  "workflows/recovery-assurance/failover-readiness-validator.js",
  "security/phase11-startup-integrity.js",
  "openclaw-bridge/mcp/mcp-service.js",
  "scripts/create-recovery-checkpoint.js",
  "scripts/verify-backup-integrity.js",
  "scripts/execute-restore.js",
  "scripts/run-recovery-drill.js",
  "scripts/generate-phase11-artifacts.js",
  "scripts/verify-phase11-policy.sh",
  "tests/security/phase11-recovery-schema.test.js",
  "tests/security/phase11-checkpoint-coordinator.test.js",
  "tests/security/phase11-backup-manifest-manager.test.js",
  "tests/security/phase11-backup-integrity-verifier.test.js",
  "tests/security/phase11-restore-orchestrator.test.js",
  "tests/security/phase11-continuity-slo-engine.test.js",
  "tests/security/phase11-chaos-drill-simulator.test.js",
  "tests/security/phase11-failover-readiness-validator.test.js",
  "tests/security/phase11-policy-gate.test.js",
  "tests/security/phase11-startup-integrity.test.js",
  "docs/phase11-recovery-assurance.md"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase11-policy-"));
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

test("phase11 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 11 policy verification passed/);
});

test("phase11 policy gate fails on restricted globals in phase11 modules", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "workflows", "recovery-assurance", "continuity-slo-engine.js");
  fs.appendFileSync(file, "\nconst _bad = Date.now();\n", "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Determinism violation/);
});

test("phase11 policy gate fails when restore approval contract is removed", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "workflows", "recovery-assurance", "restore-orchestrator.js");
  const current = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, current.replace(/approvalToken/g, "tokenRemoved"), "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing approval token contract/);
});

test("phase11 policy gate deterministic fallback works without rg", async () => {
  const fixture = await createFixture();
  const passRun = runPolicy(fixture, { PHASE11_POLICY_FORCE_NO_RG: "1" });
  assert.equal(passRun.status, 0, passRun.stderr || passRun.stdout);

  const file = path.join(fixture, "workflows", "recovery-assurance", "chaos-drill-simulator.js");
  fs.appendFileSync(file, "\nconst _bad = Math.random();\n", "utf8");
  const failRun = runPolicy(fixture, { PHASE11_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(failRun.status, 0);
  assert.match(failRun.stderr, /Determinism violation/);
});
