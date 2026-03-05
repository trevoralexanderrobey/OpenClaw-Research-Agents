"use strict";

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const { canonicalize, safeString } = require("../governance-automation/common.js");
const { createOperationalDecisionLedger } = require("../observability/operational-decision-ledger.js");

const DEFAULT_ESCALATION_POLICY = Object.freeze({
  low: ["email"],
  medium: ["email", "slack"],
  high: ["email", "slack", "cline"],
  critical: ["email", "slack", "cline", "pager"]
});

function makeError(code, message) {
  const error = new Error(String(message || "Phase 10 escalation orchestrator error"));
  error.code = String(code || "PHASE10_ESCALATION_ERROR");
  return error;
}

function normalizeSeverity(value) {
  const severity = safeString(value).toLowerCase();
  if (["low", "medium", "high", "critical"].includes(severity)) {
    return severity;
  }
  return "medium";
}

function normalizePolicy(policy) {
  const source = policy && typeof policy === "object" ? policy : {};
  const out = {};
  for (const key of ["low", "medium", "high", "critical"]) {
    const channels = Array.isArray(source[key]) ? source[key] : DEFAULT_ESCALATION_POLICY[key];
    const deduped = [];
    const seen = new Set();
    for (const channelValue of channels) {
      const channel = safeString(channelValue).toLowerCase();
      if (!channel || seen.has(channel)) {
        continue;
      }
      seen.add(channel);
      deduped.push(channel);
    }
    out[key] = deduped;
  }
  return canonicalize(out);
}

function parseIsoMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function createEscalationOrchestrator(options = {}) {
  const alertRouter = options.alertRouter;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const apiGovernance = options.apiGovernance;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };

  if (!alertRouter || typeof alertRouter.routeAlert !== "function" || typeof alertRouter.recordAlertAcknowledgment !== "function") {
    throw makeError("PHASE10_ESCALATION_CONFIG_INVALID", "alertRouter.routeAlert and recordAlertAcknowledgment are required");
  }
  if (!apiGovernance || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE10_ESCALATION_CONFIG_INVALID", "apiGovernance.withGovernanceTransaction is required");
  }

  const decisionLedger = options.decisionLedger || createOperationalDecisionLedger({
    apiGovernance,
    logger,
    timeProvider
  });

  async function initiateEscalation(incidentInput, policyInput = {}) {
    const incident = incidentInput && typeof incidentInput === "object" ? canonicalize(incidentInput) : {};
    const incidentId = safeString(incident.incident_id) || "INC-UNKNOWN-000";
    const severity = normalizeSeverity(incident.severity);
    const policy = normalizePolicy(policyInput.severity_channels || policyInput);
    const channels = policy[severity];

    const escalatedAt = String(timeProvider.nowIso());
    const alert = canonicalize({
      alert_id: `phase10-escalation-${incidentId}`,
      severity,
      metric: "incident_escalation",
      threshold: { severity },
      breach_duration: 0,
      operator_action_recommended: "Review incident and acknowledge escalation",
      advisory_only: true,
      auto_remediation_blocked: true
    });

    const routed = await alertRouter.routeAlert(alert, channels);

    const escalationLatencyMs = Math.max(0, parseIsoMs(escalatedAt) - parseIsoMs(incident.timestamp));

    await decisionLedger.recordDecision({
      timestamp: escalatedAt,
      event_type: "incident.escalated",
      actor: "system",
      action: "initiate_escalation",
      result: routed.routed ? "routed" : "not_routed",
      scope: "phase10.escalation",
      details: {
        incident_id: incidentId,
        severity,
        channels_notified: routed.delivery_ids,
        advisory_only: true,
        auto_remediation_blocked: true,
        escalation_latency_ms: escalationLatencyMs,
        re_escalation_opt_in: Boolean(policyInput && policyInput.re_escalation_opt_in)
      }
    }, {
      requester: "phase10-escalation-orchestrator"
    });

    logger.info({
      event: "phase10_escalation_initiated",
      incident_id: incidentId,
      severity,
      channels: channels.length
    });

    return canonicalize({
      escalation_id: `ESC-${incidentId}`,
      channels_notified: channels,
      delivery_ids: routed.delivery_ids,
      advisory_only: true,
      auto_remediation_blocked: true
    });
  }

  async function recordEscalationAck(escalationId, operator, timestamp) {
    const ackAt = safeString(timestamp) || String(timeProvider.nowIso());
    const normalizedEscalationId = safeString(escalationId);
    const normalizedOperator = safeString(operator) || "operator";

    await decisionLedger.recordDecision({
      timestamp: ackAt,
      event_type: "incident.escalation_ack",
      actor: normalizedOperator,
      action: "ack_escalation",
      result: "acknowledged",
      scope: "phase10.escalation",
      details: {
        escalation_id: normalizedEscalationId
      }
    }, {
      requester: normalizedOperator
    });

    await alertRouter.recordAlertAcknowledgment(normalizedEscalationId, normalizedOperator, ackAt);

    logger.info({
      event: "phase10_escalation_ack_recorded",
      escalation_id: normalizedEscalationId,
      operator: normalizedOperator
    });
  }

  return Object.freeze({
    initiateEscalation,
    recordEscalationAck
  });
}

module.exports = {
  DEFAULT_ESCALATION_POLICY,
  createEscalationOrchestrator,
  normalizePolicy
};
