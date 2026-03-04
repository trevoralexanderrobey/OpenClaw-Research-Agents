"use strict";

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const {
  RolloutDecisionRecordSchema,
  RolloutDecisionRecordWithoutHashSchema,
  makeError,
  computeDecisionHash,
  canonicalStringify
} = require("./experiment-schema.js");
const {
  buildExpectedLedgerFromDecisions,
  verifyRolloutDecisionIntegrity,
  repairTruncatedLedgerTail
} = require("./decision-ledger.js");
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

const DEFAULT_ROLLOUT_PROFILE = Object.freeze({
  version: "v1",
  updatedAt: "",
  updatedBy: "",
  weights: {
    complexity: 0.35,
    monetization: 0.35,
    qualitySignal: 0.30
  },
  templateBias: {}
});

function cloneProfile(profile = DEFAULT_ROLLOUT_PROFILE) {
  return {
    version: safeString(profile.version) || "v1",
    updatedAt: safeString(profile.updatedAt),
    updatedBy: safeString(profile.updatedBy),
    weights: {
      complexity: Number(profile.weights && profile.weights.complexity) || DEFAULT_ROLLOUT_PROFILE.weights.complexity,
      monetization: Number(profile.weights && profile.weights.monetization) || DEFAULT_ROLLOUT_PROFILE.weights.monetization,
      qualitySignal: Number(profile.weights && profile.weights.qualitySignal) || DEFAULT_ROLLOUT_PROFILE.weights.qualitySignal
    },
    templateBias: profile.templateBias && typeof profile.templateBias === "object" && !Array.isArray(profile.templateBias)
      ? { ...profile.templateBias }
      : {}
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compareDecisionPayload(existing, candidate) {
  const left = canonicalStringify({
    experimentSequence: Number(existing.experimentSequence || 0),
    decision: safeString(existing.decision),
    reasonCode: safeString(existing.reasonCode),
    idempotencyKey: safeString(existing.idempotencyKey)
  });
  const right = canonicalStringify({
    experimentSequence: Number(candidate.experimentSequence || 0),
    decision: safeString(candidate.decision),
    reasonCode: safeString(candidate.reasonCode),
    idempotencyKey: safeString(candidate.idempotencyKey)
  });
  return left === right;
}

function lookupExperiment(experiments, sequence) {
  return asArray(experiments).find((entry) => Number(entry.sequence) === Number(sequence)) || null;
}

function recomputeActiveRolloutProfile(state) {
  const governance = state.experimentGovernance;
  const decisions = asArray(governance.rolloutDecisions)
    .slice()
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  const experiments = asArray(governance.experiments);

  let current = cloneProfile(DEFAULT_ROLLOUT_PROFILE);
  const history = [];

  for (const decision of decisions) {
    const normalizedDecision = safeString(decision.decision);
    if (normalizedDecision === "adopt") {
      history.push(cloneProfile(current));
      const experiment = lookupExperiment(experiments, decision.experimentSequence);
      const treatment = experiment && experiment.treatment && typeof experiment.treatment === "object"
        ? experiment.treatment
        : {};
      const weights = treatment.calibrationWeights && typeof treatment.calibrationWeights === "object"
        ? treatment.calibrationWeights
        : current.weights;
      current = {
        version: "v1",
        updatedAt: safeString(decision.decidedAt),
        updatedBy: safeString(decision.decidedBy),
        weights: {
          complexity: Number(weights.complexity) || DEFAULT_ROLLOUT_PROFILE.weights.complexity,
          monetization: Number(weights.monetization) || DEFAULT_ROLLOUT_PROFILE.weights.monetization,
          qualitySignal: Number(weights.qualitySignal) || DEFAULT_ROLLOUT_PROFILE.weights.qualitySignal
        },
        templateBias: cloneProfile(current).templateBias
      };
      continue;
    }

    if (normalizedDecision === "rollback") {
      const previous = history.pop();
      if (previous) {
        current = {
          ...previous,
          updatedAt: safeString(decision.decidedAt),
          updatedBy: safeString(decision.decidedBy)
        };
      }
    }
  }

  return current;
}

function normalizeRecommendation(input = {}) {
  const recommendation = safeString(input.recommendation);
  const reasonCode = safeString(input.reasonCode);
  if (["adopt", "hold", "rollback"].includes(recommendation) && reasonCode) {
    return { recommendation, reasonCode };
  }
  return {
    recommendation: "hold",
    reasonCode: "insufficient_power"
  };
}

function createRolloutGovernor(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const analysisEngine = options.analysisEngine;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };

  if (!apiGovernance || typeof apiGovernance.readState !== "function" || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE7_ROLLOUT_CONFIG_INVALID", "apiGovernance.readState and withGovernanceTransaction are required");
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function") {
    throw makeError("PHASE7_ROLLOUT_CONFIG_INVALID", "operatorAuthorization.consumeApprovalToken is required");
  }

  async function recommendRolloutDecision(input = {}) {
    const state = await apiGovernance.readState();
    ensureExperimentGovernanceState(state);
    const experiment = findExperimentBySequence(state, input.experimentSequence);
    assertExperimentStatus(experiment, ["running", "paused", "completed"]);
    assertPreRegistrationLock(experiment);

    if (analysisEngine && typeof analysisEngine.computeAnalysisSnapshot === "function") {
      const computed = await analysisEngine.computeAnalysisSnapshot({
        experimentSequence: Number(input.experimentSequence)
      });
      return {
        ok: true,
        recommendation: computed.recommendation,
        reasonCode: computed.reasonCode,
        sampleSize: computed.sampleSize,
        metrics: computed.metrics,
        guardrailBreaches: computed.guardrailBreaches
      };
    }

    const snapshots = asArray(state.experimentGovernance.analysisSnapshots)
      .filter((entry) => Number(entry.experimentSequence) === Number(input.experimentSequence))
      .sort((left, right) => Number(right.sequence || 0) - Number(left.sequence || 0));
    const latest = snapshots[0];
    if (!latest) {
      return {
        ok: true,
        recommendation: "hold",
        reasonCode: "insufficient_power",
        sampleSize: 0,
        metrics: {
          acceptanceRateDelta: 0,
          reviseRequestRateDelta: 0,
          meanQualityScoreDelta: 0,
          medianQualityScoreDelta: 0,
          domainUplift: {}
        },
        guardrailBreaches: []
      };
    }

    return {
      ok: true,
      recommendation: safeString(latest.recommendation),
      reasonCode: safeString(latest.reasonCode),
      sampleSize: Number(latest.sampleSize || 0),
      metrics: latest.metrics,
      guardrailBreaches: asArray(latest.guardrailBreaches)
    };
  }

  async function applyRolloutDecision(input = {}, context = {}) {
    assertOperatorRole(context);
    const correlationId = safeString(context.correlationId);
    const idempotencyKey = safeString(input.idempotencyKey);
    if (!idempotencyKey) {
      throw makeError("PHASE7_ROLLOUT_IDEMPOTENCY_REQUIRED", "idempotencyKey is required for rollout apply");
    }

    consumeScopedApprovalToken(operatorAuthorization, input.approvalToken, "experiment.rollout.apply", { correlationId });

    const preState = await apiGovernance.readState();
    assertKillSwitchOpen(preState);

    const recommendation = await recommendRolloutDecision({
      experimentSequence: Number(input.experimentSequence)
    });
    const normalized = normalizeRecommendation({
      recommendation: safeString(input.decision) || recommendation.recommendation,
      reasonCode: safeString(input.reasonCode) || recommendation.reasonCode
    });

    return apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      ensureExperimentGovernanceState(state);
      assertKillSwitchOpen(state);
      const experiment = findExperimentBySequence(state, input.experimentSequence);
      assertExperimentStatus(experiment, ["running", "paused", "completed"]);
      assertPreRegistrationLock(experiment);

      const decisions = state.experimentGovernance.rolloutDecisions;
      const byKey = decisions.find((entry) => safeString(entry.idempotencyKey) === idempotencyKey) || null;

      if (byKey) {
        const comparable = {
          experimentSequence: Number(input.experimentSequence),
          decision: normalized.recommendation,
          reasonCode: normalized.reasonCode,
          idempotencyKey
        };
        if (!compareDecisionPayload(byKey, comparable)) {
          throw makeError("PHASE7_ROLLOUT_IDEMPOTENCY_CONFLICT", "Rollout apply idempotency key reused with divergent payload", {
            idempotencyKey
          });
        }
        return {
          ok: true,
          idempotent: true,
          decision: RolloutDecisionRecordSchema.parse(byKey),
          activeRolloutProfile: cloneProfile(state.experimentGovernance.activeRolloutProfile)
        };
      }

      state.experimentGovernance.nextRolloutDecisionSequence = Math.max(
        Number(state.experimentGovernance.nextRolloutDecisionSequence || 0),
        decisions.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0)
      ) + 1;

      const sequence = Number(state.experimentGovernance.nextRolloutDecisionSequence);
      const prevDecisionHash = decisions.length === 0 ? "" : safeString(decisions[decisions.length - 1].decisionHash);
      const baseDecision = RolloutDecisionRecordWithoutHashSchema.parse({
        sequence,
        experimentSequence: Number(input.experimentSequence),
        decidedAt: String(timeProvider.nowIso()),
        decidedBy: safeString(context.requester) || "operator",
        decision: normalized.recommendation,
        reasonCode: normalized.reasonCode,
        approvalToken: safeString(input.approvalToken),
        idempotencyKey,
        prevDecisionHash
      });

      const decision = RolloutDecisionRecordSchema.parse({
        ...baseDecision,
        decisionHash: computeDecisionHash(baseDecision)
      });

      decisions.push(decision);
      decisions.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));

      const expectedLedger = buildExpectedLedgerFromDecisions(decisions);
      state.experimentGovernance.decisionLedger = {
        records: expectedLedger.records,
        nextSequence: expectedLedger.nextSequence,
        chainHead: expectedLedger.chainHead
      };

      state.experimentGovernance.activeRolloutProfile = recomputeActiveRolloutProfile(state);
      verifyRolloutDecisionIntegrity(state);

      return {
        ok: true,
        idempotent: false,
        decision,
        activeRolloutProfile: cloneProfile(state.experimentGovernance.activeRolloutProfile)
      };
    }, { correlationId });
  }

  async function repairDecisionLedgerTail(input = {}, context = {}) {
    assertOperatorRole(context);
    const correlationId = safeString(context.correlationId);
    consumeScopedApprovalToken(operatorAuthorization, input.approvalToken, "experiment.rollout.repair", { correlationId });

    const preState = await apiGovernance.readState();
    assertKillSwitchOpen(preState);

    return apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      ensureExperimentGovernanceState(state);
      assertKillSwitchOpen(state);
      for (const experiment of asArray(state.experimentGovernance.experiments)) {
        assertPreRegistrationLock(experiment);
      }
      const repaired = repairTruncatedLedgerTail(state);
      verifyRolloutDecisionIntegrity(state);
      return repaired;
    }, { correlationId });
  }

  return Object.freeze({
    recommendRolloutDecision,
    applyRolloutDecision,
    repairDecisionLedgerTail
  });
}

module.exports = {
  createRolloutGovernor,
  DEFAULT_ROLLOUT_PROFILE,
  recomputeActiveRolloutProfile
};
