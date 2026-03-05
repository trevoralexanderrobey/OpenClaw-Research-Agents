"use strict";

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const {
  assertOperatorRole,
  assertKillSwitchOpen,
  consumeScopedApprovalToken,
  safeString
} = require("../compliance-governance/compliance-validator.js");
const { canonicalize } = require("../governance-automation/common.js");
const { createOperatorOverrideLedger } = require("../governance-automation/operator-override-ledger.js");
const { createOperationalDecisionLedger } = require("../observability/operational-decision-ledger.js");
const { RECOVERY_SCHEMA_VERSION, validateRecoveryPayload } = require("./recovery-schema.js");

const RESTORE_SCOPE = "governance.recovery.restore";

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 11 restore orchestrator error"));
  error.code = String(code || "PHASE11_RESTORE_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function normalizeRestoreRequest(input) {
  const source = input && typeof input === "object" ? input : {};
  const normalized = canonicalize({
    schema_version: safeString(source.schema_version) || RECOVERY_SCHEMA_VERSION,
    request_id: safeString(source.request_id),
    checkpoint_id: safeString(source.checkpoint_id),
    manifest_id: safeString(source.manifest_id),
    requested_by: safeString(source.requested_by) || "operator",
    requested_scope: safeString(source.requested_scope) || RESTORE_SCOPE,
    confirm_required: source.confirm_required !== false,
    reason: safeString(source.reason) || "recovery_assurance_restore",
    restore_targets: Array.isArray(source.restore_targets)
      ? source.restore_targets.map((entry) => safeString(entry)).filter(Boolean).sort((l, r) => l.localeCompare(r))
      : [],
    risk_tags: Array.isArray(source.risk_tags)
      ? source.risk_tags.map((entry) => safeString(entry)).filter(Boolean).sort((l, r) => l.localeCompare(r))
      : []
  });

  const validation = validateRecoveryPayload("restore_request", normalized);
  if (!validation.valid) {
    throw makeError("PHASE11_RESTORE_REQUEST_INVALID", "restore request payload failed schema validation", {
      violations: validation.violations
    });
  }

  return normalized;
}

function summarizeRisk(restoreRequest) {
  const targets = Array.isArray(restoreRequest.restore_targets) ? restoreRequest.restore_targets.length : 0;
  const tags = Array.isArray(restoreRequest.risk_tags) ? restoreRequest.risk_tags : [];
  const hasCriticalTag = tags.some((tag) => tag === "critical" || tag === "data-loss");

  const level = hasCriticalTag
    ? "high"
    : (targets > 3 ? "medium" : "low");

  return canonicalize({
    level,
    restore_targets: targets,
    risk_tags: tags,
    advisory_only_until_confirm: true,
    auto_restore_blocked: true
  });
}

function defaultRestoreExecutor(input = {}) {
  return canonicalize({
    status: "simulated",
    execution_mode: "simulation",
    restore_applied: false,
    fail_closed_default: true,
    notes: `No restoreExecutor injected for request ${safeString(input.request_id) || "unknown"}`
  });
}

