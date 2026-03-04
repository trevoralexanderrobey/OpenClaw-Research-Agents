"use strict";

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const {
  ExperimentAnalysisSnapshotSchema,
  makeError,
  canonicalStringify
} = require("./experiment-schema.js");
const {
  safeString,
  assertOperatorRole,
  assertKillSwitchOpen,
  consumeScopedApprovalToken,
  ensureExperimentGovernanceState,
  findExperimentBySequence,
  assertExperimentStatus,
  assertPreRegistrationLock
} = require("./experiment-validator.js");

function assertDependencies(apiGovernance) {
  if (!apiGovernance || typeof apiGovernance.readState !== "function" || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("EXPERIMENT_ANALYSIS_CONFIG_INVALID", "apiGovernance.readState and withGovernanceTransaction are required");
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeOutcomeResult(value) {
  const text = safeString(value);
  if (["accepted", "rejected", "revise_requested", "pending"].includes(text)) {
    return text;
  }
  return "pending";
}

function latestOutcomeByDraft(outcomes) {
  const map = new Map();
  for (const outcome of outcomes) {
    const draftSequence = Number(outcome.draftSequence || 0);
    if (draftSequence <= 0) continue;
    const existing = map.get(draftSequence);
    if (!existing || Number(outcome.sequence || 0) > Number(existing.sequence || 0)) {
      map.set(draftSequence, outcome);
    }
  }
  return map;
}

function median(values) {
  const list = asArray(values)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry))
    .sort((left, right) => left - right);
  if (list.length === 0) return 0;
  const mid = Math.floor(list.length / 2);
  if ((list.length % 2) === 0) {
    return (list[mid - 1] + list[mid]) / 2;
  }
  return list[mid];
}

function summarizeGroup(records) {
  const finalized = records.filter((entry) => entry.result !== "pending");
  const accepted = finalized.filter((entry) => entry.result === "accepted").length;
  const rejected = finalized.filter((entry) => entry.result === "rejected").length;
  const reviseRequested = finalized.filter((entry) => entry.result === "revise_requested").length;
  const scores = finalized.map((entry) => Number(entry.score || 0));
  const finalizedCount = finalized.length;
  const acceptanceRate = finalizedCount === 0 ? 0 : accepted / finalizedCount;
  const rejectRate = finalizedCount === 0 ? 0 : rejected / finalizedCount;
  const reviseRate = finalizedCount === 0 ? 0 : reviseRequested / finalizedCount;
  const meanScore = finalizedCount === 0 ? 0 : scores.reduce((sum, item) => sum + item, 0) / finalizedCount;
  const medianScore = median(scores);

  return {
    finalizedCount,
    acceptanceRate,
    rejectRate,
    reviseRate,
    meanScore,
    medianScore
  };
}

function buildDomainUplift(treatmentRecords, controlRecords) {
  const domainKeys = new Set();
  for (const item of treatmentRecords) {
    domainKeys.add(safeString(item.domainTag));
  }
  for (const item of controlRecords) {
    domainKeys.add(safeString(item.domainTag));
  }

  const result = {};
  const sorted = [...domainKeys].filter(Boolean).sort((left, right) => left.localeCompare(right));
  for (const domain of sorted) {
    const treatment = summarizeGroup(treatmentRecords.filter((entry) => safeString(entry.domainTag) === domain));
    const control = summarizeGroup(controlRecords.filter((entry) => safeString(entry.domainTag) === domain));
    result[domain] = Number((treatment.acceptanceRate - control.acceptanceRate).toFixed(6));
  }
  return result;
}

