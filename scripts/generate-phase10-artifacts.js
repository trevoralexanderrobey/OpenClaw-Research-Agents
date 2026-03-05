#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createApiGovernance } = require("../security/api-governance.js");
const { readJsonIfExists, canonicalJson, canonicalize, sha256, safeString } = require("../workflows/governance-automation/common.js");
const {
  METRIC_DEFINITIONS,
  createMetricsSchema,
  createMetricsExporter,
  getCanonicalHistogramBuckets
} = require("../workflows/observability/metrics-schema.js");
const { createSloAlertEngine, DEFAULT_SLO_CONFIG } = require("../workflows/observability/slo-alert-engine.js");

function parseArgs(argv) {
  const out = {
    rootDir: process.cwd(),
    outDir: path.resolve(process.cwd(), "audit", "evidence", "observability")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--root") {
      out.rootDir = path.resolve(String(argv[index + 1] || out.rootDir));
      index += 1;
      continue;
    }
    if (token === "--out") {
      out.outDir = path.resolve(String(argv[index + 1] || out.outDir));
      index += 1;
      continue;
    }
  }

  return out;
}

function writeCanonical(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, canonicalJson(value), "utf8");
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(text || ""), "utf8");
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath, "utf8"));
}

function sampleEvents() {
  return canonicalize([
    {
      timestamp: "2026-03-04T12:00:00.000Z",
      event_type: "compliance.scan",
      phase: "phase10",
      actor: "system",
      scope: "phase9.compliance-monitor",
      result: "pass",
      duration_ms: 120,
      violation_count: 0
    },
    {
      timestamp: "2026-03-04T12:00:01.000Z",
      event_type: "policy.drift",
      phase: "phase10",
      actor: "system",
      scope: "phase9.policy-drift-detector",
      result: "detected",
      severity: "critical",
      active_count: 1
    },
    {
      timestamp: "2026-03-04T12:00:02.000Z",
      event_type: "remediation.requested",
      phase: "phase10",
      actor: "system",
      scope: "phase9.remediation-recommender",
      result: "generated"
    },
    {
      timestamp: "2026-03-04T12:00:03.000Z",
      event_type: "runbook.invoked",
      phase: "phase10",
      actor: "operator",
      scope: "phase10.runbook",
      result: "presented"
    },
    {
      timestamp: "2026-03-04T12:00:04.000Z",
      event_type: "runbook.approved",
      phase: "phase10",
      actor: "operator",
      scope: "phase10.runbook",
      result: "approved",
      approval_latency_ms: 2000
    },
    {
      timestamp: "2026-03-04T12:00:05.000Z",
      event_type: "runbook.action",
      phase: "phase10",
      actor: "operator",
      scope: "phase10.runbook",
      result: "success"
    },
    {
      timestamp: "2026-03-04T12:00:06.000Z",
      event_type: "incident.created",
      phase: "phase10",
      actor: "operator",
      scope: "phase10.incident",
      result: "created"
    },
    {
      timestamp: "2026-03-04T12:00:07.000Z",
      event_type: "incident.escalated",
      phase: "phase10",
      actor: "system",
      scope: "phase10.escalation",
      result: "routed",
      escalation_latency_ms: 300
    },
    {
      timestamp: "2026-03-04T12:00:08.000Z",
      event_type: "attestation.anchor.attempt",
      phase: "phase10",
      actor: "operator",
      scope: "phase10.attestation",
      result: "attempted"
    },
    {
      timestamp: "2026-03-04T12:00:09.000Z",
      event_type: "attestation.anchor.success",
      phase: "phase10",
      actor: "operator",
      scope: "phase10.attestation",
      result: "anchored"
    },
    {
      timestamp: "2026-03-04T12:00:10.000Z",
      event_type: "policy.gate.check",
      phase: "phase10",
      actor: "system",
      scope: "phase10.policy-gate",
      result: "pass",
      duration_ms: 42,
      gate_violations: 0
    }
  ]);
}

