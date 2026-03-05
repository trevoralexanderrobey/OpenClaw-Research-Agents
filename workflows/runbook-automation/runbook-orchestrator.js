"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
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

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 10 runbook orchestrator error"));
  error.code = String(code || "PHASE10_RUNBOOK_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function normalizeRemediationRequest(input) {
  const source = input && typeof input === "object" ? input : {};
  const recommendations = Array.isArray(source.recommendations)
    ? source.recommendations.map((entry) => canonicalize(entry && typeof entry === "object" ? entry : {}))
    : [];

  return canonicalize({
    schema_version: safeString(source.schema_version) || "phase9-remediation-request-v1",
    baseline_commit: safeString(source.baseline_commit),
    operator_approval_token_required: source.operator_approval_token_required === true,
    governance_transaction_wrapper_required: source.governance_transaction_wrapper_required === true,
    generated_without_autonomous_execution: source.generated_without_autonomous_execution === true,
    recommendations
  });
}

function summarizeRisk(recommendations) {
  const severityCounts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0
  };

  for (const recommendation of recommendations) {
    const severity = safeString(recommendation && recommendation.severity).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(severityCounts, severity)) {
      severityCounts[severity] += 1;
    }
  }

  const level = severityCounts.critical > 0
    ? "high"
    : (severityCounts.high > 0 ? "medium" : "low");

  return canonicalize({ level, severity_counts: severityCounts });
}

function defaultApplyRemediationExecutor(input = {}) {
  const remediationRequestPath = path.resolve(safeString(input.remediation_request_path));
  const approvalToken = safeString(input.approval_token);
  const rootDir = safeString(input.root_dir) || process.cwd();

  const run = spawnSync("node", [
    path.resolve(rootDir, "scripts", "apply-remediation-delta.js"),
    "--approval-token",
    approvalToken,
    "--remediation-request",
    remediationRequestPath,
    "--confirm"
  ], {
    cwd: rootDir,
    encoding: "utf8"
  });

  return canonicalize({
    status: Number(run.status),
    ok: Number(run.status) === 0,
    stdout: safeString(run.stdout),
    stderr: safeString(run.stderr)
  });
}

