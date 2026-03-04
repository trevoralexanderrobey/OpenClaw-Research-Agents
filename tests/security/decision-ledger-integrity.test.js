"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  setupPhase7Harness,
  issueToken,
  createAndStartExperiment
} = require("./_phase7-helpers.js");

const {
  verifyRolloutDecisionIntegrity
} = require("../../workflows/experiment-governance/decision-ledger.js");

test("decision ledger tamper triggers fail-closed integrity error", async () => {
  const harness = await setupPhase7Harness();
  const experiment = await createAndStartExperiment(harness);

  await harness.governor.applyRolloutDecision({
    approvalToken: issueToken(harness.authorization, "experiment.rollout.apply"),
    experimentSequence: Number(experiment.sequence),
    decision: "hold",
    reasonCode: "operator_override",
    idempotencyKey: "ledger-tamper-1"
  }, {
    role: "operator",
    requester: "op-1"
  });

  await harness.governance.withGovernanceTransaction(async (tx) => {
    tx.state.experimentGovernance.rolloutDecisions[0].decisionHash = "0".repeat(64);
  });

  const state = await harness.governance.readState();
  assert.throws(
    () => verifyRolloutDecisionIntegrity(state),
    (error) => error && error.code === "PHASE7_DECISION_HASH_MISMATCH"
  );
});

test("decision ledger anchor mismatch fails closed", async () => {
  const harness = await setupPhase7Harness();
  const experiment = await createAndStartExperiment(harness);

  await harness.governor.applyRolloutDecision({
    approvalToken: issueToken(harness.authorization, "experiment.rollout.apply"),
    experimentSequence: Number(experiment.sequence),
    decision: "hold",
    reasonCode: "operator_override",
    idempotencyKey: "ledger-anchor-1"
  }, {
    role: "operator",
    requester: "op-1"
  });

  await harness.governance.withGovernanceTransaction(async (tx) => {
    tx.state.experimentGovernance.decisionLedger.chainHead = "f".repeat(64);
  });

  const state = await harness.governance.readState();
  assert.throws(
    () => verifyRolloutDecisionIntegrity(state),
    (error) => error && error.code === "PHASE7_LEDGER_CHAIN_HEAD_MISMATCH"
  );
});

test("truncated-tail repair requires explicit operator repair action", async () => {
  const harness = await setupPhase7Harness();
  const experiment = await createAndStartExperiment(harness);

  await harness.governor.applyRolloutDecision({
    approvalToken: issueToken(harness.authorization, "experiment.rollout.apply"),
    experimentSequence: Number(experiment.sequence),
    decision: "hold",
    reasonCode: "operator_override",
    idempotencyKey: "ledger-repair-1"
  }, {
    role: "operator",
    requester: "op-1"
  });

  await harness.governance.withGovernanceTransaction(async (tx) => {
    tx.state.experimentGovernance.decisionLedger.records = [];
    tx.state.experimentGovernance.decisionLedger.nextSequence = 0;
    tx.state.experimentGovernance.decisionLedger.chainHead = "";
  });

  const brokenState = await harness.governance.readState();
  assert.throws(
    () => verifyRolloutDecisionIntegrity(brokenState),
    (error) => error && error.code === "PHASE7_LEDGER_LENGTH_MISMATCH"
  );

  await assert.rejects(
    () => harness.governor.repairDecisionLedgerTail({
      approvalToken: issueToken(harness.authorization, "experiment.rollout.apply")
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );

  const repaired = await harness.governor.repairDecisionLedgerTail({
    approvalToken: issueToken(harness.authorization, "experiment.rollout.repair")
  }, {
    role: "operator",
    requester: "op-1"
  });

  assert.equal(repaired.ok, true);
  assert.equal(repaired.repaired, true);

  const repairedState = await harness.governance.readState();
  const verified = verifyRolloutDecisionIntegrity(repairedState);
  assert.equal(verified.ok, true);
});

test("repair rejects non-truncated divergent ledgers", async () => {
  const harness = await setupPhase7Harness();
  const experiment = await createAndStartExperiment(harness);

  await harness.governor.applyRolloutDecision({
    approvalToken: issueToken(harness.authorization, "experiment.rollout.apply"),
    experimentSequence: Number(experiment.sequence),
    decision: "hold",
    reasonCode: "operator_override",
    idempotencyKey: "ledger-repair-2"
  }, {
    role: "operator",
    requester: "op-1"
  });

  await harness.governance.withGovernanceTransaction(async (tx) => {
    tx.state.experimentGovernance.decisionLedger.records[0].decisionHash = "1".repeat(64);
  });

  await assert.rejects(
    () => harness.governor.repairDecisionLedgerTail({
      approvalToken: issueToken(harness.authorization, "experiment.rollout.repair")
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "PHASE7_LEDGER_REPAIR_NOT_TRUNCATED"
  );
});
