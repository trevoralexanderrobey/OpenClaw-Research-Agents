"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const {
  setupPhase8Harness,
  createAttestation,
  createBundle,
  issueToken
} = require("./_phase8-helpers.js");
const {
  buildGateRationale
} = require("../../analytics/compliance-explainability/gate-rationale.js");
const {
  buildComplianceExplainabilityReport,
  writePhase8Artifacts
} = require("../../analytics/compliance-explainability/attestation-explainer.js");

function hashFile(filePath) {
  const body = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(body).digest("hex");
}

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase8-explain-"));
}

test("gate rationale ranking is deterministic", () => {
  const input = {
    evaluation: {
      decision: "block",
      reasonCode: "missing_evidence",
      missingChecks: ["phase7-policy", "mcp-policy"],
      freshnessHours: 12,
      targetRef: "refs/heads/main",
      targetSha: "a".repeat(64),
      asOfIso: "2026-03-04T10:00:00.000Z",
      policySnapshotHash: "b".repeat(64)
    }
  };

  const first = buildGateRationale(input);
  const second = buildGateRationale(input);
  assert.deepEqual(first, second);
});

test("compliance explainability report is deterministic", () => {
  const input = {
    asOfIso: "2026-03-04T10:00:00.000Z",
    evaluation: {
      decision: "allow",
      reasonCode: "all_checks_passed",
      missingChecks: [],
      targetRef: "refs/heads/main",
      targetSha: "c".repeat(64),
      asOfIso: "2026-03-04T10:00:00.000Z",
      policySnapshotHash: "d".repeat(64)
    }
  };

  const first = buildComplianceExplainabilityReport(input);
  const second = buildComplianceExplainabilityReport(input);
  assert.deepEqual(first, second);
});

test("phase8 artifact writer is deterministic for equal inputs", async () => {
  const harness = await setupPhase8Harness();
  await createAttestation(harness, { idempotencyKey: "explain-attest" });
  await createBundle(harness, { idempotencyKey: "explain-bundle" });
  await harness.governor.applyReleaseGateDecision({
    approvalToken: issueToken(harness.authorization, "compliance.release.apply"),
    idempotencyKey: "explain-decision",
    targetRef: "refs/heads/main",
    targetSha: "e".repeat(64)
  }, {
    role: "operator",
    requester: "op-1"
  });

  const one = await makeTmpDir();
  const two = await makeTmpDir();

  await writePhase8Artifacts({
    apiGovernance: harness.governance,
    releaseGateGovernor: harness.governor,
    outDir: one,
    asOfIso: "2026-03-04T10:00:00.000Z",
    targetRef: "refs/heads/main",
    targetSha: "e".repeat(64)
  });

  await writePhase8Artifacts({
    apiGovernance: harness.governance,
    releaseGateGovernor: harness.governor,
    outDir: two,
    asOfIso: "2026-03-04T10:00:00.000Z",
    targetRef: "refs/heads/main",
    targetSha: "e".repeat(64)
  });

  const files = [
    "runtime-attestation.json",
    "compliance-bundle.json",
    "release-gate-evaluation.json",
    "release-gate-decisions.json",
    "compliance-ledger-chain.json",
    "compliance-explainability-report.md",
    "phase8-hash-manifest.json"
  ];

  for (const file of files) {
    assert.equal(hashFile(path.join(one, file)), hashFile(path.join(two, file)), `hash mismatch for ${file}`);
  }
});
