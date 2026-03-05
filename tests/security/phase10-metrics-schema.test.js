"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  METRIC_DEFINITIONS,
  createMetricsSchema,
  createMetricsExporter,
  getCanonicalHistogramBuckets
} = require("../../workflows/observability/metrics-schema.js");

const REQUIRED_METRICS = [
  "compliance_scan_count",
  "compliance_scan_duration_ms",
  "compliance_violations_total",
  "policy_drift_incidents_total",
  "policy_drift_severity",
  "override_ledger_entry_count",
  "override_decision_latency_ms",
  "remediation_request_count",
  "remediation_request_applied_count",
  "remediation_request_rejected_count",
  "runbook_execution_count",
  "runbook_approval_latency_ms",
  "runbook_action_success_count",
  "runbook_action_failure_count",
  "incident_event_count",
  "incident_escalation_latency_ms",
  "attestation_anchor_attempt_count",
  "attestation_anchor_success_count",
  "policy_gate_check_duration_ms",
  "policy_gate_violations_detected"
];

test("phase10 metrics schema includes canonical names and types", () => {
  const schema = createMetricsSchema({});
  const names = schema.metrics.map((entry) => entry.name).sort((left, right) => left.localeCompare(right));

  assert.deepEqual(names, [...REQUIRED_METRICS].sort((left, right) => left.localeCompare(right)));
  assert.equal(METRIC_DEFINITIONS.length, REQUIRED_METRICS.length);
});

test("phase10 metrics exporter produces deterministic json and prometheus output", () => {
  const events = [
    {
      timestamp: "2026-03-04T00:00:00.000Z",
      event_type: "compliance.scan",
      phase: "phase10",
      actor: "system",
      scope: "phase9.compliance-monitor",
      result: "pass",
      duration_ms: 12,
      violation_count: 0
    },
    {
      timestamp: "2026-03-04T00:00:01.000Z",
      event_type: "runbook.action",
      phase: "phase10",
      actor: "operator",
      scope: "phase10.runbook",
      result: "success"
    }
  ];

  const firstExporter = createMetricsExporter({});
  const first = firstExporter.exportMetrics(events);

  const secondExporter = createMetricsExporter({});
  const second = secondExporter.exportMetrics(events);

  assert.equal(first.metricsJSON, second.metricsJSON);
  assert.equal(first.metricsPrometheus, second.metricsPrometheus);
  assert.match(first.metricsPrometheus, /compliance_scan_count/);
  assert.match(first.metricsPrometheus, /runbook_action_success_count/);
});

test("phase10 histogram buckets are fixed and reproducible", () => {
  const first = getCanonicalHistogramBuckets();
  const second = getCanonicalHistogramBuckets();
  assert.deepEqual(first, second);
  assert.deepEqual(first, [
    1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000
  ]);
});
