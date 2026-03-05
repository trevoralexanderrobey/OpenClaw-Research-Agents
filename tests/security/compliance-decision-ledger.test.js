"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  setupPhase8Harness,
  issueToken,
  createAttestation,
  createBundle
} = require("./_phase8-helpers.js");
const {
  verifyComplianceDecisionIntegrity,
  repairTruncatedComplianceLedgerTail
} = require("../../workflows/compliance-governance/compliance-decision-ledger.js");

test("decision hash is stable across replay", async () => {
  const harness = await setupPhase8Harness();
  await createAttestation(harness, { idempotencyKey: "attest-ledger-stable" });
  await createBundle(harness, { idempotencyKey: "bundle-ledger-stable" });

  const first = await harness.governor.applyReleaseGateDecision({
    approvalToken: issueToken(harness.authorization, "compliance.release.apply"),
    idempotencyKey: "decision-stable",
    targetRef: "refs/heads/main",
    targetSha: "a".repeat(64)
  }, {
    role: "operator",
    requester: "op-1"
  });

  const second = await harness.governor.applyReleaseGateDecision({
    approvalToken: issueToken(harness.authorization, "compliance.release.apply"),
    idempotencyKey: "decision-stable",
    targetRef: "refs/heads/main",
    targetSha: "a".repeat(64)
  }, {
    role: "operator",
    requester: "op-1"
  });

  assert.equal(first.decision.decisionHash, second.decision.decisionHash);
  assert.deepEqual(first.decision, second.decision);
});

test("decision ledger tamper triggers fail-closed", async () => {
  const harness = await setupPhase8Harness();
  await createAttestation(harness, { idempotencyKey: "attest-ledger-tamper" });
  await createBundle(harness, { idempotencyKey: "bundle-ledger-tamper" });

  await harness.governor.applyReleaseGateDecision({
    approvalToken: issueToken(harness.authorization, "compliance.release.apply"),
    idempotencyKey: "decision-tamper",
    targetRef: "refs/heads/main",
    targetSha: "b".repeat(64)
  }, {
    role: "operator",
    requester: "op-1"
  });

  await harness.governance.withGovernanceTransaction(async (tx) => {
    tx.state.complianceGovernance.decisionLedger.chainHead = "f".repeat(64);
  });

  const state = await harness.governance.readState();
  assert.throws(
    () => verifyComplianceDecisionIntegrity(state),
    (error) => error && error.code === "PHASE8_LEDGER_CHAIN_HEAD_MISMATCH"
  );
});

test("truncated-tail repair restores ledger chain", async () => {
  const harness = await setupPhase8Harness();
  await createAttestation(harness, { idempotencyKey: "attest-ledger-repair" });
  await createBundle(harness, { idempotencyKey: "bundle-ledger-repair" });

  await harness.governor.applyReleaseGateDecision({
    approvalToken: issueToken(harness.authorization, "compliance.release.apply"),
    idempotencyKey: "decision-repair",
    targetRef: "refs/heads/main",
    targetSha: "c".repeat(64)
  }, {
    role: "operator",
    requester: "op-1"
  });

  await harness.governance.withGovernanceTransaction(async (tx) => {
    tx.state.complianceGovernance.decisionLedger.records = [];
    tx.state.complianceGovernance.decisionLedger.chainHead = "";
    tx.state.complianceGovernance.decisionLedger.nextSequence = 0;
  });

  await harness.governance.withGovernanceTransaction(async (tx) => {
    const repaired = repairTruncatedComplianceLedgerTail(tx.state);
    assert.equal(repaired.repaired, true);
  });

  const state = await harness.governance.readState();
  const verified = verifyComplianceDecisionIntegrity(state);
  assert.equal(verified.ok, true);
  assert.equal(verified.actual.count, 1);
});
