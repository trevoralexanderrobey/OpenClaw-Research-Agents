"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  canonicalize,
  canonicalJson,
  safeString
} = require("../governance-automation/common.js");

const DEFAULT_HISTOGRAM_BUCKETS = Object.freeze([
  1,
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1000,
  2500,
  5000,
  10000,
  30000,
  60000,
  300000
]);

const METRIC_DEFINITIONS = Object.freeze([
  { name: "compliance_scan_count", type: "counter", help: "Total compliance scans executed", labels: [] },
  { name: "compliance_scan_duration_ms", type: "histogram", help: "Compliance scan duration distribution", labels: [] },
  { name: "compliance_violations_total", type: "gauge", help: "Current compliance violation count", labels: [] },
  { name: "policy_drift_incidents_total", type: "counter", help: "Total policy drift incidents", labels: [] },
  { name: "policy_drift_severity", type: "gauge", help: "Active policy drift severity counts", labels: ["severity"] },
  { name: "override_ledger_entry_count", type: "counter", help: "Total override ledger entries", labels: [] },
  { name: "override_decision_latency_ms", type: "histogram", help: "Operator override decision latency", labels: [] },
  { name: "remediation_request_count", type: "counter", help: "Total remediation recommendations", labels: [] },
  { name: "remediation_request_applied_count", type: "counter", help: "Applied remediation requests", labels: [] },
  { name: "remediation_request_rejected_count", type: "counter", help: "Rejected remediation requests", labels: [] },
  { name: "runbook_execution_count", type: "counter", help: "Total runbook executions", labels: [] },
  { name: "runbook_approval_latency_ms", type: "histogram", help: "Runbook operator approval latency", labels: [] },
  { name: "runbook_action_success_count", type: "counter", help: "Successful runbook actions", labels: [] },
  { name: "runbook_action_failure_count", type: "counter", help: "Failed runbook actions", labels: [] },
  { name: "incident_event_count", type: "counter", help: "Incident artifacts created", labels: [] },
  { name: "incident_escalation_latency_ms", type: "histogram", help: "Incident escalation latency", labels: [] },
  { name: "attestation_anchor_attempt_count", type: "counter", help: "Attestation anchor attempts", labels: [] },
  { name: "attestation_anchor_success_count", type: "counter", help: "Attestation anchor successes", labels: [] },
  { name: "policy_gate_check_duration_ms", type: "histogram", help: "Phase 10 policy gate check duration", labels: [] },
  { name: "policy_gate_violations_detected", type: "counter", help: "Policy gate violations detected", labels: [] }
]);

const METRIC_INDEX = Object.freeze(Object.fromEntries(
  METRIC_DEFINITIONS.map((definition) => [definition.name, definition])
));

function normalizeHistogramBuckets(input) {
  const values = Array.isArray(input) ? input : DEFAULT_HISTOGRAM_BUCKETS;
  const out = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  const deduped = [];
  for (const value of out) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== value) {
      deduped.push(value);
    }
  }
  return deduped.length > 0 ? deduped : [...DEFAULT_HISTOGRAM_BUCKETS];
}

function getCanonicalHistogramBuckets() {
  return [...DEFAULT_HISTOGRAM_BUCKETS];
}

function normalizeLabelValue(value) {
  return safeString(String(value || ""));
}

function normalizeLabels(input, keys) {
  const source = input && typeof input === "object" ? input : {};
  const labels = {};
  for (const key of keys) {
    labels[key] = normalizeLabelValue(source[key]);
  }
  return labels;
}

function buildLabelKey(labels, keys) {
  const ordered = [];
  for (const key of keys) {
    ordered.push(`${key}=${normalizeLabelValue(labels[key])}`);
  }
  return ordered.join("|");
}

function createCounterStore() {
  return {
    values: new Map()
  };
}

function createGaugeStore() {
  return {
    values: new Map()
  };
}

function createHistogramStore(buckets) {
  return {
    values: new Map(),
    buckets: [...buckets]
  };
}

function upsertValueStore(store, labels, labelKeys) {
  const key = buildLabelKey(labels, labelKeys);
  if (!store.values.has(key)) {
    store.values.set(key, {
      labels: canonicalize(labels),
      value: 0
    });
  }
  return store.values.get(key);
}

