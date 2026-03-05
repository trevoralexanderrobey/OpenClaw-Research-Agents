"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createMetricsExporter } = require("../../workflows/observability/metrics-schema.js");
const { createSloAlertEngine } = require("../../workflows/observability/slo-alert-engine.js");

function nowProvider(iso) {
  return {
    nowIso() {
      return iso;
    }
  };
}

function seedBreachingMetrics(exporter) {
  exporter.recordEvent({
    timestamp: "2026-03-01T00:00:00.000Z",
    event_type: "compliance.scan",
    phase: "phase10",
    actor: "system",
    scope: "phase9.compliance-monitor",
    result: "pass",
    violation_count: 1,
    duration_ms: 10
  });
  exporter.recordEvent({
    timestamp: "2026-03-05T00:00:01.000Z",
    event_type: "policy.drift",
    phase: "phase10",
    actor: "system",
    scope: "phase9.policy-drift-detector",
    result: "detected",
    severity: "critical",
    active_count: 1
  });
  exporter.recordEvent({
    timestamp: "2026-03-05T00:00:02.000Z",
    event_type: "override.recorded",
    phase: "phase10",
    actor: "operator",
    scope: "phase9.override-ledger",
    result: "recorded",
    decision_latency_ms: 700001
  });
  for (let index = 0; index < 10; index += 1) {
    exporter.recordEvent({
      timestamp: `2026-03-05T00:00:${String(10 + index).padStart(2, "0")}.000Z`,
      event_type: "remediation.requested",
      phase: "phase10",
      actor: "system",
      scope: "phase9.remediation-recommender",
      result: "generated"
    });
  }
  for (let index = 0; index < 8; index += 1) {
    exporter.recordEvent({
      timestamp: `2026-03-05T00:01:${String(index).padStart(2, "0")}.000Z`,
      event_type: "remediation.applied",
      phase: "phase10",
      actor: "operator",
      scope: "phase10.runbook",
      result: "applied"
    });
  }
  exporter.recordEvent({
    timestamp: "2026-03-05T00:02:00.000Z",
    event_type: "incident.escalated",
    phase: "phase10",
    actor: "system",
    scope: "phase10.escalation",
    result: "routed",
    escalation_latency_ms: 300000
  });
  exporter.recordEvent({
    timestamp: "2026-03-05T00:03:00.000Z",
    event_type: "runbook.action",
    phase: "phase10",
    actor: "operator",
    scope: "phase10.runbook",
    result: "failure"
  });
}

test("phase10 slo evaluation is deterministic and produces advisory alerts", () => {
  const exporter = createMetricsExporter({});
  seedBreachingMetrics(exporter);

  const engine = createSloAlertEngine({
    metricsExporter: exporter,
    timeProvider: nowProvider("2026-03-05T12:00:00.000Z")
  });

  const first = engine.evaluateSlos();
  const second = engine.evaluateSlos();
  assert.deepEqual(second, first);
  assert.ok(first.breaches.length >= 6);
  assert.equal(first.alerts.every((entry) => entry.advisory_only === true), true);
  assert.equal(first.alerts.every((entry) => entry.auto_remediation_blocked === true), true);
});

test("phase10 slo alert rule generation is deterministic", () => {
  const exporter = createMetricsExporter({});
  const engine = createSloAlertEngine({
    metricsExporter: exporter,
    timeProvider: nowProvider("2026-03-05T12:00:00.000Z")
  });

  const first = engine.generateAlertRule("runbook_action_success_rate", "runbook_action_success_count", { min_rate: 0.95 }, "operator");
  const second = engine.generateAlertRule("runbook_action_success_rate", "runbook_action_success_count", { min_rate: 0.95 }, "operator");
  assert.deepEqual(first, second);
  assert.equal(first.rule.advisory_only, true);
  assert.equal(first.rule.auto_remediation_blocked, true);
});
