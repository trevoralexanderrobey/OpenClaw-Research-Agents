"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  setupPhase7Harness,
  issueToken,
  seedDrafts,
  createAndStartExperiment
} = require("./_phase7-helpers.js");

async function setKillSwitch(governance, value) {
  await governance.withGovernanceTransaction(async (tx) => {
    tx.state.outboundMutation.killSwitch = Boolean(value);
  });
}

test("deterministic assignment is stable across replay", async () => {
  const harness = await setupPhase7Harness();
  await seedDrafts(harness.governance, 4);
  const experiment = await createAndStartExperiment(harness);

  const first = await harness.assignmentEngine.assignDraftToExperiment({
    approvalToken: issueToken(harness.authorization, "experiment.assign"),
    experimentSequence: Number(experiment.sequence),
    draftSequence: 1,
    idempotencyKey: "assign-1"
  }, {
    role: "operator",
    requester: "op-1"
  });

  const second = await harness.assignmentEngine.assignDraftToExperiment({
    approvalToken: issueToken(harness.authorization, "experiment.assign"),
    experimentSequence: Number(experiment.sequence),
    draftSequence: 1,
    idempotencyKey: "assign-1"
  }, {
    role: "operator",
    requester: "op-1"
  });

  assert.equal(first.assignment.bucket, second.assignment.bucket);
  assert.equal(first.assignment.cohort, second.assignment.cohort);
  assert.equal(second.idempotent, true);
});

test("assignment immutability is enforced", async () => {
  const harness = await setupPhase7Harness();
  await seedDrafts(harness.governance, 4);
  const experiment = await createAndStartExperiment(harness);

  await harness.assignmentEngine.assignDraftToExperiment({
    approvalToken: issueToken(harness.authorization, "experiment.assign"),
    experimentSequence: Number(experiment.sequence),
    draftSequence: 2,
    idempotencyKey: "assign-2a"
  }, {
    role: "operator",
    requester: "op-1"
  });

  await assert.rejects(
    () => harness.assignmentEngine.assignDraftToExperiment({
      approvalToken: issueToken(harness.authorization, "experiment.assign"),
      experimentSequence: Number(experiment.sequence),
      draftSequence: 2,
      idempotencyKey: "assign-2b"
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "EXPERIMENT_ASSIGNMENT_IMMUTABLE"
  );
});

test("assignment idempotency conflict fails closed", async () => {
  const harness = await setupPhase7Harness();
  await seedDrafts(harness.governance, 4);
  const experiment = await createAndStartExperiment(harness);

  await harness.assignmentEngine.assignDraftToExperiment({
    approvalToken: issueToken(harness.authorization, "experiment.assign"),
    experimentSequence: Number(experiment.sequence),
    draftSequence: 3,
    idempotencyKey: "assign-3"
  }, {
    role: "operator",
    requester: "op-1"
  });

  await assert.rejects(
    () => harness.assignmentEngine.assignDraftToExperiment({
      approvalToken: issueToken(harness.authorization, "experiment.assign"),
      experimentSequence: Number(experiment.sequence),
      draftSequence: 4,
      idempotencyKey: "assign-3"
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "EXPERIMENT_ASSIGNMENT_IDEMPOTENCY_CONFLICT"
  );
});

test("supervisor denied and scope mismatch denied for assignment", async () => {
  const harness = await setupPhase7Harness();
  await seedDrafts(harness.governance, 4);
  const experiment = await createAndStartExperiment(harness);

  await assert.rejects(
    () => harness.assignmentEngine.assignDraftToExperiment({
      approvalToken: issueToken(harness.authorization, "experiment.assign"),
      experimentSequence: Number(experiment.sequence),
      draftSequence: 1,
      idempotencyKey: "assign-4"
    }, {
      role: "supervisor",
      requester: "sup"
    }),
    (error) => error && error.code === "EXPERIMENT_ROLE_DENIED"
  );

  await assert.rejects(
    () => harness.assignmentEngine.assignDraftToExperiment({
      approvalToken: issueToken(harness.authorization, "experiment.create"),
      experimentSequence: Number(experiment.sequence),
      draftSequence: 1,
      idempotencyKey: "assign-5"
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );
});

test("kill-switch denies assignment mutation", async () => {
  const harness = await setupPhase7Harness();
  await seedDrafts(harness.governance, 4);
  const experiment = await createAndStartExperiment(harness);

  await setKillSwitch(harness.governance, true);
  await assert.rejects(
    () => harness.assignmentEngine.assignDraftToExperiment({
      approvalToken: issueToken(harness.authorization, "experiment.assign"),
      experimentSequence: Number(experiment.sequence),
      draftSequence: 1,
      idempotencyKey: "assign-6"
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "EXPERIMENT_KILL_SWITCH_ACTIVE"
  );
});