function createRunbookOrchestrator(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };
  const applyRemediationExecutor = typeof options.applyRemediationExecutor === "function"
    ? options.applyRemediationExecutor
    : defaultApplyRemediationExecutor;

  if (!apiGovernance || typeof apiGovernance.readState !== "function" || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE10_RUNBOOK_CONFIG_INVALID", "apiGovernance.readState and withGovernanceTransaction are required");
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function" || typeof operatorAuthorization.issueApprovalToken !== "function") {
    throw makeError("PHASE10_RUNBOOK_CONFIG_INVALID", "operatorAuthorization consume/issue APIs are required");
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

  function presentRunbook(remediationRequestInput) {
    const remediationRequest = normalizeRemediationRequest(remediationRequestInput);
    const recommendations = remediationRequest.recommendations;
    const risk = summarizeRisk(recommendations);

    const prompt = canonicalize({
      title: "Phase 10 Runbook Review",
      baseline_commit: remediationRequest.baseline_commit,
      recommendations_count: recommendations.length,
      governance_transaction_wrapper_required: remediationRequest.governance_transaction_wrapper_required,
      operator_approval_token_required: remediationRequest.operator_approval_token_required,
      risk_assessment: risk,
      requires_confirmation: true,
      requires_approval_token: true,
      advisory_only_until_confirmed: true
    });

    const helpers = canonicalize([
      "Review each recommendation and rationale",
      "Confirm acceptance criteria and rollback feasibility",
      "Execute with --approval-token <token> --confirm",
      "No automatic execution without explicit operator confirmation"
    ]);

    return canonicalize({ prompt, helpers });
  }

  async function recordOverrideForRunbookDecision(operatorId, decisionSummary, correlationId) {
    const overrideToken = operatorAuthorization.issueApprovalToken({
      operatorId,
      scope: "governance.override.apply",
      correlationId
    }).token;

    return overrideLedger.recordOverride({
      approvalToken: overrideToken,
      approval_scope: "governance.override.apply",
      scope: "phase10.runbook",
      reason: safeString(decisionSummary.reason) || "Runbook execution decision",
      phase_impact: safeString(decisionSummary.phase_impact) || "Operational response workflow",
      override_policy: safeString(decisionSummary.override_policy) || "runbook-orchestrator-human-gated"
    }, {
      role: "operator",
      requester: operatorId,
      correlationId
    });
  }

  async function executeRunbookAction(input = {}, context = {}) {
    assertOperatorRole(context);

    const operatorId = safeString(context.requester) || "operator";
    const correlationId = safeString(context.correlationId) || `phase10-runbook-${operatorId}`;
    const remediationRequestPath = path.resolve(safeString(input.remediation_request_path || input.remediationRequestPath || ""));
    const approvalToken = safeString(input.approvalToken);
    const confirmed = input.confirm === true;
    const remediationRequest = normalizeRemediationRequest(input.remediationRequest || {});

    const baseDecision = {
      decision: "rejected",
      reason: "operator_confirmation_missing",
      operator: operatorId,
      confirmed,
      remediation_request_path: remediationRequestPath
    };

    if (!confirmed) {
      const overrideEntry = await recordOverrideForRunbookDecision(operatorId, {
        reason: "Runbook execution rejected because confirmation flag was not provided",
        phase_impact: "No remediation applied",
        override_policy: "runbook-confirmation-required"
      }, correlationId);

      const ledgerEntry = await decisionLedger.recordDecision({
        timestamp: String(timeProvider.nowIso()),
        event_type: "runbook.decision",
        actor: operatorId,
        action: "execute_runbook",
        result: "rejected",
        scope: "phase10.runbook",
        details: {
          reason: "missing_confirm",
          remediation_request_path: remediationRequestPath,
          override_id: safeString(overrideEntry.override_id)
        }
      }, {
        role: "operator",
        requester: operatorId,
        requireOperatorRole: true,
        correlationId
      });

      return canonicalize({
        decision: canonicalize(baseDecision),
        ledger_entry: canonicalize(ledgerEntry)
      });
    }

    if (!approvalToken) {
      throw makeError("PHASE10_RUNBOOK_APPROVAL_TOKEN_REQUIRED", "approval token is required when --confirm is set");
    }

    consumeScopedApprovalToken(operatorAuthorization, approvalToken, "governance.remediation.apply", { correlationId });

    const preState = await apiGovernance.readState();
    assertKillSwitchOpen(preState);

    const remediationResult = applyRemediationExecutor({
      remediation_request_path: remediationRequestPath,
      approval_token: approvalToken,
      root_dir: safeString(input.rootDir) || process.cwd(),
      remediation_request: remediationRequest
    });

    const resultStatus = remediationResult && remediationResult.ok === true ? "applied" : "failed";

    const overrideEntry = await recordOverrideForRunbookDecision(operatorId, {
      reason: resultStatus === "applied"
        ? "Runbook execution approved and applied"
        : "Runbook execution approved but remediation apply failed",
      phase_impact: resultStatus === "applied"
        ? "Remediation delta applied under operator approval"
        : "No successful remediation was applied",
      override_policy: "runbook-orchestrator-human-gated"
    }, correlationId);

    const ledgerEntry = await decisionLedger.recordDecision({
      timestamp: String(timeProvider.nowIso()),
      event_type: "runbook.decision",
      actor: operatorId,
      action: "execute_runbook",
      result: resultStatus,
      scope: "phase10.runbook",
      details: {
        remediation_request_path: remediationRequestPath,
        remediation_result: remediationResult,
        override_id: safeString(overrideEntry.override_id)
      }
    }, {
      role: "operator",
      requester: operatorId,
      requireOperatorRole: true,
      correlationId
    });

    logger.info({
      event: "phase10_runbook_execution_complete",
      operator: operatorId,
      result: resultStatus,
      remediation_request_path: remediationRequestPath
    });

    return canonicalize({
      decision: canonicalize({
        decision: resultStatus,
        reason: resultStatus === "applied" ? "operator_approved" : "remediation_apply_failed",
        operator: operatorId,
        confirmed: true,
        remediation_request_path: remediationRequestPath
      }),
      ledger_entry: canonicalize(ledgerEntry),
      remediation_result: canonicalize(remediationResult)
    });
  }

  return Object.freeze({
    presentRunbook,
    executeRunbookAction
  });
}

module.exports = {
  createRunbookOrchestrator,
  normalizeRemediationRequest,
  summarizeRisk
};
