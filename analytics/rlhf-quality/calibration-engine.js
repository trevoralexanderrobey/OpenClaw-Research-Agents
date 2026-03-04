"use strict";

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");

const CALIBRATION_VERSION = "v1";
const MIN_FINALIZED_OUTCOMES = 3;
const DEFAULT_WEIGHTS = Object.freeze({
  complexity: 0.35,
  monetization: 0.35,
  qualitySignal: 0.30
});

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clampFinite(value, min = 0, max = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, numeric));
}

function round6(value) {
  return Number.parseFloat(Number(value).toFixed(6));
}

function isValidWeightSet(weights) {
  if (!weights || typeof weights !== "object") {
    return false;
  }
  const keys = ["complexity", "monetization", "qualitySignal"];
  for (const key of keys) {
    const value = Number(weights[key]);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return false;
    }
  }
  const sum = Number(weights.complexity) + Number(weights.monetization) + Number(weights.qualitySignal);
  return Math.abs(sum - 1) <= 0.000001;
}

function assertValidWeightSet(weights) {
  if (!isValidWeightSet(weights)) {
    const error = new Error("Calibration weights are invalid");
    error.code = "RLHF_CALIBRATION_WEIGHTS_INVALID";
    throw error;
  }
  return true;
}

function normalizeWeightSet(weights) {
  if (!weights || typeof weights !== "object") {
    return { ...DEFAULT_WEIGHTS };
  }
  const complexity = clampFinite(weights.complexity, 0, 1);
  const monetization = clampFinite(weights.monetization, 0, 1);
  const qualitySignal = clampFinite(weights.qualitySignal, 0, 1);
  const total = complexity + monetization + qualitySignal;
  if (total <= 0) {
    return { ...DEFAULT_WEIGHTS };
  }
  const normalizedComplexity = round6(complexity / total);
  const normalizedMonetization = round6(monetization / total);
  const normalizedQualitySignal = round6(1 - normalizedComplexity - normalizedMonetization);
  const candidate = {
    complexity: normalizedComplexity,
    monetization: normalizedMonetization,
    qualitySignal: normalizedQualitySignal
  };
  return isValidWeightSet(candidate) ? candidate : { ...DEFAULT_WEIGHTS };
}

function assertKillSwitchOpen(state) {
  if (state && state.outboundMutation && state.outboundMutation.killSwitch === true) {
    const error = new Error("Calibration updates are blocked while kill-switch is active");
    error.code = "RLHF_CALIBRATION_KILL_SWITCH_ACTIVE";
    throw error;
  }
}

function assertOperatorRole(context = {}) {
  const role = safeString(context.role).toLowerCase() || "supervisor";
  if (role !== "operator") {
    const error = new Error("Only operator role can mutate calibration state");
    error.code = "RLHF_CALIBRATION_ROLE_DENIED";
    throw error;
  }
}

function ensureDependencies(apiGovernance, qualityScoreEngine, operatorAuthorization) {
  if (!apiGovernance || typeof apiGovernance.readState !== "function" || typeof apiGovernance.withGovernanceTransaction !== "function") {
    const error = new Error("apiGovernance readState/withGovernanceTransaction are required");
    error.code = "RLHF_CALIBRATION_CONFIG_INVALID";
    throw error;
  }
  if (!qualityScoreEngine || typeof qualityScoreEngine.computeQualitySnapshot !== "function") {
    const error = new Error("qualityScoreEngine.computeQualitySnapshot is required");
    error.code = "RLHF_CALIBRATION_CONFIG_INVALID";
    throw error;
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function") {
    const error = new Error("operatorAuthorization.consumeApprovalToken is required");
    error.code = "RLHF_CALIBRATION_CONFIG_INVALID";
    throw error;
  }
}

