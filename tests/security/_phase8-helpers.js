"use strict";

const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { createOperatorAuthorization } = require("../../security/operator-authorization.js");
const { createRuntimeAttestationEngine } = require("../../workflows/compliance-governance/runtime-attestation-engine.js");
const { createEvidenceBundleBuilder } = require("../../workflows/compliance-governance/evidence-bundle-builder.js");
const { createReleaseGateGovernor } = require("../../workflows/compliance-governance/release-gate-governor.js");
const { verifyPhase8StartupIntegrity } = require("../../security/phase8-startup-integrity.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase8-"));
}

function fixedTimeProvider() {
  let current = Date.parse("2026-03-04T10:00:00.000Z");
  return {
    nowMs() {
      const value = current;
      current += 1000;
      return value;
    },
    nowIso() {
      return new Date(this.nowMs()).toISOString();
    }
  };
}

function makeHash(char) {
  return String(char || "a").repeat(64).slice(0, 64);
}

async function setupPhase8Harness() {
  const dir = await makeTmpDir();
  const timeProvider = fixedTimeProvider();

  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    timeProvider
  });

  const authorization = createOperatorAuthorization({
    nowMs: () => Date.parse("2026-03-04T10:00:00.000Z")
  });

  const attestationEngine = createRuntimeAttestationEngine({
    apiGovernance: governance,
    operatorAuthorization: authorization,
    timeProvider
  });

  const bundleBuilder = createEvidenceBundleBuilder({
    apiGovernance: governance,
    operatorAuthorization: authorization,
    timeProvider
  });

  const governor = createReleaseGateGovernor({
    apiGovernance: governance,
    operatorAuthorization: authorization,
    timeProvider
  });

  return {
    dir,
    timeProvider,
    governance,
    authorization,
    attestationEngine,
    bundleBuilder,
    governor,
    verifyPhase8StartupIntegrity
  };
}

function issueToken(authorization, scope) {
  return authorization.issueApprovalToken({
    operatorId: "op-1",
    scope
  }).token;
}

async function createAttestation(harness, overrides = {}) {
  const payload = {
    approvalToken: issueToken(harness.authorization, "compliance.attest.capture"),
    idempotencyKey: overrides.idempotencyKey || "attest-1",
    runtimePolicyVersion: overrides.runtimePolicyVersion || "v1",
    runtimeStateSchemaVersion: 8,
    enabledGateScripts: overrides.enabledGateScripts || [
      { name: "verify-mcp-policy.sh", sha256: makeHash("b") },
      { name: "verify-phase7-policy.sh", sha256: makeHash("c") }
    ],
    egressAllowlistHash: overrides.egressAllowlistHash || makeHash("d"),
    criticalModuleHashManifest: overrides.criticalModuleHashManifest || {
      "security/api-governance.js": makeHash("e"),
      "workflows/compliance-governance/release-gate-governor.js": makeHash("f")
    }
  };

  return harness.attestationEngine.captureRuntimeAttestation(payload, {
    role: "operator",
    requester: "op-1",
    correlationId: overrides.correlationId || "phase8-attest"
  });
}

async function createBundle(harness, overrides = {}) {
  const payload = {
    approvalToken: issueToken(harness.authorization, "compliance.bundle.build"),
    idempotencyKey: overrides.idempotencyKey || "bundle-1",
    asOfIso: overrides.asOfIso || "2026-03-04T10:00:00.000Z",
    checkResults: overrides.checkResults || {
      "phase2-gates": "pass",
      "mcp-policy": "pass",
      "phase6-policy": "pass",
      "phase7-policy": "pass"
    },
    artifactManifest: overrides.artifactManifest || [
      { file: "audit/evidence/phase7/rollout-decisions.json", sha256: makeHash("1") },
      { file: "audit/evidence/phase7/decision-ledger-chain.json", sha256: makeHash("2") }
    ]
  };

  return harness.bundleBuilder.buildEvidenceBundle(payload, {
    role: "operator",
    requester: "op-1",
    correlationId: overrides.correlationId || "phase8-bundle"
  });
}

module.exports = {
  setupPhase8Harness,
  issueToken,
  createAttestation,
  createBundle,
  makeHash
};
