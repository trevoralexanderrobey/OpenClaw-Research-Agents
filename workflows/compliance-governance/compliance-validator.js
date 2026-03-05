"use strict";

const {
  canonicalStringify,
  makeError,
  RELEASE_GATE_DECISION_VALUES,
  RELEASE_GATE_REASON_CODE_VALUES
} = require("./compliance-schema.js");

const DEFAULT_REQUIRED_CHECKS = Object.freeze([
  "phase2-gates",
  "mcp-policy",
  "phase6-policy",
  "phase7-policy"
]);

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRole(context = {}) {
  return safeString(context.role).toLowerCase() || "supervisor";
}

function assertOperatorRole(context = {}) {
  const role = normalizeRole(context);
  if (role === "supervisor") {
    throw makeError("COMPLIANCE_ROLE_DENIED", "Supervisor cannot mutate compliance governance state");
  }
  if (role !== "operator") {
    throw makeError("COMPLIANCE_ROLE_DENIED", "Only operator role can mutate compliance governance state");
  }
}

function assertKillSwitchOpen(state) {
  const active = Boolean(
    state
    && state.outboundMutation
    && state.outboundMutation.killSwitch === true
  );
  if (active) {
    throw makeError("COMPLIANCE_KILL_SWITCH_ACTIVE", "Phase 8 mutations are blocked while kill-switch is active");
  }
}

function consumeScopedApprovalToken(operatorAuthorization, approvalToken, scope, context = {}) {
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function") {
    throw makeError("COMPLIANCE_CONFIG_INVALID", "operatorAuthorization.consumeApprovalToken is required");
  }
  return operatorAuthorization.consumeApprovalToken(approvalToken, scope, {
    correlationId: safeString(context.correlationId)
  });
}

function normalizeRequiredChecks(value) {
  if (!Array.isArray(value)) {
    return [...DEFAULT_REQUIRED_CHECKS];
  }
  const deduped = new Set(
    value
      .map((entry) => safeString(entry))
      .filter(Boolean)
  );
  const checks = [...deduped].sort((left, right) => left.localeCompare(right));
  return checks.length > 0 ? checks : [...DEFAULT_REQUIRED_CHECKS];
}

function ensureComplianceGovernanceState(state) {
  if (!state || typeof state !== "object") {
    throw makeError("COMPLIANCE_STATE_INVALID", "State object is required");
  }

  if (!state.complianceGovernance || typeof state.complianceGovernance !== "object") {
    state.complianceGovernance = {};
  }

  const block = state.complianceGovernance;
  if (!Array.isArray(block.attestationSnapshots)) block.attestationSnapshots = [];
  if (!Array.isArray(block.evidenceBundles)) block.evidenceBundles = [];
  if (!Array.isArray(block.releaseGates)) block.releaseGates = [];
  if (!block.decisionLedger || typeof block.decisionLedger !== "object") {
    block.decisionLedger = { records: [], nextSequence: 0, chainHead: "" };
  }
  if (!Array.isArray(block.decisionLedger.records)) {
    block.decisionLedger.records = [];
  }

  if (!block.activeReleasePolicy || typeof block.activeReleasePolicy !== "object") {
    block.activeReleasePolicy = {
      version: "v1",
      updatedAt: "",
      updatedBy: "",
      requiredChecks: [...DEFAULT_REQUIRED_CHECKS],
      minEvidenceFreshnessHours: 24
    };
  }

  block.activeReleasePolicy.version = safeString(block.activeReleasePolicy.version) || "v1";
  block.activeReleasePolicy.updatedAt = safeString(block.activeReleasePolicy.updatedAt);
  block.activeReleasePolicy.updatedBy = safeString(block.activeReleasePolicy.updatedBy);
  block.activeReleasePolicy.requiredChecks = normalizeRequiredChecks(block.activeReleasePolicy.requiredChecks);
  block.activeReleasePolicy.minEvidenceFreshnessHours = Math.max(
    1,
    Number.parseInt(String(block.activeReleasePolicy.minEvidenceFreshnessHours ?? "24"), 10) || 24
  );

  block.policyVersion = safeString(block.policyVersion) || "v1";

  block.nextAttestationSequence = Math.max(0, Number.parseInt(String(block.nextAttestationSequence ?? "0"), 10) || 0);
  block.nextEvidenceBundleSequence = Math.max(0, Number.parseInt(String(block.nextEvidenceBundleSequence ?? "0"), 10) || 0);
  block.nextReleaseGateSequence = Math.max(0, Number.parseInt(String(block.nextReleaseGateSequence ?? "0"), 10) || 0);
}