function parseMetricsJson(metricsJsonText) {
  return canonicalize(JSON.parse(metricsJsonText));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = args.rootDir;
  const outDir = args.outDir;
  fs.mkdirSync(outDir, { recursive: true });

  const schema = createMetricsSchema({});
  const exporter = createMetricsExporter({});
  const events = sampleEvents();
  const exportsResult = exporter.exportMetrics(events);
  const metricsSample = parseMetricsJson(exportsResult.metricsJSON);

  const sloEngine = createSloAlertEngine({ metricsExporter: exporter });
  const sloEvaluation = sloEngine.evaluateSlos();

  const alertRules = Object.keys(DEFAULT_SLO_CONFIG)
    .sort((left, right) => left.localeCompare(right))
    .map((sloName) => sloEngine.generateAlertRule(
      sloName,
      sloName.includes("latency") ? `${sloName}_metric` : sloName,
      DEFAULT_SLO_CONFIG[sloName],
      "operator"
    ).rule);

  const allowlist = readJsonIfExists(path.join(rootDir, "security", "phase10-attestation-egress-allowlist.json"), {
    schema_version: "phase10-attestation-egress-v1",
    blocked_by_default: true,
    allowed_hosts: []
  });

  const governance = createApiGovernance();
  const state = await governance.readState();
  const operationalDecisionLedger = state
    && state.complianceGovernance
    && state.complianceGovernance.operationalDecisionLedger
    ? state.complianceGovernance.operationalDecisionLedger
    : { records: [], nextSequence: 0, chainHead: "" };

  const files = {
    "metrics-schema.json": canonicalize({
      schema_version: safeString(schema.schema_version),
      histogram_buckets: getCanonicalHistogramBuckets(),
      metrics: METRIC_DEFINITIONS
    }),
    "metrics-sample.json": metricsSample,
    "metrics-prometheus.txt": exportsResult.metricsPrometheus,
    "slo-definitions.json": canonicalize(DEFAULT_SLO_CONFIG),
    "alert-rules.json": canonicalize({ rules: alertRules }),
    "runbook-templates.json": canonicalize({
      templates: [
        {
          id: "drift-critical-remediation",
          title: "Critical Drift Remediation",
          acceptance_criteria: [
            "Policy drift is resolved",
            "Phase 10 policy gate passes",
            "Decision ledger entry recorded"
          ],
          risk_assessment: "high"
        }
      ]
    }),
    "runbook-execution-sample.json": canonicalize({
      decision: "applied",
      operator: "operator-cli",
      approval_token_scope: "governance.remediation.apply",
      confirm: true,
      advisory_only_until_confirm: true
    }),
    "incident-artifact-sample.json": canonicalize({
      incident_id: "INC-20260304-001",
      timestamp: "2026-03-04T12:34:56.000Z",
      trigger_event: "critical_drift_detected",
      severity: "critical",
      affected_components: ["compliance-monitor", "policy-drift-detector"],
      recommended_action: "Review drift report and apply remediation",
      escalation_path: ["operator-email", "cline-notification", "pager"],
      ledger_entry_id: "opd-1",
      advisory_only: true,
      requires_operator_action: true,
      auto_remediation_blocked: true
    }),
    "escalation-policy.json": canonicalize({
      low: ["email"],
      medium: ["email", "slack"],
      high: ["email", "slack", "cline"],
      critical: ["email", "slack", "cline", "pager"],
      advisory_only: true,
      auto_remediation_blocked: true
    }),
    "external-attestation-policy.json": canonicalize({
      blocked_by_default: true,
      required_scope: "governance.attestation.anchor",
      required_confirm_flag: true,
      required_approval_token: true,
      required_explicit_external_service_url: true,
      static_allowlist: canonicalize(allowlist.allowed_hosts || []),
      autonomous_triggering_blocked: true
    }),
    "attestation-anchor-sample.json": canonicalize({
      anchor_id: "ATT-20260304-001",
      timestamp: "2026-03-04T12:34:56.000Z",
      evidence_bundle_hash: "sha256:sample",
      external_service: "https://attestation.service.io",
      anchor_proof: "proof:sample",
      operator_approval_token_scope: "governance.attestation.anchor",
      ledger_entry_id: "opd-2"
    }),
    "decision-ledger-sample.json": canonicalize({
      operational_decision_ledger: operationalDecisionLedger
    })
  };

  for (const [name, value] of Object.entries(files)) {
    const outputPath = path.join(outDir, name);
    if (name.endsWith(".txt")) {
      writeText(outputPath, value);
    } else {
      writeCanonical(outputPath, value);
    }
  }

  const orderedFiles = Object.keys(files).sort((left, right) => left.localeCompare(right));
  const hashManifest = canonicalize({
    files: orderedFiles.map((name) => ({
      file: name,
      sha256: hashFile(path.join(outDir, name))
    }))
  });

  writeCanonical(path.join(outDir, "hash-manifest.json"), hashManifest);

  process.stdout.write(`${JSON.stringify({ ok: true, out_dir: outDir, files: [...orderedFiles, "hash-manifest.json"] }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
