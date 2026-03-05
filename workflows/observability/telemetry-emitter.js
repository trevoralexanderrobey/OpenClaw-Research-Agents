"use strict";

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const { safeString, canonicalize } = require("../governance-automation/common.js");
const { normalizeEvent } = require("./metrics-schema.js");

function makeError(code, message) {
  const error = new Error(String(message || "Phase 10 telemetry emitter error"));
  error.code = String(code || "PHASE10_TELEMETRY_EMITTER_ERROR");
  return error;
}

function createTelemetryEmitter(options = {}) {
  const metricsExporter = options.metricsExporter;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };

  if (!metricsExporter || typeof metricsExporter.recordEvent !== "function") {
    throw makeError("PHASE10_TELEMETRY_CONFIG_INVALID", "metricsExporter.recordEvent is required");
  }

  function emitEvent(defaultEventType, input = {}) {
    const source = input && typeof input === "object" ? input : {};
    const normalized = normalizeEvent({
      timestamp: safeString(source.timestamp) || String(timeProvider.nowIso()),
      event_type: safeString(source.event_type) || defaultEventType,
      phase: safeString(source.phase) || "phase10",
      actor: safeString(source.actor) || "system",
      scope: safeString(source.scope) || "phase10",
      result: safeString(source.result) || "recorded",
      severity: safeString(source.severity),
      duration_ms: source.duration_ms,
      decision_latency_ms: source.decision_latency_ms,
      approval_latency_ms: source.approval_latency_ms,
      escalation_latency_ms: source.escalation_latency_ms,
      violation_count: source.violation_count,
      active_count: source.active_count,
      gate_violations: source.gate_violations
    });

    try {
      metricsExporter.recordEvent(normalized);
      logger.info({
        event: "phase10_telemetry_event_emitted",
        event_type: normalized.event_type,
        phase: normalized.phase,
        actor: normalized.actor,
        scope: normalized.scope,
        result: normalized.result
      });
    } catch (error) {
      logger.warn({
        event: "phase10_telemetry_emit_failed",
        event_type: normalized.event_type,
        message: error && error.message ? error.message : String(error)
      });
    }

    return canonicalize(normalized);
  }

  function emitComplianceEvent(input) {
    emitEvent("compliance.scan", input);
  }

  function emitDriftEvent(input) {
    emitEvent("policy.drift", input);
  }

  function emitRemediationEvent(input) {
    emitEvent("remediation.requested", input);
  }

  function emitOverrideEvent(input) {
    emitEvent("override.recorded", input);
  }

  function emitIncidentEvent(input) {
    emitEvent("incident.created", input);
  }

  function emitAttestationEvent(input) {
    emitEvent("attestation.anchor.attempt", input);
  }

  return Object.freeze({
    emitComplianceEvent,
    emitDriftEvent,
    emitRemediationEvent,
    emitOverrideEvent,
    emitIncidentEvent,
    emitAttestationEvent
  });
}

module.exports = {
  createTelemetryEmitter
};
