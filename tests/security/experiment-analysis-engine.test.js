"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  setupPhase7Harness,
  issueToken,
  seedDrafts,
  seedOutcomeSet,
  createAndStartExperiment
} = require("./_phase7-helpers.js");

async function assignAllDrafts(harness, experimentSequence, count) {
  const assignments = [];
  for (let draftSequence = 1; draftSequence <= count; draftSequence += 1) {
    const assigned = await harness.assignmentEngine.assignDraftToExperiment({
      approvalToken: issueToken(harness.authorization, "experiment.assign"),
      experimentSequence,
      draftSequence,
      idempotencyKey: `analysis-assign-${draftSequence}`
    }, {
      role: "operator",
      requester: "op-1"
    });
    assignments.push(assigned.assignment);
  }
  return assignments;
}

async function setKillSwitch(governance, value) {
  await governance.withGovernanceTransaction(async (tx) => {
    tx.state.outboundMutation.killSwitch = Boolean(value);
  });
}

test("insufficient sample yields deterministic hold/insufficient_power", async () => {
  const harness = await setupPhase7Harness();
  await seedDrafts(harness.governance, 4);
  const experiment = await createAndStartExperiment(harness);
  const experimentSequence = Number(experiment.sequence);

  const assignments = await assignAllDrafts(harness, experimentSequence, 2);
  await seedOutcomeSet(harness.governance, assignments.map((item, index) => ({
    draftSequence: Number(item.draftSequence),
    enteredAt: `2026-03-10T00:00:0${index}.000Z`,
    result: "accepted",
    score: 90
  })));

  const first = await harness.analysisEngine.computeAnalysisSnapshot({ experimentSequence });
  const second = await harness.analysisEngine.computeAnalysisSnapshot({ experimentSequence });

  assert.deepEqual(first, second);
  assert.equal(first.recommendation, "hold");
  assert.equal(first.reasonCode, "insufficient_power");
});

test("guardrail breach blocks adopt recommendation", async () => {
  const harness = await setupPhase7Harness();
  await seedDrafts(harness.governance, 6);
  const experiment = await createAndStartExperiment(harness);
  const experimentSequence = Number(experiment.sequence);

  const assignments = await assignAllDrafts(harness, experimentSequence, 6);
  const records = assignments.map((assignment, index) => {
    const treatment = assignment.cohort === "treatment";
    return {
      draftSequence: Number(assignment.draftSequence),
      enteredAt: `2026-03-11T00:00:${String(index).padStart(2, "0")}.000Z`,
      result: treatment ? "rejected" : "accepted",
      score: treatment ? 20 : 95
    };
  });
  await seedOutcomeSet(harness.governance, records);

  const computed = await harness.analysisEngine.computeAnalysisSnapshot({ experimentSequence });
  assert.equal(computed.reasonCode, "guardrail_breach");
  assert.equal(computed.recommendation, "hold");
  assert.equal(Array.isArray(computed.guardrailBreaches), true);
  assert.equal(computed.guardrailBreaches.length > 0, true);
});

test("captureAnalysisSnapshot enforces scope and kill-switch", async () => {
  const harness = await setupPhase7Harness();
  await seedDrafts(harness.governance, 4);
  const experiment = await createAndStartExperiment(harness);
  const experimentSequence = Number(experiment.sequence);

  await assignAllDrafts(harness, experimentSequence, 4);
  await seedOutcomeSet(harness.governance, [
    { draftSequence: 1, enteredAt: "2026-03-12T00:00:00.000Z", result: "accepted", score: 80 },
    { draftSequence: 2, enteredAt: "2026-03-12T00:00:01.000Z", result: "accepted", score: 80 },
    { draftSequence: 3, enteredAt: "2026-03-12T00:00:02.000Z", result: "accepted", score: 80 },
    { draftSequence: 4, enteredAt: "2026-03-12T00:00:03.000Z", result: "accepted", score: 80 }
  ]);

  await assert.rejects(
    () => harness.analysisEngine.captureAnalysisSnapshot({
      approvalToken: issueToken(harness.authorization, "experiment.analyze"),
      experimentSequence,
      idempotencyKey: "analysis-snap-supervisor"
    }, {
      role: "supervisor",
      requester: "sup"
    }),
    (error) => error && error.code === "EXPERIMENT_ROLE_DENIED"
  );

  await assert.rejects(
    () => harness.analysisEngine.captureAnalysisSnapshot({
      approvalToken: issueToken(harness.authorization, "experiment.create"),
      experimentSequence,
      idempotencyKey: "analysis-snap-1"
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );

  await setKillSwitch(harness.governance, true);
  await assert.rejects(
    () => harness.analysisEngine.captureAnalysisSnapshot({
      approvalToken: issueToken(harness.authorization, "experiment.analyze"),
      experimentSequence,
      idempotencyKey: "analysis-snap-2"
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "EXPERIMENT_KILL_SWITCH_ACTIVE"
  );
});

test("post-start pre-registration mutation attempts fail for each locked field", async () => {
  const lockedFields = ["treatment", "control", "guardrails", "window", "analysisPlanVersion"];

  for (const field of lockedFields) {
    const harness = await setupPhase7Harness();
    await seedDrafts(harness.governance, 2);
    const experiment = await createAndStartExperiment(harness, {
      name: `locked-${field}`
    });

    await harness.governance.withGovernanceTransaction(async (tx) => {
      const target = tx.state.experimentGovernance.experiments.find((entry) => Number(entry.sequence) === Number(experiment.sequence));
      if (!target) {
        throw new Error("missing experiment in test setup");
      }
      if (field === "analysisPlanVersion") {
        target.analysisPlanVersion = "v2-mutated";
      } else if (field === "window") {
        target.window = {
          ...target.window,
          minFinalizedOutcomes: Number(target.window.minFinalizedOutcomes || 4) + 1
        };
      } else if (field === "guardrails") {
        target.guardrails = {
          ...target.guardrails,
          minQualityScore: Number(target.guardrails.minQualityScore || 60) + 1
        };
      } else {
        target[field] = {
          ...target[field],
          templateVersion: "v2-mutated"
        };
      }
    });

    await assert.rejects(
      () => harness.analysisEngine.computeAnalysisSnapshot({
        experimentSequence: Number(experiment.sequence)
      }),
      (error) => error && error.code === "EXPERIMENT_PREREG_LOCK_BREACH"
    );
  }
});