function idempotencyFingerprint(payload) {
  return canonicalStringify(payload);
}

function assertIdempotencyReplay(existingRecord, expectedPayload, label) {
  const existingFingerprint = idempotencyFingerprint(existingRecord);
  const expectedFingerprint = idempotencyFingerprint(expectedPayload);
  if (existingFingerprint !== expectedFingerprint) {
    throw makeError(
      "COMPLIANCE_IDEMPOTENCY_CONFLICT",
      `${safeString(label) || "record"} idempotency key reused with divergent payload`
    );
  }
}

function normalizeDecision(value) {
  const normalized = safeString(value);
  if (!RELEASE_GATE_DECISION_VALUES.includes(normalized)) {
    return "hold";
  }
  return normalized;
}

function normalizeReasonCode(value) {
  const normalized = safeString(value);
  if (!RELEASE_GATE_REASON_CODE_VALUES.includes(normalized)) {
    return "policy_violation";
  }
  return normalized;
}

function normalizeAsOfIso(value) {
  return safeString(value) || "";
}

function assertIsoTimestamp(value, code, label) {
  const text = safeString(value);
  const ms = Date.parse(text);
  if (!text || !Number.isFinite(ms)) {
    throw makeError(code, `${safeString(label) || "timestamp"} must be a valid ISO-8601 timestamp`, {
      value: text
    });
  }
  return text;
}

function computeFreshnessHours(asOfIso, referenceIso) {
  const asOfMs = Date.parse(assertIsoTimestamp(asOfIso, "COMPLIANCE_AS_OF_INVALID", "asOfIso"));
  const referenceMs = Date.parse(assertIsoTimestamp(referenceIso, "COMPLIANCE_REFERENCE_TIME_INVALID", "referenceIso"));
  const diffMs = Math.max(0, asOfMs - referenceMs);
  return diffMs / 3600000;
}

function getLatestBySequence(records) {
  const list = Array.isArray(records) ? records : [];
  return list
    .slice()
    .sort((left, right) => Number(right.sequence || 0) - Number(left.sequence || 0))[0] || null;
}

function buildPolicySnapshotHash(policy) {
  const normalized = {
    version: safeString(policy && policy.version) || "v1",
    requiredChecks: normalizeRequiredChecks(policy && policy.requiredChecks),
    minEvidenceFreshnessHours: Math.max(1, Number.parseInt(String((policy && policy.minEvidenceFreshnessHours) ?? "24"), 10) || 24)
  };
  const { sha256 } = require("./compliance-schema.js");
  return sha256(`phase8-policy-snapshot-v1|${canonicalStringify(normalized)}`);
}

function buildReleaseGateIdempotencyFingerprint(input = {}) {
  // Frozen field list unless schema version changes:
  // targetRef, targetSha, decision, reasonCode, asOfIso (normalized absent -> ""), policySnapshotHash
  return canonicalStringify({
    targetRef: safeString(input.targetRef),
    targetSha: safeString(input.targetSha).toLowerCase(),
    decision: normalizeDecision(input.decision),
    reasonCode: normalizeReasonCode(input.reasonCode),
    asOfIso: normalizeAsOfIso(input.asOfIso),
    policySnapshotHash: safeString(input.policySnapshotHash).toLowerCase()
  });
}

module.exports = {
  DEFAULT_REQUIRED_CHECKS,
  safeString,
  normalizeRole,
  assertOperatorRole,
  assertKillSwitchOpen,
  consumeScopedApprovalToken,
  ensureComplianceGovernanceState,
  idempotencyFingerprint,
  assertIdempotencyReplay,
  normalizeDecision,
  normalizeReasonCode,
  normalizeAsOfIso,
  assertIsoTimestamp,
  computeFreshnessHours,
  getLatestBySequence,
  normalizeRequiredChecks,
  buildPolicySnapshotHash,
  buildReleaseGateIdempotencyFingerprint
};
