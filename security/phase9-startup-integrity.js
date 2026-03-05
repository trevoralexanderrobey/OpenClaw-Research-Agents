"use strict";

const {
  createComplianceMonitor
} = require("../workflows/governance-automation/compliance-monitor.js");
const {
  createPolicyDriftDetector
} = require("../workflows/governance-automation/policy-drift-detector.js");
const {
  createOperatorOverrideLedger
} = require("../workflows/governance-automation/operator-override-ledger.js");
const {
  createPhaseCompletenessValidator
} = require("../workflows/governance-automation/phase-completeness-validator.js");
const {
  loadBaselineContracts
} = require("../workflows/governance-automation/phase9-baseline-contracts.js");

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 9 startup integrity failure"));
  error.code = String(code || "PHASE9_STARTUP_INTEGRITY_FAILED");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

async function verifyPhase9StartupIntegrity(options = {}) {
  const apiGovernance = options.apiGovernance;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const rootDir = typeof options.rootDir === "string" && options.rootDir.trim() ? options.rootDir : process.cwd();
  const baselines = options.baselines && typeof options.baselines === "object"
    ? options.baselines
    : loadBaselineContracts(rootDir, options.baselinePath);

  if (!apiGovernance || typeof apiGovernance.readState !== "function") {
    throw makeError("PHASE9_STARTUP_CONFIG_INVALID", "apiGovernance.readState is required for startup integrity checks");
  }

  const complianceMonitor = createComplianceMonitor({
    phaseBaselines: baselines,
    logger
  });
  const runtimeState = await apiGovernance.readState();
  const compliance = complianceMonitor.scanComplianceState({ rootDir, state: runtimeState });
  if (!compliance.compliant) {
    throw makeError("PHASE9_STARTUP_COMPLIANCE_FAILED", "Phase 9 compliance monitor detected violations", {
      violations: compliance.violations
    });
  }

  const driftDetector = createPolicyDriftDetector({
    baselineContracts: baselines,
    logger
  });
  const drifts = driftDetector.detectDrifts({ rootDir });
  if (drifts.operator_action_required) {
    throw makeError("PHASE9_STARTUP_DRIFT_DETECTED", "Phase 9 policy drift detected", {
      drifts: drifts.drifts
    });
  }

  const completenessValidator = createPhaseCompletenessValidator({
    allPhaseBaselines: baselines,
    logger
  });
  const completeness = completenessValidator.validatePhaseCompleteness({ rootDir });
  if (!completeness.compliant) {
    throw makeError("PHASE9_STARTUP_COMPLETENESS_FAILED", "Phase completeness validation failed", {
      missingArtifacts: completeness.missing_artifacts,
      contradictions: completeness.contradictions
    });
  }

  const overrideLedger = createOperatorOverrideLedger({
    apiGovernance,
    operatorAuthorization: {
      consumeApprovalToken() {
        throw makeError("PHASE9_STARTUP_OPERATOR_AUTH_UNAVAILABLE", "operatorAuthorization.consumeApprovalToken unavailable");
      }
    },
    logger,
    timeProvider: options.timeProvider
  });

  const overrideIntegrity = await overrideLedger.verifyOverrideLedgerIntegrity();
  if (!overrideIntegrity.valid || overrideIntegrity.tamper_detected) {
    throw makeError("PHASE9_STARTUP_OVERRIDE_LEDGER_TAMPER", "Operator override ledger integrity check failed", overrideIntegrity);
  }

  logger.info({
    event: "phase9_startup_integrity_verified",
    baselineCommit: baselines.baselineCommit,
    baselineCiRunId: baselines.baselineCiRunId,
    compliance: true,
    drifts: 0,
    completeness: true,
    overrideLedgerValid: true
  });

  return {
    ok: true,
    baseline_commit: baselines.baselineCommit,
    baseline_ci_run: baselines.baselineCiRunId,
    compliance,
    drifts,
    completeness,
    override_ledger: overrideIntegrity
  };
}

module.exports = {
  verifyPhase9StartupIntegrity
};
