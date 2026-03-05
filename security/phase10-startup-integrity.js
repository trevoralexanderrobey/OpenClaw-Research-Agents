"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createMetricsExporter } = require("../workflows/observability/metrics-schema.js");
const { createSloAlertEngine } = require("../workflows/observability/slo-alert-engine.js");
const { SUPPORTED_CHANNELS } = require("../workflows/observability/alert-router.js");
const { DEFAULT_ALLOWLIST_PATH } = require("../workflows/attestation/external-attestation-anchor.js");
const { readJsonIfExists } = require("../workflows/governance-automation/common.js");

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 10 startup integrity failure"));
  error.code = String(code || "PHASE10_STARTUP_INTEGRITY_FAILED");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function ensureWritableDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  const probePath = path.join(dirPath, ".phase10-startup-probe");
  fs.writeFileSync(probePath, "probe\n", "utf8");
  fs.unlinkSync(probePath);
}

function parseAlertChannels(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function requiredFiles(rootDir) {
  return [
    "workflows/observability/metrics-schema.js",
    "workflows/observability/telemetry-emitter.js",
    "workflows/observability/slo-alert-engine.js",
    "workflows/observability/alert-router.js",
    "workflows/observability/operational-decision-ledger.js",
    "workflows/runbook-automation/runbook-orchestrator.js",
    "workflows/incident-management/incident-artifact-creator.js",
    "workflows/incident-management/escalation-orchestrator.js",
    "workflows/attestation/external-attestation-anchor.js",
    "scripts/runbook-orchestrator.js",
    "scripts/external-attestation-anchor.js",
    "scripts/incident-trigger.sh",
    "scripts/generate-phase10-artifacts.js",
    "scripts/verify-phase10-policy.sh"
  ].map((rel) => ({ rel, abs: path.join(rootDir, rel) }));
}

async function verifyPhase10StartupIntegrity(options = {}) {
  const apiGovernance = options.apiGovernance;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const rootDir = typeof options.rootDir === "string" && options.rootDir.trim() ? options.rootDir : process.cwd();
  const metricsExporterFactory = typeof options.metricsExporterFactory === "function"
    ? options.metricsExporterFactory
    : createMetricsExporter;
  const sloAlertEngineFactory = typeof options.sloAlertEngineFactory === "function"
    ? options.sloAlertEngineFactory
    : createSloAlertEngine;

  if (!apiGovernance || typeof apiGovernance.readState !== "function") {
    throw makeError("PHASE10_STARTUP_CONFIG_INVALID", "apiGovernance.readState is required for startup checks");
  }
  if (typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE10_STARTUP_CONFIG_INVALID", "apiGovernance.withGovernanceTransaction is required for startup checks");
  }

  const failures = [];

  for (const file of requiredFiles(rootDir)) {
    if (!fs.existsSync(file.abs)) {
      failures.push({ check: "required_file", file: file.rel, reason: "missing" });
    }
  }

  try {
    const exporter = metricsExporterFactory({});
    const exported = exporter.exportMetrics([{
      timestamp: "2026-03-04T00:00:00.000Z",
      event_type: "policy.gate.check",
      phase: "phase10",
      actor: "system",
      scope: "phase10.startup",
      result: "pass",
      duration_ms: 1,
      gate_violations: 0
    }]);
    if (!exported.metricsJSON || !exported.metricsPrometheus) {
      failures.push({ check: "metrics_exporter", reason: "empty_export" });
    }
  } catch (error) {
    failures.push({ check: "metrics_exporter", reason: error && error.message ? error.message : String(error) });
  }

  try {
    const sloEngine = sloAlertEngineFactory({
      metricsExporter: metricsExporterFactory({}),
      logger
    });
    const evaluated = sloEngine.evaluateSlos();
    if (!evaluated || !Array.isArray(evaluated.breaches) || !Array.isArray(evaluated.alerts)) {
      failures.push({ check: "slo_definitions", reason: "invalid_evaluation_shape" });
    }
  } catch (error) {
    failures.push({ check: "slo_definitions", reason: error && error.message ? error.message : String(error) });
  }

  try {
    const incidentDir = path.resolve(options.incidentArtifactPath || path.join(rootDir, "audit", "evidence", "observability", "incidents"));
    ensureWritableDirectory(incidentDir);
  } catch (error) {
    failures.push({ check: "incident_artifact_path", reason: error && error.message ? error.message : String(error) });
  }

  const configuredChannels = parseAlertChannels(options.alertChannels || process.env.PHASE10_ALERT_CHANNELS || "cline,email");
  if (configuredChannels.length === 0) {
    failures.push({ check: "alert_channels", reason: "no_channels_configured" });
  } else {
    for (const channel of configuredChannels) {
      if (!SUPPORTED_CHANNELS.includes(channel)) {
        failures.push({ check: "alert_channels", reason: `unsupported_channel:${channel}` });
      }
    }
  }

  const attestationAllowlist = options.attestationAllowlistPath
    ? path.resolve(options.attestationAllowlistPath)
    : path.resolve(rootDir, "security", path.basename(DEFAULT_ALLOWLIST_PATH));
  if (!fs.existsSync(attestationAllowlist)) {
    failures.push({ check: "attestation_gating", reason: "allowlist_missing" });
  } else {
    const allowlist = readJsonIfExists(attestationAllowlist, {});
    const blockedByDefault = Boolean(allowlist && allowlist.blocked_by_default === true);
    const allowedHosts = Array.isArray(allowlist && allowlist.allowed_hosts) ? allowlist.allowed_hosts : [];
    if (!blockedByDefault) {
      failures.push({ check: "attestation_gating", reason: "blocked_by_default_must_be_true" });
    }
    if (allowedHosts.length === 0) {
      failures.push({ check: "attestation_gating", reason: "allowed_hosts_missing" });
    }
  }

  const result = {
    healthy: failures.length === 0,
    failures
  };

  if (!result.healthy) {
    logger.error({ event: "phase10_startup_integrity_failed", failures: result.failures });
    return result;
  }

  logger.info({
    event: "phase10_startup_integrity_verified",
    checks: "all",
    healthy: true
  });

  return result;
}

module.exports = {
  verifyPhase10StartupIntegrity
};