function upsertHistogramStore(store, labels, labelKeys) {
  const key = buildLabelKey(labels, labelKeys);
  if (!store.values.has(key)) {
    const bucketCounts = {};
    for (const bucket of store.buckets) {
      bucketCounts[String(bucket)] = 0;
    }
    store.values.set(key, {
      labels: canonicalize(labels),
      count: 0,
      sum: 0,
      bucket_counts: bucketCounts
    });
  }
  return store.values.get(key);
}

function createAccumulator(buckets) {
  const counters = {};
  const gauges = {};
  const histograms = {};
  const summaries = {};

  for (const definition of METRIC_DEFINITIONS) {
    if (definition.type === "counter") {
      counters[definition.name] = createCounterStore();
      continue;
    }
    if (definition.type === "gauge") {
      gauges[definition.name] = createGaugeStore();
      continue;
    }
    if (definition.type === "histogram") {
      histograms[definition.name] = createHistogramStore(buckets);
      continue;
    }
    if (definition.type === "summary") {
      summaries[definition.name] = createHistogramStore(buckets);
    }
  }

  return {
    counters,
    gauges,
    histograms,
    summaries
  };
}

function incrementCounter(accumulator, metricName, value, labels) {
  const definition = METRIC_INDEX[metricName];
  if (!definition || definition.type !== "counter") {
    return;
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return;
  }
  const normalizedLabels = normalizeLabels(labels, definition.labels);
  const entry = upsertValueStore(accumulator.counters[metricName], normalizedLabels, definition.labels);
  entry.value += numericValue;
}

function setGauge(accumulator, metricName, value, labels) {
  const definition = METRIC_INDEX[metricName];
  if (!definition || definition.type !== "gauge") {
    return;
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return;
  }
  const normalizedLabels = normalizeLabels(labels, definition.labels);
  const entry = upsertValueStore(accumulator.gauges[metricName], normalizedLabels, definition.labels);
  entry.value = numericValue;
}

function observeHistogram(accumulator, metricName, value, labels) {
  const definition = METRIC_INDEX[metricName];
  if (!definition || (definition.type !== "histogram" && definition.type !== "summary")) {
    return;
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return;
  }

  const store = definition.type === "summary"
    ? accumulator.summaries[metricName]
    : accumulator.histograms[metricName];

  const normalizedLabels = normalizeLabels(labels, definition.labels);
  const entry = upsertHistogramStore(store, normalizedLabels, definition.labels);

  entry.count += 1;
  entry.sum += numericValue;

  for (const bucket of store.buckets) {
    if (numericValue <= bucket) {
      entry.bucket_counts[String(bucket)] += 1;
    }
  }
}

