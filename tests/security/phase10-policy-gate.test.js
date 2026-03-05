"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase10-policy.sh");

const REQUIRED_FIXTURE_FILES = [
  "workflows/observability/metrics-schema.js",
  "workflows/observability/telemetry-emitter.js",
  "workflows/observability/slo-alert-engine.js",
  "workflows/observability/alert-router.js",
  "workflows/observability/operational-decision-ledger.js",
  "workflows/runbook-automation/runbook-orchestrator.js",
  "workflows/incident-management/incident-artifact-creator.js",
  "workflows/incident-management/escalation-orchestrator.js",
  "workflows/attestation/external-attestation-anchor.js",
  "security/phase10-startup-integrity.js",
  "security/phase10-attestation-egress-allowlist.json",
  "openclaw-bridge/mcp/mcp-service.js",
  "security/runtime-policy.js",
  "scripts/runbook-orchestrator.js",
  "scripts/incident-trigger.sh",
  "scripts/external-attestation-anchor.js",
  "scripts/generate-phase10-artifacts.js",
  "scripts/verify-phase10-policy.sh",
  "tests/security/phase10-metrics-schema.test.js",
  "tests/security/phase10-telemetry-emitter.test.js",
  "tests/security/phase10-slo-alert-engine.test.js",
  "tests/security/phase10-runbook-orchestrator.test.js",
  "tests/security/phase10-alert-router.test.js",
  "tests/security/phase10-incident-artifact-creator.test.js",
  "tests/security/phase10-escalation-orchestrator.test.js",
  "tests/security/phase10-external-attestation-anchor.test.js",
  "tests/security/phase10-policy-gate.test.js",
  "tests/security/phase10-startup-integrity.test.js",
  "docs/phase10-operational-runbook.md"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase10-policy-"));
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

test("phase10 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 10 policy verification passed/);
});

test("phase10 policy gate fails when automatic external egress marker is introduced", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "workflows", "observability", "metrics-schema.js");
  fs.appendFileSync(file, "\nfetch(\"https://bad.example\");\n", "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /must not include autonomous network\/browser automation clients/);
});

test("phase10 policy gate fails when advisory alerting module triggers remediation", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "workflows", "observability", "alert-router.js");
  fs.appendFileSync(file, "\nconst _bad = \"apply-remediation-delta\";\n", "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Advisory module must not trigger remediation\/mutation flows/);
});

test("phase10 policy gate fails when runbook approval contract is removed", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "workflows", "runbook-automation", "runbook-orchestrator.js");
  const current = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, current.replace(/approvalToken/g, "tokenRemoved"), "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Runbook orchestrator missing approval token contract/);
});

test("phase10 policy gate deterministic fallback works without rg", async () => {
  const fixture = await createFixture();
  const passRun = runPolicy(fixture, { PHASE10_POLICY_FORCE_NO_RG: "1" });
  assert.equal(passRun.status, 0, passRun.stderr || passRun.stdout);

  const file = path.join(fixture, "workflows", "observability", "slo-alert-engine.js");
  fs.appendFileSync(file, "\nconst _bad = Math.random();\n", "utf8");
  const failRun = runPolicy(fixture, { PHASE10_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(failRun.status, 0);
  assert.match(failRun.stderr, /Determinism violation/);
});
