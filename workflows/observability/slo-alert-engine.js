"use strict";

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const { canonicalize, safeString } = require("../governance-automation/common.js");

const DEFAULT_SLO_CONFIG = Object.freeze({
  compliance_scan_frequency: {
    target_hours: 24,
    breach_gap_hours: 48,
    severity: "high"
  },
  compliance_violation_threshold: {
    max_violations: 0,
    severity: "critical"
  },
  policy_drift_critical_threshold: {
    max_critical_drifts: 0,
    severity: "critical"
  },
  override_decision_latency_p99: {
    target_ms: 5 * 60 * 1000,
    breach_ms: 10 * 60 * 1000,
    severity: "high"
  },
  remediation_request_success_rate: {
    target_rate: 0.95,
    breach_rate: 0.90,
    severity: "high"
  },
  incident_escalation_latency_p95: {
    target_ms: 60 * 1000,
    breach_ms: 2 * 60 * 1000,
    severity: "critical"
  },
  runbook_action_success_rate: {
    target_rate: 0.99,
    breach_rate: 0.95,
    severity: "critical"
  }
});

function makeError(code, message) {
  const error = new Error(String(message || "Phase 10 SLO alert engine error"));
  error.code = String(code || "PHASE10_SLO_ALERT_ERROR");
  return error;
}

function metricByName(snapshot, metricName) {
  const metrics = Array.isArray(snapshot && snapshot.metrics) ? snapshot.metrics : [];
  return metrics.find((metric) => safeString(metric.name) === safeString(metricName)) || null;
}

function firstValue(metric) {
  const values = Array.isArray(metric && metric.values) ? metric.values : [];
  return values[0] || { value: 0, count: 0, sum: 0, buckets: [] };
}

function valueForLabel(metric, labelKey, labelValue) {
  const values = Array.isArray(metric && metric.values) ? metric.values : [];
  for (const value of values) {
    if (safeString(value && value.labels && value.labels[labelKey]) === safeString(labelValue)) {
      return value;
    }
  }
  return { value: 0 };
}

function histogramPercentile(metric, percentile) {
  const value = firstValue(metric);
  const buckets = Array.isArray(value.buckets) ? value.buckets : [];
  const total = Number(value.count || 0);
  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  const target = total * percentile;
  for (const bucket of buckets) {
    if (String(bucket.le) === "+Inf") {
      return Number(value.sum || 0) / total;
    }
    if (Number(bucket.count || 0) >= target) {
      return Number(bucket.le || 0);
    }
  }
  return Number(value.sum || 0) / total;
}

function isoToMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function ratio(numerator, denominator) {
  const n = Number(numerator || 0);
  const d = Number(denominator || 0);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) {
    return 0;
  }
  return n / d;
}

