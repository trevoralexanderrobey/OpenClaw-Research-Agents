"use strict";

const {
  canonicalStringify,
  makeError
} = require("./experiment-schema.js");
const {
  verifyPreRegistrationLock,
  shouldEnforcePreRegistrationLock
} = require("./pre-registration-lock.js");

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRole(context = {}) {
  return safeString(context.role).toLowerCase() || "supervisor";
}

function assertOperatorRole(context = {}) {
  const role = normalizeRole(context);
  if (role === "supervisor") {
    throw makeError("EXPERIMENT_ROLE_DENIED", "Supervisor cannot mutate experiment governance state");
  }
  if (role !== "operator") {
    throw makeError("EXPERIMENT_ROLE_DENIED", "Only operator role can mutate experiment governance state");
  }
}

function assertKillSwitchOpen(state) {
  const active = Boolean(
    state
    && state.outboundMutation
    && state.outboundMutation.killSwitch === true
  );
  if (active) {
    throw makeError("EXPERIMENT_KILL_SWITCH_ACTIVE", "Phase 7 mutations are blocked while kill-switch is active");
  }
}

function consumeScopedApprovalToken(operatorAuthorization, approvalToken, scope, context = {}) {
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function") {
    throw makeError("EXPERIMENT_CONFIG_INVALID", "operatorAuthorization.consumeApprovalToken is required");
  }
  return operatorAuthorization.consumeApprovalToken(approvalToken, scope, {
    correlationId: safeString(context.correlationId)
  });
}

function ensureExperimentGovernanceState(state) {
  if (!state || typeof state !== "object") {
    throw makeError("EXPERIMENT_STATE_INVALID", "State object is required");
  }
  if (!state.experimentGovernance || typeof state.experimentGovernance !== "object") {
    throw makeError("EXPERIMENT_STATE_INVALID", "experimentGovernance state block is required");
  }
  const block = state.experimentGovernance;
  if (!Array.isArray(block.experiments)) block.experiments = [];
  if (!Array.isArray(block.assignments)) block.assignments = [];
  if (!Array.isArray(block.analysisSnapshots)) block.analysisSnapshots = [];
  if (!Array.isArray(block.rolloutDecisions)) block.rolloutDecisions = [];
  if (!block.decisionLedger || typeof block.decisionLedger !== "object") {
    block.decisionLedger = { records: [], nextSequence: 0, chainHead: "" };
  }
  if (!Array.isArray(block.decisionLedger.records)) {
    block.decisionLedger.records = [];
  }
  if (!block.activeRolloutProfile || typeof block.activeRolloutProfile !== "object") {
    block.activeRolloutProfile = {
      version: "v1",
      updatedAt: "",
      updatedBy: "",
      weights: {
        complexity: 0.35,
        monetization: 0.35,
        qualitySignal: 0.30
      },
      templateBias: {}
    };
  }
}

function findExperimentBySequence(state, experimentSequence) {
  ensureExperimentGovernanceState(state);
  const sequence = Number(experimentSequence);
  const found = state.experimentGovernance.experiments.find((entry) => Number(entry.sequence) === sequence);
  if (!found) {
    throw makeError("EXPERIMENT_NOT_FOUND", `Experiment sequence '${experimentSequence}' not found`);
  }
  return found;
}

function assertExperimentStatus(experiment, allowedStatuses) {
  const allowed = Array.isArray(allowedStatuses) ? allowedStatuses.map((item) => String(item)) : [];
  const status = safeString(experiment && experiment.status);
  if (!allowed.includes(status)) {
    throw makeError("EXPERIMENT_STATUS_INVALID", `Experiment status '${status}' is not allowed for this operation`, {
      status,
      allowed
    });
  }
}

function assertPreRegistrationLock(experiment) {
  if (!shouldEnforcePreRegistrationLock(experiment && experiment.status)) {
    return;
  }
  verifyPreRegistrationLock(experiment);
}

function idempotencyFingerprint(payload) {
  return canonicalStringify(payload);
}

function assertIdempotencyReplay(existingRecord, expectedPayload, label) {
  const existingFingerprint = idempotencyFingerprint(existingRecord);
  const expectedFingerprint = idempotencyFingerprint(expectedPayload);
  if (existingFingerprint !== expectedFingerprint) {
    throw makeError("EXPERIMENT_IDEMPOTENCY_CONFLICT", `${safeString(label) || "record"} idempotency key reused with divergent payload`);
  }
}

module.exports = {
  safeString,
  normalizeRole,
  assertOperatorRole,
  assertKillSwitchOpen,
  consumeScopedApprovalToken,
  ensureExperimentGovernanceState,
  findExperimentBySequence,
  assertExperimentStatus,
  assertPreRegistrationLock,
  idempotencyFingerprint,
  assertIdempotencyReplay
};
