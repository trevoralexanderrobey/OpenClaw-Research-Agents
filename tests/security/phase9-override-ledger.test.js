"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { setupPhase9Harness, issueToken } = require("./_phase9-helpers.js");

test("phase9 override ledger rejects missing approval token", async () => {
  const harness = await setupPhase9Harness();
  await assert.rejects(
    () => harness.overrideLedger.recordOverride({
      scope: "phase9",
      reason: "test",
      phase_impact: "none",
      override_policy: "policy"
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_REQUIRED"
  );
});

test("phase9 override ledger rejects invalid token scope", async () => {
  const harness = await setupPhase9Harness();
  const wrongToken = issueToken(harness.authorization, "compliance.release.apply");

  await assert.rejects(
    () => harness.overrideLedger.recordOverride({
      approvalToken: wrongToken,
      scope: "phase9",
      reason: "test",
      phase_impact: "none",
      override_policy: "policy"
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );
});

test("phase9 override ledger records immutable chained entries", async () => {
  const harness = await setupPhase9Harness();

  const first = await harness.overrideLedger.recordOverride({
    approvalToken: issueToken(harness.authorization, "governance.override.apply"),
    scope: "phase9",
    reason: "required exception",
    phase_impact: "temporary",
    override_policy: "no skip logic"
  }, {
    role: "operator",
    requester: "op-1"
  });

  const second = await harness.overrideLedger.recordOverride({
    approvalToken: issueToken(harness.authorization, "governance.override.apply"),
    scope: "phase9",
    reason: "second",
    phase_impact: "temporary",
    override_policy: "token scope clause"
  }, {
    role: "operator",
    requester: "op-1"
  });

  assert.equal(typeof first.ledgerHash, "string");
  assert.equal(typeof second.ledgerHash, "string");
  assert.notEqual(second.ledgerHash, first.ledgerHash);

  const valid = await harness.overrideLedger.verifyOverrideLedgerIntegrity();
  assert.deepEqual(valid, { valid: true, tamper_detected: false });
});

test("phase9 override ledger tamper detection works", async () => {
  const harness = await setupPhase9Harness();

  await harness.overrideLedger.recordOverride({
    approvalToken: issueToken(harness.authorization, "governance.override.apply"),
    scope: "phase9",
    reason: "required exception",
    phase_impact: "temporary",
    override_policy: "no skip logic"
  }, {
    role: "operator",
    requester: "op-1"
  });

  await harness.governance.withGovernanceTransaction(async (tx) => {
    tx.state.complianceGovernance.operatorOverrideLedger.records[0].chain_hash = "a".repeat(64);
  });

  const invalid = await harness.overrideLedger.verifyOverrideLedgerIntegrity();
  assert.deepEqual(invalid, { valid: false, tamper_detected: true });
});