function buildAnalysisFromState(state, experiment) {
  const governance = state.experimentGovernance;
  const assignments = asArray(governance.assignments)
    .filter((entry) => Number(entry.experimentSequence) === Number(experiment.sequence));

  const latestOutcomes = latestOutcomeByDraft(asArray(state.rlhfOutcomes && state.rlhfOutcomes.records));
  const draftsBySequence = new Map(
    asArray(state.rlhfWorkflows && state.rlhfWorkflows.drafts)
      .map((entry) => [Number(entry.sequence || 0), entry])
  );

  const startMs = Date.parse(safeString(experiment.window && experiment.window.startIso));
  const endMs = Date.parse(safeString(experiment.window && experiment.window.endIso));
  const enforceWindow = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs;

  const scored = [];
  for (const assignment of assignments) {
    const draftSequence = Number(assignment.draftSequence || 0);
    const outcome = latestOutcomes.get(draftSequence);
    if (!outcome) continue;

    const enteredAtMs = Date.parse(safeString(outcome.enteredAt));
    if (enforceWindow && Number.isFinite(enteredAtMs) && (enteredAtMs < startMs || enteredAtMs > endMs)) {
      continue;
    }

    const draft = draftsBySequence.get(draftSequence) || {};
    scored.push({
      draftSequence,
      cohort: safeString(assignment.cohort) || "control",
      result: normalizeOutcomeResult(outcome.result),
      score: Math.max(0, Math.min(100, Number.parseInt(String(outcome.score ?? "0"), 10) || 0)),
      domainTag: safeString(draft.domainTag) || "general-research"
    });
  }

  const treatmentRecords = scored.filter((entry) => entry.cohort === "treatment");
  const controlRecords = scored.filter((entry) => entry.cohort === "control");

  const treatment = summarizeGroup(treatmentRecords);
  const control = summarizeGroup(controlRecords);

  const acceptanceRateDelta = Number((treatment.acceptanceRate - control.acceptanceRate).toFixed(6));
  const reviseRequestRateDelta = Number((treatment.reviseRate - control.reviseRate).toFixed(6));
  const meanQualityScoreDelta = Number((treatment.meanScore - control.meanScore).toFixed(6));
  const medianQualityScoreDelta = Number((treatment.medianScore - control.medianScore).toFixed(6));

  const metrics = {
    acceptanceRateDelta,
    reviseRequestRateDelta,
    meanQualityScoreDelta,
    medianQualityScoreDelta,
    domainUplift: buildDomainUplift(treatmentRecords, controlRecords)
  };

  const sampleSize = treatment.finalizedCount + control.finalizedCount;
  const minSample = Math.max(1, Number(experiment.window && experiment.window.minFinalizedOutcomes) || 1);
  const guardrails = experiment.guardrails && typeof experiment.guardrails === "object" ? experiment.guardrails : {};
  const maxRejectRateDelta = Number.isFinite(Number(guardrails.maxRejectRateDelta)) ? Number(guardrails.maxRejectRateDelta) : 0.10;
  const minQualityScore = Number.isFinite(Number(guardrails.minQualityScore)) ? Number(guardrails.minQualityScore) : 60;

  const guardrailBreaches = [];
  if ((treatment.rejectRate - control.rejectRate) > maxRejectRateDelta) {
    guardrailBreaches.push("maxRejectRateDelta");
  }
  if (treatment.meanScore < minQualityScore) {
    guardrailBreaches.push("minQualityScore");
  }

  let recommendation = "hold";
  let reasonCode = "insufficient_power";
  if (sampleSize < minSample) {
    recommendation = "hold";
    reasonCode = "insufficient_power";
  } else if (guardrailBreaches.length > 0) {
    recommendation = "hold";
    reasonCode = "guardrail_breach";
  } else if (acceptanceRateDelta > 0) {
    recommendation = "adopt";
    reasonCode = "uplift_positive";
  } else {
    recommendation = "hold";
    reasonCode = "insufficient_power";
  }

  return {
    sampleSize,
    treatmentSampleSize: treatment.finalizedCount,
    controlSampleSize: control.finalizedCount,
    metrics,
    recommendation,
    reasonCode,
    guardrailBreaches
  };
}