function toNumeric(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function normalizeEvent(input) {
  const source = input && typeof input === "object" ? input : {};
  return canonicalize({
    timestamp: safeString(source.timestamp) || "1970-01-01T00:00:00.000Z",
    event_type: safeString(source.event_type) || "phase10.event",
    phase: safeString(source.phase) || "phase10",
    actor: safeString(source.actor) || "system",
    scope: safeString(source.scope) || "phase10",
    result: safeString(source.result) || "recorded",
    severity: safeString(source.severity),
    duration_ms: toNumeric(source.duration_ms, -1),
    decision_latency_ms: toNumeric(source.decision_latency_ms, -1),
    approval_latency_ms: toNumeric(source.approval_latency_ms, -1),
    escalation_latency_ms: toNumeric(source.escalation_latency_ms, -1),
    violation_count: toNumeric(source.violation_count, -1),
    active_count: toNumeric(source.active_count, -1),
    gate_violations: toNumeric(source.gate_violations, -1)
  });
}

function applyEvent(accumulator, event) {
  const eventType = safeString(event.event_type);

  if (eventType === "compliance.scan") {
    incrementCounter(accumulator, "compliance_scan_count", 1, {});
    if (event.duration_ms >= 0) {
      observeHistogram(accumulator, "compliance_scan_duration_ms", event.duration_ms, {});
    }
    if (event.violation_count >= 0) {
      setGauge(accumulator, "compliance_violations_total", event.violation_count, {});
    }
    return;
  }

  if (eventType === "policy.drift") {
    incrementCounter(accumulator, "policy_drift_incidents_total", 1, {});
    const severity = safeString(event.severity) || "high";
    if (severity === "high" || severity === "critical") {
      const activeCount = event.active_count >= 0 ? event.active_count : 1;
      setGauge(accumulator, "policy_drift_severity", activeCount, { severity });
    }
    return;
  }

  if (eventType === "override.recorded") {
    incrementCounter(accumulator, "override_ledger_entry_count", 1, {});
    if (event.decision_latency_ms >= 0) {
      observeHistogram(accumulator, "override_decision_latency_ms", event.decision_latency_ms, {});
    }
    return;
  }

  if (eventType === "remediation.requested") {
    incrementCounter(accumulator, "remediation_request_count", 1, {});
    return;
  }

  if (eventType === "remediation.applied") {
    incrementCounter(accumulator, "remediation_request_applied_count", 1, {});
    return;
  }

  if (eventType === "remediation.rejected") {
    incrementCounter(accumulator, "remediation_request_rejected_count", 1, {});
    return;
  }

  if (eventType === "runbook.invoked") {
    incrementCounter(accumulator, "runbook_execution_count", 1, {});
    return;
  }

  if (eventType === "runbook.approved") {
    if (event.approval_latency_ms >= 0) {
      observeHistogram(accumulator, "runbook_approval_latency_ms", event.approval_latency_ms, {});
    }
    return;
  }

  if (eventType === "runbook.action") {
    if (safeString(event.result) === "success") {
      incrementCounter(accumulator, "runbook_action_success_count", 1, {});
    } else {
      incrementCounter(accumulator, "runbook_action_failure_count", 1, {});
    }
    return;
  }

  if (eventType === "incident.created") {
    incrementCounter(accumulator, "incident_event_count", 1, {});
    return;
  }

  if (eventType === "incident.escalated") {
    if (event.escalation_latency_ms >= 0) {
      observeHistogram(accumulator, "incident_escalation_latency_ms", event.escalation_latency_ms, {});
    }
    return;
  }

  if (eventType === "attestation.anchor.attempt") {
    incrementCounter(accumulator, "attestation_anchor_attempt_count", 1, {});
    return;
  }

  if (eventType === "attestation.anchor.success") {
    incrementCounter(accumulator, "attestation_anchor_success_count", 1, {});
    return;
  }

  if (eventType === "policy.gate.check") {
    if (event.duration_ms >= 0) {
      observeHistogram(accumulator, "policy_gate_check_duration_ms", event.duration_ms, {});
    }
    if (event.gate_violations > 0) {
      incrementCounter(accumulator, "policy_gate_violations_detected", event.gate_violations, {});
    }
    return;
  }

  if (eventType === "policy.gate.violation") {
    incrementCounter(accumulator, "policy_gate_violations_detected", 1, {});
  }
}

function sortedValueArray(store) {
  const rows = [];
  for (const value of store.values.values()) {
    rows.push(canonicalize(value));
  }
  rows.sort((left, right) => JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels)));
  return rows;
}

function buildMetricsSnapshot(events, buckets) {
  const normalizedEvents = Array.isArray(events)
    ? events.map((entry) => normalizeEvent(entry))
    : [];

  const accumulator = createAccumulator(buckets);
  for (const event of normalizedEvents) {
    applyEvent(accumulator, event);
  }

  const metricRows = [];
  for (const definition of METRIC_DEFINITIONS) {
    if (definition.type === "counter") {
      metricRows.push(canonicalize({
        name: definition.name,
        type: definition.type,
        help: definition.help,
        values: sortedValueArray(accumulator.counters[definition.name])
      }));
      continue;
    }
    if (definition.type === "gauge") {
      metricRows.push(canonicalize({
        name: definition.name,
        type: definition.type,
        help: definition.help,
        values: sortedValueArray(accumulator.gauges[definition.name])
      }));
      continue;
    }
    if (definition.type === "histogram") {
      const values = [];
      for (const value of accumulator.histograms[definition.name].values.values()) {
        const bucketRows = [];
        for (const bucket of buckets) {
          bucketRows.push({ le: bucket, count: Number(value.bucket_counts[String(bucket)] || 0) });
        }
        bucketRows.push({ le: "+Inf", count: Number(value.count || 0) });
        values.push(canonicalize({
          labels: value.labels,
          count: Number(value.count || 0),
          sum: Number(value.sum || 0),
          buckets: bucketRows
        }));
      }
      values.sort((left, right) => JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels)));
      metricRows.push(canonicalize({
        name: definition.name,
        type: definition.type,
        help: definition.help,
        values
      }));
      continue;
    }
  }

  metricRows.sort((left, right) => left.name.localeCompare(right.name));

  const asOf = normalizedEvents.length > 0
    ? safeString(normalizedEvents[normalizedEvents.length - 1].timestamp)
    : "1970-01-01T00:00:00.000Z";

  return canonicalize({
    schema_version: "phase10-metrics-v1",
    as_of: asOf,
    histogram_buckets: [...buckets],
    events_processed: normalizedEvents.length,
    metrics: metricRows
  });
}

