"use strict";

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const {
  ExperimentRecordSchema,
  CalibrationWeightsSchema,
  makeError
} = require("./experiment-schema.js");
const {
  computePreRegistrationLockHash,
  verifyPreRegistrationLock
} = require("./pre-registration-lock.js");
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

const DEFAULT_SPLIT_BASIS_POINTS = Object.freeze({
  control: 5000,
  treatment: 5000
});

function createNoopLogger() {
  return { info() {}, warn() {}, error() {} };
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeWeights(value) {
  const fallback = {
    complexity: 0.35,
    monetization: 0.35,
    qualitySignal: 0.30
  };
  const source = isObject(value) ? value : fallback;
  const parsed = CalibrationWeightsSchema.safeParse({
    complexity: Number(source.complexity),
    monetization: Number(source.monetization),
    qualitySignal: Number(source.qualitySignal)
  });
  if (!parsed.success) {
    return fallback;
  }
  return parsed.data;
}

function normalizeSplitBasisPoints(value) {
  const source = isObject(value) ? value : DEFAULT_SPLIT_BASIS_POINTS;
  const control = Math.max(0, Math.min(10000, Number.parseInt(String(source.control ?? "5000"), 10) || 5000));
  const treatment = Math.max(0, Math.min(10000, Number.parseInt(String(source.treatment ?? "5000"), 10) || 5000));
  if ((control + treatment) !== 10000) {
    return { ...DEFAULT_SPLIT_BASIS_POINTS };
  }
  return { control, treatment };
}

function normalizeExperimentInput(input = {}, options = {}) {
  const createdAt = safeString(options.createdAt);
  const createdBy = safeString(options.createdBy) || "operator";
  const treatment = isObject(input.treatment) ? input.treatment : {};
  const control = isObject(input.control) ? input.control : {};
  const window = isObject(input.window) ? input.window : {};
  const guardrails = isObject(input.guardrails) ? input.guardrails : {};

  return {
    createdAt,
    createdBy,
    name: safeString(input.name),
    status: safeString(input.status) || "draft",
    objective: safeString(input.objective),
    treatment: {
      templateVersion: safeString(treatment.templateVersion) || "v1",
      calibrationWeights: normalizeWeights(treatment.calibrationWeights)
    },
    control: {
      templateVersion: safeString(control.templateVersion) || "v1",
      calibrationWeights: normalizeWeights(control.calibrationWeights)
    },
    window: {
      startIso: safeString(window.startIso),
      endIso: safeString(window.endIso),
      minFinalizedOutcomes: Math.max(1, Number.parseInt(String(window.minFinalizedOutcomes ?? "30"), 10) || 30)
    },
    guardrails: {
      maxRejectRateDelta: Number.isFinite(Number(guardrails.maxRejectRateDelta))
        ? Number(guardrails.maxRejectRateDelta)
        : 0.10,
      minQualityScore: Math.max(0, Math.min(100, Number.parseInt(String(guardrails.minQualityScore ?? "60"), 10) || 60))
    },
    analysisPlanVersion: safeString(input.analysisPlanVersion) || "v1",
    notes: typeof input.notes === "string" ? input.notes : "",
    splitBasisPoints: normalizeSplitBasisPoints(input.splitBasisPoints),
    preRegistrationLockHash: safeString(input.preRegistrationLockHash)
  };
}

function assertDependencies(apiGovernance, operatorAuthorization) {
  if (!apiGovernance || typeof apiGovernance.readState !== "function" || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("EXPERIMENT_CONFIG_INVALID", "apiGovernance.readState and withGovernanceTransaction are required");
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function") {
    throw makeError("EXPERIMENT_CONFIG_INVALID", "operatorAuthorization.consumeApprovalToken is required");
  }
}

function createExperimentManager(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };
  const logger = options.logger && typeof options.logger === "object" ? options.logger : createNoopLogger();

  assertDependencies(apiGovernance, operatorAuthorization);

  async function mutateWithScope(input = {}, context = {}, scope, handler) {
    assertOperatorRole(context);
    const correlationId = safeString(context.correlationId);
    const token = consumeScopedApprovalToken(operatorAuthorization, input.approvalToken, scope, { correlationId });

    const preState = await apiGovernance.readState();
    assertKillSwitchOpen(preState);

    return apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      ensureExperimentGovernanceState(state);
      assertKillSwitchOpen(state);
      return handler(state, token, correlationId);
    }, { correlationId });
  }

  async function createExperiment(input = {}, context = {}) {
    const result = await mutateWithScope(input, context, "experiment.create", (state, token) => {
      const block = state.experimentGovernance;
      block.nextExperimentSequence = Math.max(
        Number(block.nextExperimentSequence || 0),
        block.experiments.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0)
      ) + 1;
      const sequence = Number(block.nextExperimentSequence);
      const createdAt = String(timeProvider.nowIso());
      const createdBy = safeString(token.operatorId) || "operator";
      const normalized = normalizeExperimentInput(input, {
        createdAt,
        createdBy
      });

      const parsed = ExperimentRecordSchema.parse({
        sequence,
        createdAt: normalized.createdAt,
        createdBy: normalized.createdBy,
        name: normalized.name,
        status: "draft",
        objective: normalized.objective,
        treatment: normalized.treatment,
        control: normalized.control,
        window: normalized.window,
        guardrails: normalized.guardrails,
        analysisPlanVersion: normalized.analysisPlanVersion,
        notes: normalized.notes,
        splitBasisPoints: normalized.splitBasisPoints,
        preRegistrationLockHash: ""
      });

      block.experiments.push(parsed);
      block.experiments.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));

      return {
        ok: true,
        experiment: parsed
      };
    });

    logger.info({ event: "phase7_experiment_created", sequence: Number(result.experiment.sequence || 0) });
    return result;
  }

  async function approveExperiment(input = {}, context = {}) {
    return mutateWithScope(input, context, "experiment.approve", (state) => {
      const experiment = findExperimentBySequence(state, input.experimentSequence);
      assertExperimentStatus(experiment, ["draft"]);
      experiment.status = "approved";
      return {
        ok: true,
        experiment: ExperimentRecordSchema.parse(experiment)
      };
    });
  }

  async function startExperiment(input = {}, context = {}) {
    return mutateWithScope(input, context, "experiment.start", (state) => {
      const experiment = findExperimentBySequence(state, input.experimentSequence);
      assertExperimentStatus(experiment, ["approved"]);
      experiment.status = "running";
      experiment.preRegistrationLockHash = computePreRegistrationLockHash(experiment);
      verifyPreRegistrationLock(experiment);
      return {
        ok: true,
        experiment: ExperimentRecordSchema.parse(experiment)
      };
    });
  }

  async function pauseExperiment(input = {}, context = {}) {
    return mutateWithScope(input, context, "experiment.pause", (state) => {
      const experiment = findExperimentBySequence(state, input.experimentSequence);
      assertExperimentStatus(experiment, ["running"]);
      assertPreRegistrationLock(experiment);
      experiment.status = "paused";
      verifyPreRegistrationLock(experiment);
      return {
        ok: true,
        experiment: ExperimentRecordSchema.parse(experiment)
      };
    });
  }

  async function completeExperiment(input = {}, context = {}) {
    return mutateWithScope(input, context, "experiment.complete", (state) => {
      const experiment = findExperimentBySequence(state, input.experimentSequence);
      assertExperimentStatus(experiment, ["running", "paused"]);
      assertPreRegistrationLock(experiment);
      experiment.status = "completed";
      verifyPreRegistrationLock(experiment);
      return {
        ok: true,
        experiment: ExperimentRecordSchema.parse(experiment)
      };
    });
  }

  async function archiveExperiment(input = {}, context = {}) {
    return mutateWithScope(input, context, "experiment.archive", (state) => {
      const experiment = findExperimentBySequence(state, input.experimentSequence);
      assertExperimentStatus(experiment, ["completed"]);
      assertPreRegistrationLock(experiment);
      experiment.status = "archived";
      verifyPreRegistrationLock(experiment);
      return {
        ok: true,
        experiment: ExperimentRecordSchema.parse(experiment)
      };
    });
  }

  return Object.freeze({
    createExperiment,
    approveExperiment,
    startExperiment,
    pauseExperiment,
    completeExperiment,
    archiveExperiment
  });
}

module.exports = {
  createExperimentManager,
  DEFAULT_SPLIT_BASIS_POINTS
};
