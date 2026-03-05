"use strict";

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const { canonicalize, safeString } = require("../governance-automation/common.js");
const { createOperationalDecisionLedger } = require("./operational-decision-ledger.js");

const SUPPORTED_CHANNELS = Object.freeze(["cline", "email", "webhook", "slack", "pager"]);

function makeError(code, message) {
  const error = new Error(String(message || "Phase 10 alert router error"));
  error.code = String(code || "PHASE10_ALERT_ROUTER_ERROR");
  return error;
}

function normalizeChannels(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const value of input) {
    const channel = safeString(value).toLowerCase();
    if (!channel || seen.has(channel)) {
      continue;
    }
    seen.add(channel);
    out.push(channel);
  }
  out.sort((left, right) => left.localeCompare(right));
  return out;
}

function createAlertRouter(options = {}) {
  const sloAlertEngine = options.sloAlertEngine;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const apiGovernance = options.apiGovernance;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };

  if (!sloAlertEngine || typeof sloAlertEngine.evaluateSlos !== "function") {
    throw makeError("PHASE10_ALERT_ROUTER_CONFIG_INVALID", "sloAlertEngine.evaluateSlos is required");
  }
  if (!apiGovernance || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE10_ALERT_ROUTER_CONFIG_INVALID", "apiGovernance.withGovernanceTransaction is required");
  }

  const decisionLedger = options.decisionLedger || createOperationalDecisionLedger({
    apiGovernance,
    logger,
    timeProvider
  });

  async function routeAlert(alertInput, channelsInput) {
    const alert = alertInput && typeof alertInput === "object" ? canonicalize(alertInput) : {};
    const alertId = safeString(alert.alert_id) || "phase10-alert";
    const channels = normalizeChannels(channelsInput);
    const deliveries = [];

    for (let index = 0; index < channels.length; index += 1) {
      const channel = channels[index];
      if (!SUPPORTED_CHANNELS.includes(channel)) {
        continue;
      }
      deliveries.push(canonicalize({
        delivery_id: `${alertId}-${channel}-${index + 1}`,
        alert_id: alertId,
        channel,
        delivered_at: String(timeProvider.nowIso()),
        advisory_only: true,
        auto_remediation_blocked: true,
        status: "delivered"
      }));
    }

    await decisionLedger.recordDecision({
      timestamp: String(timeProvider.nowIso()),
      event_type: "alert.routed",
      actor: "system",
      action: "route_alert",
      result: deliveries.length > 0 ? "routed" : "not_routed",
      scope: "phase10.alerting",
      details: {
        alert_id: alertId,
        channels_requested: channels,
        channels_delivered: deliveries.map((entry) => entry.channel)
      }
    }, {
      requester: "phase10-alert-router"
    });

    logger.info({
      event: "phase10_alert_routed",
      alert_id: alertId,
      deliveries: deliveries.length
    });

    return canonicalize({
      routed: deliveries.length > 0,
      delivery_ids: deliveries.map((entry) => entry.delivery_id),
      deliveries
    });
  }

  async function recordAlertAcknowledgment(alertId, operator, timestamp) {
    const normalizedAlertId = safeString(alertId);
    const normalizedOperator = safeString(operator) || "operator";
    const ackAt = safeString(timestamp) || String(timeProvider.nowIso());

    await decisionLedger.recordDecision({
      timestamp: ackAt,
      event_type: "alert.acknowledged",
      actor: normalizedOperator,
      action: "ack_alert",
      result: "acknowledged",
      scope: "phase10.alerting",
      details: {
        alert_id: normalizedAlertId
      }
    }, {
      requester: normalizedOperator
    });

    logger.info({
      event: "phase10_alert_ack_recorded",
      alert_id: normalizedAlertId,
      operator: normalizedOperator
    });
  }

  return Object.freeze({
    routeAlert,
    recordAlertAcknowledgment
  });
}

module.exports = {
  SUPPORTED_CHANNELS,
  createAlertRouter,
  normalizeChannels
};