function escapePrometheusLabel(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\"/g, "\\\"")
    .replace(/\n/g, "\\n");
}

function formatPrometheusLabels(labels) {
  const keys = Object.keys(labels || {}).sort((left, right) => left.localeCompare(right));
  if (keys.length === 0) {
    return "";
  }
  const pairs = keys.map((key) => `${key}="${escapePrometheusLabel(labels[key])}"`);
  return `{${pairs.join(",")}}`;
}

function toPrometheus(snapshot) {
  const lines = [];
  for (const metric of snapshot.metrics || []) {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);

    for (const value of metric.values || []) {
      if (metric.type === "counter" || metric.type === "gauge") {
        lines.push(`${metric.name}${formatPrometheusLabels(value.labels)} ${Number(value.value || 0)}`);
        continue;
      }

      if (metric.type === "histogram") {
        const labels = value.labels || {};
        for (const bucket of value.buckets || []) {
          const bucketLabels = canonicalize({ ...labels, le: String(bucket.le) });
          lines.push(`${metric.name}_bucket${formatPrometheusLabels(bucketLabels)} ${Number(bucket.count || 0)}`);
        }
        lines.push(`${metric.name}_sum${formatPrometheusLabels(labels)} ${Number(value.sum || 0)}`);
        lines.push(`${metric.name}_count${formatPrometheusLabels(labels)} ${Number(value.count || 0)}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function createMetricsSchema(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  logger.info({ event: "phase10_metrics_schema_created", metrics: METRIC_DEFINITIONS.length });

  return Object.freeze({
    schema_version: "phase10-metrics-v1",
    metrics: METRIC_DEFINITIONS.map((definition) => canonicalize(definition)),
    getMetricDefinition(metricName) {
      return METRIC_INDEX[safeString(metricName)] || null;
    }
  });
}

function createMetricsExporter(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const metricsPath = safeString(options.metricsPath);
  const buckets = normalizeHistogramBuckets(options.buckets);
  const events = [];

  function recordEvent(eventInput) {
    const event = normalizeEvent(eventInput);
    events.push(event);
    return event;
  }

  function getEvents() {
    return events.map((entry) => canonicalize(entry));
  }

  function getMetricsSnapshot() {
    return buildMetricsSnapshot(events, buckets);
  }

  function exportMetrics(inputEvents = []) {
    if (Array.isArray(inputEvents)) {
      for (const event of inputEvents) {
        recordEvent(event);
      }
    }

    const snapshot = getMetricsSnapshot();
    const metricsJSON = canonicalJson(snapshot);
    const metricsPrometheus = toPrometheus(snapshot);

    if (metricsPath) {
      const resolved = path.resolve(metricsPath);
      fs.mkdirSync(resolved, { recursive: true });
      fs.writeFileSync(path.join(resolved, "metrics.json"), metricsJSON, "utf8");
      fs.writeFileSync(path.join(resolved, "metrics.prometheus.txt"), metricsPrometheus, "utf8");
    }

    logger.info({
      event: "phase10_metrics_exported",
      events: events.length,
      metrics: (snapshot.metrics || []).length
    });

    return {
      metricsJSON,
      metricsPrometheus
    };
  }

  return Object.freeze({
    recordEvent,
    getEvents,
    getMetricsSnapshot,
    exportMetrics,
    getCanonicalHistogramBuckets
  });
}

module.exports = {
  METRIC_DEFINITIONS,
  createMetricsSchema,
  createMetricsExporter,
  getCanonicalHistogramBuckets,
  normalizeHistogramBuckets,
  normalizeEvent,
  buildMetricsSnapshot,
  toPrometheus
};
