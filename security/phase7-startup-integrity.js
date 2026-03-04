"use strict";

const { makeError } = require("../workflows/experiment-governance/experiment-schema.js");
const {
  verifyRolloutDecisionIntegrity
} = require("../workflows/experiment-governance/decision-ledger.js");
const {
  verifyPreRegistrationLock,
  shouldEnforcePreRegistrationLock
} = require("../workflows/experiment-governance/pre-registration-lock.js");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function createNoopLogger() {
  return { info() {}, warn() {}, error() {} };
}

async function verifyPhase7StartupIntegrity(options = {}) {
  const apiGovernance = options.apiGovernance;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : createNoopLogger();

  if (!apiGovernance || typeof apiGovernance.readState !== "function") {
    throw makeError("PHASE7_STARTUP_CONFIG_INVALID", "apiGovernance.readState is required for startup integrity checks");
  }

  const state = await apiGovernance.readState();
  if (!state || typeof state !== "object") {
    throw makeError("PHASE7_STARTUP_STATE_INVALID", "Runtime state is required for startup integrity checks");
  }
  if (!state.experimentGovernance || typeof state.experimentGovernance !== "object") {
    throw makeError("PHASE7_STARTUP_STATE_INVALID", "experimentGovernance block is required");
  }

  const decisionResult = verifyRolloutDecisionIntegrity(state);

  const experiments = asArray(state.experimentGovernance.experiments);
  for (const experiment of experiments) {
    if (shouldEnforcePreRegistrationLock(experiment && experiment.status)) {
      verifyPreRegistrationLock(experiment);
    }
  }

  logger.info({
    event: "phase7_startup_integrity_verified",
    experiments: experiments.length,
    decisions: decisionResult.actual.count,
    chainHead: decisionResult.actual.chainHead
  });

  return {
    ok: true,
    experiments: experiments.length,
    decisions: decisionResult.actual.count,
    chainHead: decisionResult.actual.chainHead
  };
}

module.exports = {
  verifyPhase7StartupIntegrity
};