function createRestoreOrchestrator(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };
  const restoreExecutor = typeof options.restoreExecutor === "function"
    ? options.restoreExecutor
    : defaultRestoreExecutor;

  if (!apiGovernance || typeof apiGovernance.readState !== "function" || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE11_RESTORE_CONFIG_INVALID", "apiGovernance.readState and withGovernanceTransaction are required");
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function" || typeof operatorAuthorization.issueApprovalToken !== "function") {
    throw makeError("PHASE11_RESTORE_CONFIG_INVALID", "operatorAuthorization consume/issue APIs are required");
  }

  const overrideLedger = options.overrideLedger || createOperatorOverrideLedger({
    apiGovernance,
    operatorAuthorization,
    logger,
    timeProvider
  });

  const decisionLedger = options.decisionLedger || createOperationalDecisionLedger({
    apiGovernance,
    logger,
    timeProvider
  });

  function presentRestorePlan(input = {}) {
    const restoreRequest = normalizeRestoreRequest(input.restoreRequest || input.restore_request || input);
    const risk = summarizeRisk(restoreRequest);

    const plan = canonicalize({
      title: "Phase 11 Restore Plan",
      restore_request_id: restoreRequest.request_id,
      checkpoint_id: restoreRequest.checkpoint_id,
      manifest_id: restoreRequest.manifest_id,
      restore_targets: restoreRequest.restore_targets,
      governance_transaction_wrapper_required: true,
      operator_approval_token_required: true,
      explicit_confirm_required: true,
      no_autonomous_restore: true
    });

    const acceptanceCriteria = canonicalize([
      "Operator role is asserted",
      "Scoped approval token governance.recovery.restore is consumed",
      "Explicit confirm flag is true",
      "Override and operational decision ledgers receive immutable entries",
      "Execution defaults to simulation when no explicit restore executor is injected"
    ]);

    return canonicalize({
      plan,
      risk,
      acceptance_criteria: acceptanceCriteria
    });
  }

  async function recordOverrideDecision(operatorId, reason, phaseImpact, overridePolicy, correlationId) {
    const overrideToken = operatorAuthorization.issueApprovalToken({
      operatorId,
      scope: "governance.override.apply",
      correlationId
    }).token;

    return overrideLedger.recordOverride({
      approvalToken: overrideToken,
      approval_scope: "governance.override.apply",
      scope: "phase11.recovery.restore",
      reason,
      phase_impact: phaseImpact,
      override_policy: overridePolicy
    }, {
      role: "operator",
      requester: operatorId,
      correlationId
    });
  }

  async function recordDecision(operatorId, correlationId, result, details) {
    return decisionLedger.recordDecision({
      timestamp: String(timeProvider.nowIso()),
      event_type: "recovery.restore.decision",
      actor: operatorId,
      action: "execute_restore",
      result,
      scope: "phase11.recovery.restore",
      details: canonicalize(details)
    }, {
      role: "operator",
      requester: operatorId,
      requireOperatorRole: true,
      correlationId
    });
  }

  async function executeRestore(input = {}, context = {}) {
    assertOperatorRole(context);

    const operatorId = safeString(context.requester) || "operator";
    const correlationId = safeString(context.correlationId) || `phase11-restore-${operatorId}`;
    const confirm = context.confirm === true || input.confirm === true;
    const approvalToken = safeString(context.approvalToken || input.approvalToken || input.approval_token);
    const restoreRequest = normalizeRestoreRequest(input.restoreRequest || input.restore_request || input);

    const presentation = presentRestorePlan({ restoreRequest });

    if (!confirm) {
      const overrideEntry = await recordOverrideDecision(
        operatorId,
        "Restore execution rejected because confirmation flag was not provided",
        "No restore action applied",
        "phase11-restore-confirmation-required",
        correlationId
      );
      const ledgerEntry = await recordDecision(operatorId, correlationId, "rejected", {
        reason: "missing_confirm",
        restore_request_id: restoreRequest.request_id,
        override_id: safeString(overrideEntry.override_id)
      });

      return canonicalize({
        result: {
          status: "rejected",
          reason: "missing_confirm",
          operator_confirmed: false,
          execution_mode: "none",
          advisory_only: true,
          auto_restore_blocked: true
        },
        ledger_entry: ledgerEntry,
        presentation
      });
    }

    if (!approvalToken) {
      const overrideEntry = await recordOverrideDecision(
        operatorId,
        "Restore execution rejected because approval token was not provided",
        "No restore action applied",
        "phase11-restore-token-required",
        correlationId
      );
      const ledgerEntry = await recordDecision(operatorId, correlationId, "rejected", {
        reason: "missing_approval_token",
        restore_request_id: restoreRequest.request_id,
        override_id: safeString(overrideEntry.override_id)
      });

      return canonicalize({
        result: {
          status: "rejected",
          reason: "missing_approval_token",
          operator_confirmed: true,
          execution_mode: "none",
          token_scope: RESTORE_SCOPE,
          advisory_only: true,
          auto_restore_blocked: true
        },
        ledger_entry: ledgerEntry,
        presentation
      });
    }

    consumeScopedApprovalToken(operatorAuthorization, approvalToken, RESTORE_SCOPE, { correlationId });

    const preState = await apiGovernance.readState();
    assertKillSwitchOpen(preState);

    let execution;
    let executionError = null;
    try {
      execution = await Promise.resolve(restoreExecutor({
        restore_request: restoreRequest,
        context: canonicalize({ operator_id: operatorId, correlation_id: correlationId })
      }));
    } catch (error) {
      executionError = error;
      execution = canonicalize({
        status: "failed",
        execution_mode: "simulation",
        restore_applied: false,
        fail_closed_default: true,
        error: safeString(error && error.message)
      });
    }

    const executionMode = safeString(execution.execution_mode) || "simulation";
    const resultStatus = executionError
      ? "failed"
      : (safeString(execution.status) || "simulated");

    const overrideEntry = await recordOverrideDecision(
      operatorId,
      resultStatus === "failed"
        ? "Restore execution approved but failed"
        : "Restore execution approved and recorded",
      resultStatus === "failed"
        ? "No successful restore applied"
        : "Restore workflow executed under operator gate",
      "phase11-restore-human-gated",
      correlationId
    );

    const ledgerEntry = await recordDecision(operatorId, correlationId, resultStatus, {
      restore_request_id: restoreRequest.request_id,
      execution_mode: executionMode,
      checkpoint_id: restoreRequest.checkpoint_id,
      manifest_id: restoreRequest.manifest_id,
      override_id: safeString(overrideEntry.override_id)
    });

    logger.info({
      event: "phase11_restore_execution_complete",
      operator: operatorId,
      status: resultStatus,
      execution_mode: executionMode,
      restore_request_id: restoreRequest.request_id
    });

    const restoreResult = canonicalize({
      schema_version: RECOVERY_SCHEMA_VERSION,
      request_id: restoreRequest.request_id,
      result: resultStatus,
      execution_mode: executionMode,
      operator_confirmed: true,
      token_scope: RESTORE_SCOPE,
      advisory_only: executionMode === "simulation",
      auto_restore_blocked: executionMode === "simulation",
      details: canonicalize(execution)
    });

    const validation = validateRecoveryPayload("restore_result", restoreResult);
    if (!validation.valid) {
      throw makeError("PHASE11_RESTORE_RESULT_INVALID", "restore result failed schema validation", {
        violations: validation.violations
      });
    }

    return canonicalize({
      result: restoreResult,
      ledger_entry: ledgerEntry,
      presentation
    });
  }

  return Object.freeze({
    presentRestorePlan,
    executeRestore
  });
}

module.exports = {
  RESTORE_SCOPE,
  createRestoreOrchestrator,
  normalizeRestoreRequest,
  summarizeRisk
};
