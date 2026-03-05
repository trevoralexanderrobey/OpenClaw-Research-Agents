"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const { verifyPhase10StartupIntegrity } = require("../../security/phase10-startup-integrity.js");
const { setupPhase10Harness, makeTmpDir } = require("./_phase10-helpers.js");

const root = path.resolve(__dirname, "../..");

const REQUIRED_FILES = [
  "workflows/observability/metrics-schema.js",
  "workflows/observability/telemetry-emitter.js",
  "workflows/observability/slo-alert-engine.js",
  "workflows/observability/alert-router.js",
  "workflows/observability/operational-decision-ledger.js",
  "workflows/runbook-automation/runbook-orchestrator.js",
  "workflows/incident-management/incident-artifact-creator.js",
  "workflows/incident-management/escalation-orchestrator.js",
  "workflows/attestation/external-attestation-anchor.js",
  "scripts/runbook-orchestrator.js",
  "scripts/external-attestation-anchor.js",
  "scripts/incident-trigger.sh",
  "scripts/generate-phase10-artifacts.js",
  "scripts/verify-phase10-policy.sh",
  "security/phase10-attestation-egress-allowlist.json"
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

test("phase10 startup integrity succeeds when all modules are available", async () => {
  const harness = await setupPhase10Harness();
  const result = await verifyPhase10StartupIntegrity({
    apiGovernance: harness.governance,
    rootDir: root
  });
  assert.equal(result.healthy, true, JSON.stringify(result.failures, null, 2));
});

test("phase10 startup integrity fails when metrics exporter bootstrap fails", async () => {
  const harness = await setupPhase10Harness();
  const result = await verifyPhase10StartupIntegrity({
    apiGovernance: harness.governance,
    rootDir: root,
    metricsExporterFactory() {
      throw new Error("metrics unavailable");
    }
  });
  assert.equal(result.healthy, false);
  assert.ok(result.failures.some((entry) => entry.check === "metrics_exporter"));
});

test("phase10 startup integrity fails when slo definitions are invalid", async () => {
  const harness = await setupPhase10Harness();
  const result = await verifyPhase10StartupIntegrity({
    apiGovernance: harness.governance,
    rootDir: root,
    sloAlertEngineFactory() {
      return {
        evaluateSlos() {
          return {};
        }
      };
    }
  });
  assert.equal(result.healthy, false);
  assert.ok(result.failures.some((entry) => entry.check === "slo_definitions"));
});

test("phase10 startup integrity fails when runbook orchestrator cli is missing", async () => {
  const harness = await setupPhase10Harness();
  const fixtureRoot = await createFixtureRoot();
  await fsp.unlink(path.join(fixtureRoot, "scripts", "runbook-orchestrator.js"));

  const result = await verifyPhase10StartupIntegrity({
    apiGovernance: harness.governance,
    rootDir: fixtureRoot
  });
  assert.equal(result.healthy, false);
  assert.ok(result.failures.some((entry) => entry.file === "scripts/runbook-orchestrator.js"));
});

test("phase10 startup integrity fails when incident artifact path is not writable", async () => {
  const harness = await setupPhase10Harness();
  const nonDirectoryPath = path.join(harness.dir, "not-a-directory");
  fs.writeFileSync(nonDirectoryPath, "x", "utf8");

  const result = await verifyPhase10StartupIntegrity({
    apiGovernance: harness.governance,
    rootDir: root,
    incidentArtifactPath: nonDirectoryPath
  });
  assert.equal(result.healthy, false);
  assert.ok(result.failures.some((entry) => entry.check === "incident_artifact_path"));
});

test("phase10 startup integrity verifies attestation gating allowlist config", async () => {
  const harness = await setupPhase10Harness();
  const fixtureRoot = await createFixtureRoot();
  await fsp.writeFile(path.join(fixtureRoot, "security", "phase10-attestation-egress-allowlist.json"), JSON.stringify({
    schema_version: "phase10-attestation-egress-v1",
    blocked_by_default: false,
    allowed_hosts: []
  }, null, 2), "utf8");

  const result = await verifyPhase10StartupIntegrity({
    apiGovernance: harness.governance,
    rootDir: fixtureRoot
  });
  assert.equal(result.healthy, false);
  assert.ok(result.failures.some((entry) => entry.check === "attestation_gating"));
});