function createSloAlertEngine(options = {}) {
  const metricsExporter = options.metricsExporter;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };
  const sloConfig = canonicalize({
    ...DEFAULT_SLO_CONFIG,
    ...(options.sloConfig && typeof options.sloConfig === "object" ? options.sloConfig : {})
  });

  if (!metricsExporter || typeof metricsExporter.getMetricsSnapshot !== "function" || typeof metricsExporter.getEvents !== "function") {
    throw makeError("PHASE10_SLO_CONFIG_INVALID", "metricsExporter.getMetricsSnapshot and getEvents are required");
  }

  function generateAlertRule(sloName, metric, threshold, operator) {
    return canonicalize({
      rule: {
        id: `phase10-${safeString(sloName)}-rule`,
        slo: safeString(sloName),
        metric: safeString(metric),
        threshold: canonicalize(threshold && typeof threshold === "object" ? threshold : {}),
        operator: safeString(operator) || "operator",
        advisory_only: true,
        auto_remediation_blocked: true
      }
    });
  }

  function evaluateSlos() {
    const snapshot = metricsExporter.getMetricsSnapshot();
    const events = metricsExporter.getEvents();

    const breaches = [];

    const nowMs = isoToMs(timeProvider.nowIso());
    const complianceEvents = events.filter((event) => safeString(event.event_type) === "compliance.scan");
    const latestComplianceMs = complianceEvents.length > 0
      ? Math.max(...complianceEvents.map((event) => isoToMs(event.timestamp)))
      : 0;
    const complianceGapMs = latestComplianceMs > 0 ? Math.max(0, nowMs - latestComplianceMs) : Number.MAX_SAFE_INTEGER;
    const complianceBreachMs = Number(sloConfig.compliance_scan_frequency.breach_gap_hours || 48) * 60 * 60 * 1000;
    if (complianceGapMs > complianceBreachMs) {
      breaches.push(canonicalize({
        slo: "compliance_scan_frequency",
        severity: safeString(sloConfig.compliance_scan_frequency.severity) || "high",
        metric: "compliance_scan_count",
        threshold: { max_gap_ms: complianceBreachMs },
        observed: { gap_ms: complianceGapMs },
        breach_duration_ms: complianceGapMs - complianceBreachMs,
        recommended_operator_action: "Run compliance scan and acknowledge alert"
      }));
    }

    const violationsGauge = firstValue(metricByName(snapshot, "compliance_violations_total")).value;
    if (Number(violationsGauge || 0) > Number(sloConfig.compliance_violation_threshold.max_violations || 0)) {
      breaches.push(canonicalize({
        slo: "compliance_violation_threshold",
        severity: safeString(sloConfig.compliance_violation_threshold.severity) || "critical",
        metric: "compliance_violations_total",
        threshold: { max: Number(sloConfig.compliance_violation_threshold.max_violations || 0) },
        observed: { value: Number(violationsGauge || 0) },
        breach_duration_ms: 0,
        recommended_operator_action: "Review current violations and trigger runbook review"
      }));
    }

    const criticalDriftValue = valueForLabel(metricByName(snapshot, "policy_drift_severity"), "severity", "critical").value;
    if (Number(criticalDriftValue || 0) > Number(sloConfig.policy_drift_critical_threshold.max_critical_drifts || 0)) {
      breaches.push(canonicalize({
        slo: "policy_drift_critical_threshold",
        severity: safeString(sloConfig.policy_drift_critical_threshold.severity) || "critical",
        metric: "policy_drift_severity",
        threshold: { severity: "critical", max: Number(sloConfig.policy_drift_critical_threshold.max_critical_drifts || 0) },
        observed: { value: Number(criticalDriftValue || 0) },
        breach_duration_ms: 0,
        recommended_operator_action: "Acknowledge drift and review remediation recommendations"
      }));
    }

    const overrideP99 = histogramPercentile(metricByName(snapshot, "override_decision_latency_ms"), 0.99);
    if (overrideP99 > Number(sloConfig.override_decision_latency_p99.breach_ms || 0)) {
      breaches.push(canonicalize({
        slo: "override_decision_latency_p99",
        severity: safeString(sloConfig.override_decision_latency_p99.severity) || "high",
        metric: "override_decision_latency_ms",
        threshold: { p99_max_ms: Number(sloConfig.override_decision_latency_p99.breach_ms || 0) },
        observed: { p99_ms: overrideP99 },
        breach_duration_ms: 0,
        recommended_operator_action: "Reduce operator decision backlog"
      }));
    }

    const remediationRequested = firstValue(metricByName(snapshot, "remediation_request_count")).value;
    const remediationApplied = firstValue(metricByName(snapshot, "remediation_request_applied_count")).value;
    const remediationRate = ratio(remediationApplied, remediationRequested);
    if (remediationRequested > 0 && remediationRate < Number(sloConfig.remediation_request_success_rate.breach_rate || 0)) {
      breaches.push(canonicalize({
        slo: "remediation_request_success_rate",
        severity: safeString(sloConfig.remediation_request_success_rate.severity) || "high",
        metric: "remediation_request_applied_count/remediation_request_count",
        threshold: { min_rate: Number(sloConfig.remediation_request_success_rate.breach_rate || 0) },
        observed: { rate: remediationRate },
        breach_duration_ms: 0,
        recommended_operator_action: "Review failed remediation approvals or outcomes"
      }));
    }

    const escalationP95 = histogramPercentile(metricByName(snapshot, "incident_escalation_latency_ms"), 0.95);
    if (escalationP95 > Number(sloConfig.incident_escalation_latency_p95.breach_ms || 0)) {
      breaches.push(canonicalize({
        slo: "incident_escalation_latency_p95",
        severity: safeString(sloConfig.incident_escalation_latency_p95.severity) || "critical",
        metric: "incident_escalation_latency_ms",
        threshold: { p95_max_ms: Number(sloConfig.incident_escalation_latency_p95.breach_ms || 0) },
        observed: { p95_ms: escalationP95 },
        breach_duration_ms: 0,
        recommended_operator_action: "Review escalation channel availability"
      }));
    }

    const runbookSuccess = firstValue(metricByName(snapshot, "runbook_action_success_count")).value;
    const runbookFailure = firstValue(metricByName(snapshot, "runbook_action_failure_count")).value;
    const runbookRate = ratio(runbookSuccess, Number(runbookSuccess || 0) + Number(runbookFailure || 0));
    if ((runbookSuccess + runbookFailure) > 0 && runbookRate < Number(sloConfig.runbook_action_success_rate.breach_rate || 0)) {
      breaches.push(canonicalize({
        slo: "runbook_action_success_rate",
        severity: safeString(sloConfig.runbook_action_success_rate.severity) || "critical",
        metric: "runbook_action_success_count/(success+failure)",
        threshold: { min_rate: Number(sloConfig.runbook_action_success_rate.breach_rate || 0) },
        observed: { rate: runbookRate },
        breach_duration_ms: 0,
        recommended_operator_action: "Audit runbook action failures before next execution"
      }));
    }

    breaches.sort((left, right) => safeString(left.slo).localeCompare(safeString(right.slo)));

    const alerts = breaches.map((breach) => canonicalize({
      alert_id: `phase10-alert-${safeString(breach.slo)}`,
      severity: safeString(breach.severity),
      metric: safeString(breach.metric),
      threshold: canonicalize(breach.threshold),
      breach_duration: Number(breach.breach_duration_ms || 0),
      operator_action_recommended: safeString(breach.recommended_operator_action),
      advisory_only: true,
      auto_remediation_blocked: true
    }));

    logger.info({
      event: "phase10_slo_evaluated",
      breaches: breaches.length,
      alerts: alerts.length
    });

    return canonicalize({ breaches, alerts });
  }

  return Object.freeze({
    evaluateSlos,
    generateAlertRule,
    sloConfig
  });
}

module.exports = {
  DEFAULT_SLO_CONFIG,
  createSloAlertEngine,
  histogramPercentile
};
