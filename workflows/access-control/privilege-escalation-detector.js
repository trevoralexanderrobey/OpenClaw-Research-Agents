"use strict";

const { asArray, canonicalize, safeString } = require("../governance-automation/common.js");
const { canonicalHash } = require("./access-control-common.js");

function createPrivilegeEscalationDetector(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };

  function buildEvent(input) {
    return canonicalize({
      event_id: input.event_id,
      actor: safeString(input.actor),
      attempted_action: safeString(input.attempted_action),
      required_role: safeString(input.required_role),
      actual_role: safeString(input.actual_role),
      reason: safeString(input.reason),
      severity: safeString(input.severity) || "advisory",
      timestamp: safeString(input.timestamp) || safeString(timeProvider.nowIso())
    });
  }

  function detectEscalation(accessDecisions) {
    const decisions = asArray(accessDecisions)
      .map((entry) => (entry && typeof entry === "object" ? canonicalize(entry) : {}))
      .sort((left, right) => {
        const leftSequence = Number(left.sequence || 0);
        const rightSequence = Number(right.sequence || 0);
        if (leftSequence !== rightSequence) {
          return leftSequence - rightSequence;
        }
        const leftDecision = safeString(left.decision_id);
        const rightDecision = safeString(right.decision_id);
        return leftDecision.localeCompare(rightDecision);
      });

    const events = [];
    const denyCountByActor = new Map();

    for (const decision of decisions) {
      const actor = safeString(decision.actor);
      const reason = safeString(decision.reason);
      const denied = safeString(decision.result) === "deny";

      if (!denied) {
        continue;
      }

      if (reason.includes("insufficient_role") || reason.includes("permission")) {
        events.push(buildEvent({
          event_id: `esc-${events.length + 1}`,
          actor,
          attempted_action: safeString(decision.action),
          required_role: "operator_admin",
          actual_role: safeString(decision.role),
          reason,
          severity: "high"
        }));
      }

      if (reason.includes("scope_not_granted") || reason.includes("unknown_scope")) {
        events.push(buildEvent({
          event_id: `esc-${events.length + 1}`,
          actor,
          attempted_action: safeString(decision.action),
          required_role: "scope_granted",
          actual_role: safeString(decision.role),
          reason,
          severity: "medium"
        }));
      }

      if (reason.includes("revoked") || reason.includes("expired")) {
        events.push(buildEvent({
          event_id: `esc-${events.length + 1}`,
          actor,
          attempted_action: safeString(decision.action),
          required_role: "active_token",
          actual_role: safeString(decision.role),
          reason,
          severity: "high"
        }));
      }

      const key = actor || "unknown-actor";
      const nextCount = Number(denyCountByActor.get(key) || 0) + 1;
      denyCountByActor.set(key, nextCount);
      if (nextCount >= 3) {
        events.push(buildEvent({
          event_id: `esc-${events.length + 1}`,
          actor,
          attempted_action: "repeated_denied_access",
          required_role: "n/a",
          actual_role: safeString(decision.role),
          reason: "repeated_denied_attempts",
          severity: "medium"
        }));
      }
    }

    const advisoryCount = events.length;
    const criticalCount = events.filter((event) => safeString(event.severity) === "high").length;
    const reportHash = canonicalHash({ events, advisory_only: true, auto_revoke_blocked: true });

    const result = canonicalize({
      events,
      advisory_count: advisoryCount,
      critical_count: criticalCount,
      advisory_only: true,
      auto_revoke_blocked: true,
      report_hash: reportHash
    });

    logger.info({
      event: "phase13_privilege_escalation_detected",
      advisory_count: advisoryCount,
      critical_count: criticalCount
    });

    return result;
  }

  return Object.freeze({
    detectEscalation
  });
}

module.exports = {
  createPrivilegeEscalationDetector
};