function computeWeightSignals(qualitySnapshot) {
  const finalizedDrafts = (Array.isArray(qualitySnapshot.perDraft) ? qualitySnapshot.perDraft : [])
    .filter((draft) => draft.result !== "pending");
  if (finalizedDrafts.length < MIN_FINALIZED_OUTCOMES) {
    return {
      noOp: true,
      reason: "insufficient_finalized_outcomes",
      count: finalizedDrafts.length,
      weights: { ...DEFAULT_WEIGHTS }
    };
  }
  const totals = finalizedDrafts.reduce((acc, draft) => ({
    complexity: acc.complexity + Number(draft.complexityScore || 0),
    monetization: acc.monetization + Number(draft.monetizationScore || 0),
    qualitySignal: acc.qualitySignal + Number(draft.qualitySignal || 0)
  }), { complexity: 0, monetization: 0, qualitySignal: 0 });

  const averages = {
    complexity: totals.complexity / finalizedDrafts.length,
    monetization: totals.monetization / finalizedDrafts.length,
    qualitySignal: totals.qualitySignal / finalizedDrafts.length
  };
  const weights = normalizeWeightSet(averages);
  return {
    noOp: false,
    reason: "calibrated",
    count: finalizedDrafts.length,
    weights
  };
}

function createCalibrationEngine(options = {}) {
  const apiGovernance = options.apiGovernance;
  const qualityScoreEngine = options.qualityScoreEngine;
  const operatorAuthorization = options.operatorAuthorization;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };

  ensureDependencies(apiGovernance, qualityScoreEngine, operatorAuthorization);

  async function computeCalibration(input = {}) {
    const asOfIso = safeString(input.asOfIso) || String(timeProvider.nowIso());
    const snapshot = await qualityScoreEngine.computeQualitySnapshot({ asOfIso });
    const weightSignals = computeWeightSignals(snapshot);

    return {
      ok: true,
      noOp: weightSignals.noOp,
      reason: weightSignals.reason,
      finalizedCount: weightSignals.count,
      calibration: {
        version: CALIBRATION_VERSION,
        lastCalibratedAt: asOfIso,
        weights: weightSignals.weights
      },
      qualitySnapshot: snapshot
    };
  }

  async function applyCalibration(input = {}, context = {}) {
    assertOperatorRole(context);
    const correlationId = safeString(context.correlationId);
    operatorAuthorization.consumeApprovalToken(input.approvalToken, "rlhf.calibration.apply", { correlationId });

    const baselineState = await apiGovernance.readState();
    assertKillSwitchOpen(baselineState);

    const computed = await computeCalibration({
      asOfIso: safeString(input.asOfIso)
    });

    if (computed.noOp) {
      return {
        ok: true,
        noOp: true,
        reason: computed.reason,
        finalizedCount: computed.finalizedCount,
        calibration: baselineState && baselineState.rlhfOutcomes && baselineState.rlhfOutcomes.calibration
          ? baselineState.rlhfOutcomes.calibration
          : {
              version: CALIBRATION_VERSION,
              lastCalibratedAt: "",
              weights: { ...DEFAULT_WEIGHTS }
            }
      };
    }

    assertValidWeightSet(computed.calibration.weights);

    const result = await apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      assertKillSwitchOpen(state);
      if (!state.rlhfOutcomes || typeof state.rlhfOutcomes !== "object") {
        const error = new Error("rlhfOutcomes state block missing");
        error.code = "RLHF_CALIBRATION_STATE_INVALID";
        throw error;
      }
      const currentVersion = safeString(state.rlhfOutcomes.calibration && state.rlhfOutcomes.calibration.version) || CALIBRATION_VERSION;
      if (currentVersion !== CALIBRATION_VERSION) {
        const error = new Error(`Unsupported calibration version '${currentVersion}'`);
        error.code = "RLHF_CALIBRATION_VERSION_UNSUPPORTED";
        throw error;
      }

      state.rlhfOutcomes.calibration = {
        version: CALIBRATION_VERSION,
        lastCalibratedAt: computed.calibration.lastCalibratedAt,
        weights: {
          complexity: computed.calibration.weights.complexity,
          monetization: computed.calibration.weights.monetization,
          qualitySignal: computed.calibration.weights.qualitySignal
        }
      };
      return {
        ok: true,
        noOp: false,
        calibration: state.rlhfOutcomes.calibration,
        finalizedCount: computed.finalizedCount
      };
    }, { correlationId });

    return result;
  }

  return Object.freeze({
    computeCalibration,
    applyCalibration,
    isValidWeightSet,
    assertValidWeightSet
  });
}

module.exports = {
  CALIBRATION_VERSION,
  MIN_FINALIZED_OUTCOMES,
  DEFAULT_WEIGHTS,
  isValidWeightSet,
  assertValidWeightSet,
  createCalibrationEngine
};
