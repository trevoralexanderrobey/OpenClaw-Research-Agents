"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase8-policy.sh");

const REQUIRED_FIXTURE_FILES = [
  "workflows/compliance-governance/compliance-schema.js",
  "workflows/compliance-governance/compliance-validator.js",
  "workflows/compliance-governance/runtime-attestation-engine.js",
  "workflows/compliance-governance/evidence-bundle-builder.js",
  "workflows/compliance-governance/release-gate-governor.js",
  "workflows/compliance-governance/compliance-decision-ledger.js",
  "analytics/compliance-explainability/gate-rationale.js",
  "analytics/compliance-explainability/attestation-explainer.js",
  "security/phase8-startup-integrity.js",
  "scripts/migrate-state-v7-to-v8.js",
  "scripts/generate-phase8-artifacts.js",
  "scripts/verify-phase8-ci-health.js",
  "openclaw-bridge/mcp/mcp-service.js",
  "openclaw-bridge/execution/egress-policy.js",
  "security/runtime-policy.js"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase8-policy-"));
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

test("phase8 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 8 policy verification passed/);
});

test("phase8 policy gate fails on restricted global usage", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "workflows", "compliance-governance", "release-gate-governor.js");
  fs.appendFileSync(file, "\nconst _phase8_policy_bad_clock = Date.now();\n", "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Determinism violation/);
});

test("phase8 policy gate is deterministic when rg is unavailable", async () => {
  const fixture = await createFixture();

  const passRun = runPolicy(fixture, { PHASE8_POLICY_FORCE_NO_RG: "1" });
  assert.equal(passRun.status, 0, passRun.stderr || passRun.stdout);

  const file = path.join(fixture, "workflows", "compliance-governance", "runtime-attestation-engine.js");
  fs.appendFileSync(file, "\nconst _phase8_bad_global = Date.now();\n", "utf8");

  const failRun = runPolicy(fixture, { PHASE8_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(failRun.status, 0);
  assert.match(failRun.stderr, /Determinism violation/);
});
