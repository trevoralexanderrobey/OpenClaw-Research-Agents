"use strict";

const { makeError } = require("../workflows/compliance-governance/compliance-schema.js");
const {
  verifyComplianceDecisionIntegrity
} = require("../workflows/compliance-governance/compliance-decision-ledger.js");
const {
  verifyEvidenceBundleIntegrity
} = require("../workflows/compliance-governance/evidence-bundle-builder.js");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function createNoopLogger() {
  return { info() {}, warn() {}, error() {} };
}

async function verifyPhase8StartupIntegrity(options = {}) {
  const apiGovernance = options.apiGovernance;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : createNoopLogger();

  if (!apiGovernance || typeof apiGovernance.readState !== "function") {
    throw makeError("PHASE8_STARTUP_CONFIG_INVALID", "apiGovernance.readState is required for startup integrity checks");
  }

  const state = await apiGovernance.readState();
  if (!state || typeof state !== "object") {
    throw makeError("PHASE8_STARTUP_STATE_INVALID", "Runtime state is required for startup integrity checks");
  }
  if (!state.complianceGovernance || typeof state.complianceGovernance !== "object") {
    throw makeError("PHASE8_STARTUP_STATE_INVALID", "complianceGovernance block is required");
  }

  const decisionResult = verifyComplianceDecisionIntegrity(state);

  const bundles = asArray(state.complianceGovernance.evidenceBundles);
  for (const bundle of bundles) {
    verifyEvidenceBundleIntegrity({ bundle });
  }

  logger.info({
    event: "phase8_startup_integrity_verified",
    decisions: decisionResult.actual.count,
    chainHead: decisionResult.actual.chainHead,
    bundles: bundles.length
  });

  return {
    ok: true,
    decisions: decisionResult.actual.count,
    chainHead: decisionResult.actual.chainHead,
    bundles: bundles.length
  };
}

module.exports = {
  verifyPhase8StartupIntegrity
};
