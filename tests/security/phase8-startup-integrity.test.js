"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { createMcpService } = require("../../openclaw-bridge/mcp/mcp-service.js");

const {
  setupPhase8Harness,
  createAttestation,
  createBundle,
  issueToken
} = require("./_phase8-helpers.js");

const {
  verifyPhase8StartupIntegrity
} = require("../../security/phase8-startup-integrity.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase8-startup-"));
}

test("phase8 startup integrity succeeds for valid state", async () => {
  const harness = await setupPhase8Harness();
  await createAttestation(harness, { idempotencyKey: "startup-ok-attest" });
  await createBundle(harness, { idempotencyKey: "startup-ok-bundle" });
  await harness.governor.applyReleaseGateDecision({
    approvalToken: issueToken(harness.authorization, "compliance.release.apply"),
    idempotencyKey: "startup-ok-decision",
    targetRef: "refs/heads/main",
    targetSha: "a".repeat(64)
  }, {
    role: "operator",
    requester: "op-1"
  });

  const verified = await verifyPhase8StartupIntegrity({
    apiGovernance: harness.governance,
    logger: { info() {}, warn() {}, error() {} }
  });

  assert.equal(verified.ok, true);
  assert.equal(verified.decisions, 1);
});

test("phase8 startup integrity fails closed on anchor mismatch", async () => {
  const harness = await setupPhase8Harness();
  await createAttestation(harness, { idempotencyKey: "startup-bad-attest" });
  await createBundle(harness, { idempotencyKey: "startup-bad-bundle" });
  await harness.governor.applyReleaseGateDecision({
    approvalToken: issueToken(harness.authorization, "compliance.release.apply"),
    idempotencyKey: "startup-bad-decision",
    targetRef: "refs/heads/main",
    targetSha: "b".repeat(64)
  }, {
    role: "operator",
    requester: "op-1"
  });

  await harness.governance.withGovernanceTransaction(async (tx) => {
    tx.state.complianceGovernance.decisionLedger.chainHead = "f".repeat(64);
  });

  await assert.rejects(
    () => verifyPhase8StartupIntegrity({
      apiGovernance: harness.governance,
      logger: { info() {}, warn() {}, error() {} }
    }),
    (error) => error && error.code === "PHASE8_LEDGER_CHAIN_HEAD_MISMATCH"
  );
});

test("mcp service initialize fails before serving methods when phase8 startup integrity fails", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });

  await governance.withGovernanceTransaction(async (tx) => {
    tx.state.complianceGovernance.decisionLedger.chainHead = "a".repeat(64);
  });

  const service = createMcpService({ apiGovernance: governance });

  await assert.rejects(
    () => service.initialize(),
    (error) => error && error.code === "PHASE8_LEDGER_CHAIN_HEAD_MISMATCH"
  );

  await assert.rejects(
    () => service.handle("analytics.monetizationScore", {}, { correlationId: "phase8-startup-gate" }),
    (error) => error && error.code === "PHASE8_LEDGER_CHAIN_HEAD_MISMATCH"
  );
});
