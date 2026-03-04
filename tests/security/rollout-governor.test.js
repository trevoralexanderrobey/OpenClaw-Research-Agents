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

async function setKillSwitch(governance, value) {
  await governance.withGovernanceTransaction(async (tx) => {
    tx.state.outboundMutation.killSwitch = Boolean(value);
  });
}

test("supervisor and scope mismatch are denied for rollout apply and repair", async () => {
  const harness = await setupPhase7Harness();
  const experiment = await createAndStartExperiment(harness);

  await assert.rejects(
    () => harness.governor.applyRolloutDecision({
      approvalToken: issueToken(harness.authorization, "experiment.rollout.apply"),
      experimentSequence: Number(experiment.sequence),
      decision: "hold",
      reasonCode: "operator_override",
      idempotencyKey: "rollout-deny-supervisor"
    }, {
      role: "supervisor",
      requester: "sup"
    }),
    (error) => error && error.code === "EXPERIMENT_ROLE_DENIED"
  );

  await assert.rejects(
    () => harness.governor.applyRolloutDecision({
      approvalToken: issueToken(harness.authorization, "experiment.create"),
      experimentSequence: Number(experiment.sequence),
      decision: "hold",
      reasonCode: "operator_override",
      idempotencyKey: "rollout-deny-scope"
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );

  await assert.rejects(
    () => harness.governor.repairDecisionLedgerTail({
      approvalToken: issueToken(harness.authorization, "experiment.rollout.repair")
    }, {
      role: "supervisor",
      requester: "sup"
    }),
    (error) => error && error.code === "EXPERIMENT_ROLE_DENIED"
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
});

test("kill-switch denies rollout apply and ledger repair mutations", async () => {
  const harness = await setupPhase7Harness();
  const experiment = await createAndStartExperiment(harness);

  await setKillSwitch(harness.governance, true);

  await assert.rejects(
    () => harness.governor.applyRolloutDecision({
      approvalToken: issueToken(harness.authorization, "experiment.rollout.apply"),
      experimentSequence: Number(experiment.sequence),
      decision: "hold",
      reasonCode: "operator_override",
      idempotencyKey: "rollout-kill-apply"
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "EXPERIMENT_KILL_SWITCH_ACTIVE"
  );

  await assert.rejects(
    () => harness.governor.repairDecisionLedgerTail({
      approvalToken: issueToken(harness.authorization, "experiment.rollout.repair")
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "EXPERIMENT_KILL_SWITCH_ACTIVE"
  );
});

test("rollout adopt updates active profile deterministically and idempotent replay preserves decision hash", async () => {
  const harness = await setupPhase7Harness();
  const experiment = await createAndStartExperiment(harness, {
    name: "adopt-profile",
    treatment: {
      templateVersion: "v2",
      calibrationWeights: {
        complexity: 0.60,
        monetization: 0.20,
        qualitySignal: 0.20
      }
    }
  });

  const first = await harness.governor.applyRolloutDecision({
    approvalToken: issueToken(harness.authorization, "experiment.rollout.apply"),
    experimentSequence: Number(experiment.sequence),
    decision: "adopt",
    reasonCode: "operator_override",
    idempotencyKey: "rollout-adopt-1"
  }, {
    role: "operator",
    requester: "op-1"
  });

  assert.equal(first.idempotent, false);
  assert.deepEqual(first.activeRolloutProfile.weights, {
    complexity: 0.60,
    monetization: 0.20,
    qualitySignal: 0.20
  });

  const replay = await harness.governor.applyRolloutDecision({
    approvalToken: issueToken(harness.authorization, "experiment.rollout.apply"),
    experimentSequence: Number(experiment.sequence),
    decision: "adopt",
    reasonCode: "operator_override",
    idempotencyKey: "rollout-adopt-1"
  }, {
    role: "operator",
    requester: "op-1"
  });

  assert.equal(replay.idempotent, true);
  assert.equal(replay.decision.decisionHash, first.decision.decisionHash);

  const state = await harness.governance.readState();
  const integrity = verifyRolloutDecisionIntegrity(state);
  assert.equal(integrity.ok, true);
});

test("rollback restores prior active rollout profile deterministically", async () => {
  const harness = await setupPhase7Harness();
  const experimentA = await createAndStartExperiment(harness, {
    name: "rollback-A",
    treatment: {
      templateVersion: "v1",
      calibrationWeights: {
        complexity: 0.50,
        monetization: 0.25,
        qualitySignal: 0.25
      }
    }
  });
  const experimentB = await createAndStartExperiment(harness, {
    name: "rollback-B",
    treatment: {
      templateVersion: "v1",
      calibrationWeights: {
        complexity: 0.20,
        monetization: 0.60,
        qualitySignal: 0.20
      }
    }
  });

  await harness.governor.applyRolloutDecision({
    approvalToken: issueToken(harness.authorization, "experiment.rollout.apply"),
    experimentSequence: Number(experimentA.sequence),
    decision: "adopt",
    reasonCode: "operator_override",
    idempotencyKey: "rollout-a-adopt"
  }, {
    role: "operator",
    requester: "op-1"
  });

  await harness.governor.applyRolloutDecision({
    approvalToken: issueToken(harness.authorization, "experiment.rollout.apply"),
    experimentSequence: Number(experimentB.sequence),
    decision: "adopt",
    reasonCode: "operator_override",
    idempotencyKey: "rollout-b-adopt"
  }, {
    role: "operator",
    requester: "op-1"
  });

  const rollback = await harness.governor.applyRolloutDecision({
    approvalToken: issueToken(harness.authorization, "experiment.rollout.apply"),
    experimentSequence: Number(experimentB.sequence),
    decision: "rollback",
    reasonCode: "operator_override",
    idempotencyKey: "rollout-b-rollback"
  }, {
    role: "operator",
    requester: "op-1"
  });

  assert.equal(rollback.decision.decision, "rollback");
  assert.deepEqual(rollback.activeRolloutProfile.weights, {
    complexity: 0.50,
    monetization: 0.25,
    qualitySignal: 0.25
  });
});
