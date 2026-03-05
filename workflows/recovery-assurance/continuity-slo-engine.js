"use strict";

const { safeString, canonicalize } = require("../governance-automation/common.js");

const DEFAULT_CONTINUITY_SLOS = Object.freeze({
  rto_target_minutes: 30,
  rpo_target_minutes: 15,
  backup_integrity_success_rate: 99.9,
  restore_drill_success_rate: 99
});

const ADVISORY_ONLY = true;
const AUTO_REMEDIATION_BLOCKED = true;

function toFiniteNumber(value, fallback = null) {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function breachRecord(metric, comparator, target, actual, reason = "threshold_breach") {
  return canonicalize({
    metric,
    comparator,
    target,
    actual,
    reason,
    advisory_only: ADVISORY_ONLY,
    auto_remediation_blocked: AUTO_REMEDIATION_BLOCKED,
    operator_action_recommended: true
  });
}

function createContinuitySloEngine(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const thresholds = canonicalize({
    ...DEFAULT_CONTINUITY_SLOS,
    ...(options.thresholds && typeof options.thresholds === "object" ? options.thresholds : {})
  });

  function evaluateContinuity(metrics = {}) {
    const source = metrics && typeof metrics === "object" ? metrics : {};
    const breaches = [];

    const rtoActual = toFiniteNumber(source.rto_actual_minutes, null);
    if (rtoActual === null) {
      breaches.push(breachRecord("rto_actual_minutes", "<=", thresholds.rto_target_minutes, null, "missing_metric"));
    } else if (rtoActual > Number(thresholds.rto_target_minutes)) {
      breaches.push(breachRecord("rto_actual_minutes", "<=", thresholds.rto_target_minutes, rtoActual));
    }

    const rpoActual = toFiniteNumber(source.rpo_actual_minutes, null);
    if (rpoActual === null) {
      breaches.push(breachRecord("rpo_actual_minutes", "<=", thresholds.rpo_target_minutes, null, "missing_metric"));
    } else if (rpoActual > Number(thresholds.rpo_target_minutes)) {
      breaches.push(breachRecord("rpo_actual_minutes", "<=", thresholds.rpo_target_minutes, rpoActual));
    }

    const backupRate = toFiniteNumber(source.backup_integrity_success_rate, null);
    if (backupRate === null) {
      breaches.push(breachRecord("backup_integrity_success_rate", ">=", thresholds.backup_integrity_success_rate, null, "missing_metric"));
    } else if (backupRate < Number(thresholds.backup_integrity_success_rate)) {
      breaches.push(breachRecord("backup_integrity_success_rate", ">=", thresholds.backup_integrity_success_rate, backupRate));
    }

    const drillRate = toFiniteNumber(source.restore_drill_success_rate, null);
    if (drillRate === null) {
      breaches.push(breachRecord("restore_drill_success_rate", ">=", thresholds.restore_drill_success_rate, null, "missing_metric"));
    } else if (drillRate < Number(thresholds.restore_drill_success_rate)) {
      breaches.push(breachRecord("restore_drill_success_rate", ">=", thresholds.restore_drill_success_rate, drillRate));
    }

    const sortedBreaches = breaches
      .slice()
      .sort((left, right) => safeString(left.metric).localeCompare(safeString(right.metric)));

    const alerts = sortedBreaches.map((breach) => canonicalize({
      severity: breach.reason === "missing_metric" ? "high" : "medium",
      title: `Phase 11 continuity SLO breach: ${breach.metric}`,
      metric: breach.metric,
      threshold: canonicalize({ comparator: breach.comparator, target: breach.target }),
      actual: breach.actual,
      advisory_only: ADVISORY_ONLY,
      auto_remediation_blocked: AUTO_REMEDIATION_BLOCKED,
      operator_action_recommended: true
    }));

    const result = canonicalize({
      breaches: sortedBreaches,
      alerts
    });

    logger.info({
      event: "phase11_continuity_slo_evaluated",
      breach_count: result.breaches.length,
      advisory_only: ADVISORY_ONLY
    });

    return result;
  }

  return Object.freeze({
    evaluateContinuity,
    thresholds
  });
}

module.exports = {
  ADVISORY_ONLY,
  AUTO_REMEDIATION_BLOCKED,
  DEFAULT_CONTINUITY_SLOS,
  createContinuitySloEngine
};
