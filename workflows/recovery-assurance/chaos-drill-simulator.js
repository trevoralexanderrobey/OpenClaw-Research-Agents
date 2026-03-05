"use strict";

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const { safeString, canonicalize } = require("../governance-automation/common.js");
const { canonicalHash, deriveDeterministicId } = require("./recovery-common.js");
const { RECOVERY_SCHEMA_VERSION, validateRecoveryPayload } = require("./recovery-schema.js");

const ADVISORY_ONLY = true;
const AUTO_REMEDIATION_BLOCKED = true;

const SCENARIOS = Object.freeze({
  component_failure: Object.freeze([
    "Detect primary component unavailable",
    "Review latest checkpoint manifest",
    "Require operator decision for restore path",
    "Record decision and expected communication path"
  ]),
  integrity_drift: Object.freeze([
    "Run backup integrity verification against latest manifest",
    "Classify tamper or corruption findings",
    "Require operator approval for recovery workflow",
    "Capture evidence artifact with immutable hashes"
  ]),
  checkpoint_rollback: Object.freeze([
    "Select prior checkpoint candidate",
    "Review rollback impact and continuity objectives",
    "Require explicit operator acceptance criteria",
    "Document rollback runbook without autonomous execution"
  ])
});

function normalizeScenario(value) {
  const scenario = safeString(value).toLowerCase() || "component_failure";
  if (Object.prototype.hasOwnProperty.call(SCENARIOS, scenario)) {
    return scenario;
  }
  return "component_failure";
}

function createChaosDrillSimulator(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };

  function runDrill(input = {}) {
    const timestamp = safeString(input.timestamp) || String(timeProvider.nowIso());
    const scenario = normalizeScenario(input.scenario);
    const steps = SCENARIOS[scenario].map((step, index) => canonicalize({
      sequence: index + 1,
      action: step,
      expected_operator_decision: true,
      advisory_only: ADVISORY_ONLY
    }));

    const outcome = input.force_failure === true ? "simulated_failure" : "simulated_success";
    const drillHash = canonicalHash(canonicalize({
      timestamp,
      scenario,
      checkpoint_id: safeString(input.checkpoint_id),
      outcome,
      steps
    }));
    const drillId = deriveDeterministicId("DRL", timestamp, drillHash, 12);

    const findings = canonicalize([
      {
        category: "safety-boundary",
        message: "No protected mutation executed",
        advisory_only: ADVISORY_ONLY,
        auto_remediation_blocked: AUTO_REMEDIATION_BLOCKED
      },
      {
        category: "operator-gating",
        message: "Restore/failover remains operator-gated",
        advisory_only: ADVISORY_ONLY,
        auto_remediation_blocked: AUTO_REMEDIATION_BLOCKED
      }
    ]);

    const payload = canonicalize({
      schema_version: RECOVERY_SCHEMA_VERSION,
      drill_id: drillId,
      timestamp,
      scenario,
      tabletop_mode: input.tabletop_mode !== false,
      checkpoint_id: safeString(input.checkpoint_id),
      steps,
      outcome,
      findings,
      advisory_only: ADVISORY_ONLY,
      auto_remediation_blocked: AUTO_REMEDIATION_BLOCKED
    });

    const validation = validateRecoveryPayload("drill_result", payload);
    if (!validation.valid) {
      throw new Error(`PHASE11_DRILL_SCHEMA_INVALID:${JSON.stringify(validation.violations)}`);
    }

    logger.info({
      event: "phase11_chaos_drill_completed",
      drill_id: drillId,
      scenario,
      outcome
    });

    return canonicalize({
      drill_id: drillId,
      scenario,
      outcome,
      findings,
      drill: payload
    });
  }

  return Object.freeze({
    runDrill
  });
}

module.exports = {
  ADVISORY_ONLY,
  AUTO_REMEDIATION_BLOCKED,
  SCENARIOS,
  createChaosDrillSimulator
};