function createExperimentAnalysisEngine(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };

  assertDependencies(apiGovernance);

  async function computeAnalysisSnapshot(input = {}) {
    const state = await apiGovernance.readState();
    ensureExperimentGovernanceState(state);
    const experiment = findExperimentBySequence(state, input.experimentSequence);
    assertExperimentStatus(experiment, ["running", "paused", "completed"]);
    assertPreRegistrationLock(experiment);

    const computed = buildAnalysisFromState(state, experiment);

    return {
      ok: true,
      noOp: false,
      experimentSequence: Number(experiment.sequence),
      analysisPlanVersion: safeString(experiment.analysisPlanVersion) || "v1",
      ...computed
    };
  }

  async function captureAnalysisSnapshot(input = {}, context = {}) {
    assertOperatorRole(context);
    const correlationId = safeString(context.correlationId);
    const idempotencyKey = safeString(input.idempotencyKey);
    if (!idempotencyKey) {
      throw makeError("EXPERIMENT_ANALYSIS_IDEMPOTENCY_REQUIRED", "idempotencyKey is required for analysis snapshot writes");
    }

    consumeScopedApprovalToken(operatorAuthorization, input.approvalToken, "experiment.analyze", { correlationId });

    const preState = await apiGovernance.readState();
    assertKillSwitchOpen(preState);

    const computed = await computeAnalysisSnapshot(input);

    return apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      ensureExperimentGovernanceState(state);
      assertKillSwitchOpen(state);

      const experiment = findExperimentBySequence(state, input.experimentSequence);
      assertExperimentStatus(experiment, ["running", "paused", "completed"]);
      assertPreRegistrationLock(experiment);

      const snapshots = state.experimentGovernance.analysisSnapshots;
      const existing = snapshots.find((entry) => safeString(entry.idempotencyKey) === idempotencyKey) || null;

      if (existing) {
        const existingComparable = {
          experimentSequence: Number(existing.experimentSequence || 0),
          analysisPlanVersion: safeString(existing.analysisPlanVersion),
          recommendation: safeString(existing.recommendation),
          reasonCode: safeString(existing.reasonCode),
          metrics: existing.metrics
        };
        const computedComparable = {
          experimentSequence: Number(computed.experimentSequence),
          analysisPlanVersion: safeString(computed.analysisPlanVersion),
          recommendation: safeString(computed.recommendation),
          reasonCode: safeString(computed.reasonCode),
          metrics: computed.metrics
        };
        if (canonicalStringify(existingComparable) !== canonicalStringify(computedComparable)) {
          throw makeError("EXPERIMENT_ANALYSIS_IDEMPOTENCY_CONFLICT", "Analysis snapshot idempotency key reused with divergent payload", {
            idempotencyKey
          });
        }
        return {
          ok: true,
          idempotent: true,
          snapshot: ExperimentAnalysisSnapshotSchema.parse(existing)
        };
      }

      state.experimentGovernance.nextAnalysisSequence = Math.max(
        Number(state.experimentGovernance.nextAnalysisSequence || 0),
        snapshots.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0)
      ) + 1;

      const snapshot = ExperimentAnalysisSnapshotSchema.parse({
        sequence: Number(state.experimentGovernance.nextAnalysisSequence),
        experimentSequence: Number(computed.experimentSequence),
        capturedAt: String(timeProvider.nowIso()),
        capturedBy: safeString(context.requester) || "operator",
        idempotencyKey,
        sampleSize: Number(computed.sampleSize),
        treatmentSampleSize: Number(computed.treatmentSampleSize),
        controlSampleSize: Number(computed.controlSampleSize),
        metrics: computed.metrics,
        recommendation: computed.recommendation,
        reasonCode: computed.reasonCode,
        guardrailBreaches: computed.guardrailBreaches,
        analysisPlanVersion: safeString(computed.analysisPlanVersion)
      });

      snapshots.push(snapshot);
      snapshots.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));

      return {
        ok: true,
        idempotent: false,
        snapshot
      };
    }, { correlationId });
  }

  return Object.freeze({
    computeAnalysisSnapshot,
    captureAnalysisSnapshot
  });
}

module.exports = {
  createExperimentAnalysisEngine
};
