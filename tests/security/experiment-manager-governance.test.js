"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  setupPhase7Harness,
  issueToken
} = require("./_phase7-helpers.js");

async function setKillSwitch(governance, value) {
  await governance.withGovernanceTransaction(async (tx) => {
    tx.state.outboundMutation.killSwitch = Boolean(value);
  });
}

test("supervisor is denied lifecycle mutations", async () => {
  const harness = await setupPhase7Harness();
  const { manager, authorization } = harness;

  await assert.rejects(
    () => manager.createExperiment({
      approvalToken: issueToken(authorization, "experiment.create"),
      name: "x",
      objective: "x",
      treatment: { templateVersion: "v1", calibrationWeights: { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 } },
      control: { templateVersion: "v1", calibrationWeights: { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 } },
      window: { startIso: "2026-03-04T00:00:00.000Z", endIso: "2026-03-30T00:00:00.000Z", minFinalizedOutcomes: 4 },
      guardrails: { maxRejectRateDelta: 0.10, minQualityScore: 60 },
      analysisPlanVersion: "v1",
      notes: ""
    }, {
      role: "supervisor",
      requester: "sup"
    }),
    (error) => error && error.code === "EXPERIMENT_ROLE_DENIED"
  );
});

test("scope mismatch is denied per lifecycle action", async () => {
  const harness = await setupPhase7Harness();
  const { manager, authorization } = harness;

  await assert.rejects(
    () => manager.createExperiment({
      approvalToken: issueToken(authorization, "experiment.approve"),
      name: "x",
      objective: "x",
      treatment: { templateVersion: "v1", calibrationWeights: { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 } },
      control: { templateVersion: "v1", calibrationWeights: { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 } },
      window: { startIso: "2026-03-04T00:00:00.000Z", endIso: "2026-03-30T00:00:00.000Z", minFinalizedOutcomes: 4 },
      guardrails: { maxRejectRateDelta: 0.10, minQualityScore: 60 },
      analysisPlanVersion: "v1",
      notes: ""
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );

  const created = await manager.createExperiment({
    approvalToken: issueToken(authorization, "experiment.create"),
    name: "scope-lifecycle",
    objective: "scope-lifecycle",
    treatment: { templateVersion: "v1", calibrationWeights: { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 } },
    control: { templateVersion: "v1", calibrationWeights: { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 } },
    window: { startIso: "2026-03-04T00:00:00.000Z", endIso: "2026-03-30T00:00:00.000Z", minFinalizedOutcomes: 4 },
    guardrails: { maxRejectRateDelta: 0.10, minQualityScore: 60 },
    analysisPlanVersion: "v1",
    notes: ""
  }, {
    role: "operator",
    requester: "op-1"
  });
  const sequence = Number(created.experiment.sequence);

  await assert.rejects(
    () => manager.approveExperiment({
      approvalToken: issueToken(authorization, "experiment.start"),
      experimentSequence: sequence
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );
  await manager.approveExperiment({
    approvalToken: issueToken(authorization, "experiment.approve"),
    experimentSequence: sequence
  }, {
    role: "operator",
    requester: "op-1"
  });

  await assert.rejects(
    () => manager.startExperiment({
      approvalToken: issueToken(authorization, "experiment.pause"),
      experimentSequence: sequence
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );
  await manager.startExperiment({
    approvalToken: issueToken(authorization, "experiment.start"),
    experimentSequence: sequence
  }, {
    role: "operator",
    requester: "op-1"
  });

  await assert.rejects(
    () => manager.pauseExperiment({
      approvalToken: issueToken(authorization, "experiment.complete"),
      experimentSequence: sequence
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );
  await manager.pauseExperiment({
    approvalToken: issueToken(authorization, "experiment.pause"),
    experimentSequence: sequence
  }, {
    role: "operator",
    requester: "op-1"
  });

  await assert.rejects(
    () => manager.completeExperiment({
      approvalToken: issueToken(authorization, "experiment.archive"),
      experimentSequence: sequence
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );
  await manager.completeExperiment({
    approvalToken: issueToken(authorization, "experiment.complete"),
    experimentSequence: sequence
  }, {
    role: "operator",
    requester: "op-1"
  });

  await assert.rejects(
    () => manager.archiveExperiment({
      approvalToken: issueToken(authorization, "experiment.pause"),
      experimentSequence: sequence
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );
});

test("kill-switch denies create/approve/start/pause/complete/archive", async () => {
  const harness = await setupPhase7Harness();
  const { manager, authorization, governance } = harness;

  await setKillSwitch(governance, true);
  await assert.rejects(
    () => manager.createExperiment({
      approvalToken: issueToken(authorization, "experiment.create"),
      name: "blocked-create",
      objective: "blocked",
      treatment: { templateVersion: "v1", calibrationWeights: { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 } },
      control: { templateVersion: "v1", calibrationWeights: { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 } },
      window: { startIso: "2026-03-04T00:00:00.000Z", endIso: "2026-03-30T00:00:00.000Z", minFinalizedOutcomes: 4 },
      guardrails: { maxRejectRateDelta: 0.10, minQualityScore: 60 },
      analysisPlanVersion: "v1",
      notes: ""
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "EXPERIMENT_KILL_SWITCH_ACTIVE"
  );

  await setKillSwitch(governance, false);
  const created = await manager.createExperiment({
    approvalToken: issueToken(authorization, "experiment.create"),
    name: "kill-sequence",
    objective: "kill-sequence",
    treatment: { templateVersion: "v1", calibrationWeights: { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 } },
    control: { templateVersion: "v1", calibrationWeights: { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 } },
    window: { startIso: "2026-03-04T00:00:00.000Z", endIso: "2026-03-30T00:00:00.000Z", minFinalizedOutcomes: 4 },
    guardrails: { maxRejectRateDelta: 0.10, minQualityScore: 60 },
    analysisPlanVersion: "v1",
    notes: ""
  }, {
    role: "operator",
    requester: "op-1"
  });
  const sequence = Number(created.experiment.sequence);

  await setKillSwitch(governance, true);
  await assert.rejects(
    () => manager.approveExperiment({
      approvalToken: issueToken(authorization, "experiment.approve"),
      experimentSequence: sequence
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "EXPERIMENT_KILL_SWITCH_ACTIVE"
  );

  await setKillSwitch(governance, false);
  await manager.approveExperiment({
    approvalToken: issueToken(authorization, "experiment.approve"),
    experimentSequence: sequence
  }, {
    role: "operator",
    requester: "op-1"
  });

  await setKillSwitch(governance, true);
  await assert.rejects(
    () => manager.startExperiment({
      approvalToken: issueToken(authorization, "experiment.start"),
      experimentSequence: sequence
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "EXPERIMENT_KILL_SWITCH_ACTIVE"
  );

  await setKillSwitch(governance, false);
  await manager.startExperiment({
    approvalToken: issueToken(authorization, "experiment.start"),
    experimentSequence: sequence
  }, {
    role: "operator",
    requester: "op-1"
  });
  await setKillSwitch(governance, true);
  await assert.rejects(
    () => manager.pauseExperiment({
      approvalToken: issueToken(authorization, "experiment.pause"),
      experimentSequence: sequence
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "EXPERIMENT_KILL_SWITCH_ACTIVE"
  );

  await setKillSwitch(governance, false);
  await manager.pauseExperiment({
    approvalToken: issueToken(authorization, "experiment.pause"),
    experimentSequence: sequence
  }, {
    role: "operator",
    requester: "op-1"
  });

  await setKillSwitch(governance, true);
  await assert.rejects(
    () => manager.completeExperiment({
      approvalToken: issueToken(authorization, "experiment.complete"),
      experimentSequence: sequence
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "EXPERIMENT_KILL_SWITCH_ACTIVE"
  );

  await setKillSwitch(governance, false);
  await manager.completeExperiment({
    approvalToken: issueToken(authorization, "experiment.complete"),
    experimentSequence: sequence
  }, {
    role: "operator",
    requester: "op-1"
  });

  await setKillSwitch(governance, true);
  await assert.rejects(
    () => manager.archiveExperiment({
      approvalToken: issueToken(authorization, "experiment.archive"),
      experimentSequence: sequence
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "EXPERIMENT_KILL_SWITCH_ACTIVE"
  );
});
