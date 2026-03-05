"use strict";

const { safeString, canonicalize } = require("../governance-automation/common.js");
const { RECOVERY_SCHEMA_VERSION, validateRecoveryPayload } = require("./recovery-schema.js");

const ADVISORY_ONLY = true;
const AUTO_REMEDIATION_BLOCKED = true;

const DEFAULT_PREREQUISITES = Object.freeze([
  "checkpoint_available",
  "manifest_valid",
  "restore_path_healthy",
  "runbook_complete",
  "recent_drill_successful"
]);

function normalizeChecks(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const checks = {};
  for (const key of DEFAULT_PREREQUISITES) {
    checks[key] = source[key] === true;
  }
  return checks;
}

function createFailoverReadinessValidator(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };

  function validateReadiness(input = {}) {
    const checks = normalizeChecks(input.checks || input);
    const blockers = [];
    const recommendations = [];

    for (const key of DEFAULT_PREREQUISITES) {
      if (checks[key]) {
        continue;
      }
      blockers.push(canonicalize({
        id: key,
        message: `${key} is not satisfied`,
        advisory_only: ADVISORY_ONLY,
        auto_remediation_blocked: AUTO_REMEDIATION_BLOCKED
      }));
      recommendations.push(canonicalize({
        id: `${key}_recommendation`,
        action: `Resolve ${key} before failover consideration`,
        operator_action_required: true
      }));
    }

    const passCount = DEFAULT_PREREQUISITES.length - blockers.length;
    const score = Number(((passCount / DEFAULT_PREREQUISITES.length) * 100).toFixed(2));

    const report = canonicalize({
      schema_version: RECOVERY_SCHEMA_VERSION,
      timestamp: safeString(input.timestamp) || "1970-01-01T00:00:00.000Z",
      ready: blockers.length === 0,
      score,
      blockers,
      recommendations,
      advisory_only: ADVISORY_ONLY,
      auto_remediation_blocked: AUTO_REMEDIATION_BLOCKED,
      failover_triggered: false
    });

    const validation = validateRecoveryPayload("readiness_report", report);
    if (!validation.valid) {
      throw new Error(`PHASE11_READINESS_SCHEMA_INVALID:${JSON.stringify(validation.violations)}`);
    }

    logger.info({
      event: "phase11_failover_readiness_validated",
      ready: report.ready,
      score: report.score,
      blockers: report.blockers.length
    });

    return canonicalize({
      ready: report.ready,
      score: report.score,
      blockers: report.blockers,
      recommendations: report.recommendations,
      report
    });
  }

  return Object.freeze({
    validateReadiness
  });
}

module.exports = {
  ADVISORY_ONLY,
  AUTO_REMEDIATION_BLOCKED,
  DEFAULT_PREREQUISITES,
  createFailoverReadinessValidator
};
