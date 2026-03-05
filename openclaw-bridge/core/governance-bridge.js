"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, canonicalJson, safeString, sha256 } = require("../../workflows/governance-automation/common.js");
const { computeDraftContentHash } = require("../../workflows/rlhf-generator/rlhf-schema.js");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeIso(value, fallback) {
  const text = safeString(value) || safeString(fallback);
  if (!text || !Number.isFinite(Date.parse(text))) {
    return "1970-01-01T00:00:00.000Z";
  }
  return text;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, canonicalJson(canonicalize(value)), "utf8");
}

function createGovernanceBridge(options = {}) {
  const logger = isPlainObject(options.logger) ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };

  const apiGovernance = options.apiGovernance || null;
  const permissionEnforcer = options.permissionEnforcer || null;
  const complianceGate = options.complianceGate || null;
  const experimentValidator = options.experimentValidator || null;
  const operationalDecisionLedger = options.operationalDecisionLedger || null;
  const telemetryEmitter = options.telemetryEmitter || null;
  const supervisorAuthority = options.supervisorAuthority || null;

  async function appendGovernanceTransactionRecord(record) {
    if (!apiGovernance || typeof apiGovernance.withGovernanceTransaction !== "function") {
      return { ok: false, skipped: true, reason: "api_governance_unavailable" };
    }

    return apiGovernance.withGovernanceTransaction(async (tx) => {
      if (typeof tx.appendResearchRecord === "function") {
        tx.appendResearchRecord(canonicalize(record));
      }
      return { ok: true };
    }, {
      correlationId: safeString(record.correlation_id)
    });
  }

  async function requestSupervisorApproval(taskDefinition, context = {}) {
    if (!supervisorAuthority || typeof supervisorAuthority.requestApproval !== "function") {
      const denied = canonicalize({
        approved: false,
        reason: "supervisor_unavailable",
        decision_id: "sup-unavailable",
        task_id: safeString(taskDefinition && taskDefinition.task_id),
        timestamp: normalizeIso(timeProvider.nowIso(), "1970-01-01T00:00:00.000Z")
      });
      await appendGovernanceTransactionRecord({
        event: "phase14.supervisor.decision",
        task_id: denied.task_id,
        approved: false,
        reason: denied.reason,
        timestamp: denied.timestamp,
        correlation_id: safeString(context.correlationId)
      });
      return denied;
    }

    const decision = await supervisorAuthority.requestApproval(taskDefinition, context);

    if (operationalDecisionLedger && typeof operationalDecisionLedger.recordDecision === "function") {
      await operationalDecisionLedger.recordDecision({
        event_type: "phase14.supervisor.decision",
        actor: safeString(context.operatorId) || "operator",
        action: "approve_task",
        result: decision.approved ? "allow" : "deny",
        scope: "phase14.research.task",
        details: canonicalize({
          decision_id: decision.decision_id,
          reason: decision.reason,
          task_id: safeString(taskDefinition && taskDefinition.task_id)
        })
      }, {
        correlationId: safeString(context.correlationId)
      });
    }

    await appendGovernanceTransactionRecord({
      event: "phase14.supervisor.decision",
      task_id: safeString(taskDefinition && taskDefinition.task_id),
      approved: decision.approved === true,
      reason: safeString(decision.reason),
      decision_id: safeString(decision.decision_id),
      timestamp: normalizeIso(decision.timestamp, timeProvider.nowIso()),
      correlation_id: safeString(context.correlationId)
    });

    return decision;
  }

  async function requestTaskApproval(taskDefinition, context = {}) {
    const taskId = safeString(taskDefinition && taskDefinition.task_id);
    const supervisorDecision = context.supervisorDecision && typeof context.supervisorDecision === "object"
      ? context.supervisorDecision
      : {};

    if (supervisorDecision.approved !== true) {
      return canonicalize({ approved: false, reason: "supervisor_not_approved", task_id: taskId });
    }

    if (safeString(context.token) && permissionEnforcer && typeof permissionEnforcer.evaluateAccess === "function") {
      const access = await permissionEnforcer.evaluateAccess({
        token_id: safeString(context.token),
        action: "scan",
        resource: "governance.compliance",
        scope: "governance.compliance.scan"
      });
      if (!access.allowed) {
        return canonicalize({ approved: false, reason: `access_denied:${safeString(access.reason)}`, task_id: taskId });
      }
    }

    if (complianceGate && typeof complianceGate.validateTask === "function") {
      const complianceResult = await complianceGate.validateTask(taskDefinition, context);
      if (!complianceResult || complianceResult.approved !== true) {
        return canonicalize({
          approved: false,
          reason: safeString(complianceResult && complianceResult.reason) || "compliance_denied",
          task_id: taskId
        });
      }
    }

    if (complianceGate && typeof complianceGate.evaluateReleaseGate === "function" && context.requireStrictCompliance === true) {
      const releaseResult = await complianceGate.evaluateReleaseGate({
        targetRef: "phase14-task",
        targetSha: sha256(taskId),
        asOfIso: normalizeIso(timeProvider.nowIso(), "1970-01-01T00:00:00.000Z")
      });
      if (!releaseResult || releaseResult.decision === "block") {
        return canonicalize({ approved: false, reason: "compliance_block", task_id: taskId });
      }
    }

    if (context.experiment && experimentValidator && typeof experimentValidator.validateTask === "function") {
      const experimentResult = await experimentValidator.validateTask(context.experiment, taskDefinition, context);
      if (!experimentResult || experimentResult.approved !== true) {
        return canonicalize({ approved: false, reason: "experiment_denied", task_id: taskId });
      }
    }

    return canonicalize({ approved: true, reason: "governance_approved", task_id: taskId });
  }

  async function recordTaskExecution(taskId, result, context = {}) {
    const normalizedTaskId = safeString(taskId);
    const normalizedResult = isPlainObject(result) ? canonicalize(result) : { ok: Boolean(result) };

    if (operationalDecisionLedger && typeof operationalDecisionLedger.recordDecision === "function") {
      await operationalDecisionLedger.recordDecision({
        event_type: "phase14.task.execution",
        actor: safeString(context.operatorId) || "operator",
        action: "execute_task",
        result: normalizedResult.status || (normalizedResult.ok ? "completed" : "failed"),
        scope: "phase14.research.task",
        details: canonicalize({ task_id: normalizedTaskId, status: normalizedResult.status || "unknown" })
      }, {
        correlationId: safeString(context.correlationId)
      });
    }

    if (telemetryEmitter && typeof telemetryEmitter.emitComplianceEvent === "function") {
      telemetryEmitter.emitComplianceEvent({
        event_type: "phase14.task.execution",
        phase: "phase14",
        actor: safeString(context.operatorId) || "operator",
        scope: "phase14.research.task",
        result: normalizedResult.status || "completed"
      });
    }

    await appendGovernanceTransactionRecord({
      event: "phase14.task.execution",
      task_id: normalizedTaskId,
      status: safeString(normalizedResult.status) || "completed",
      provider: safeString(normalizedResult.provider),
      model: safeString(normalizedResult.model),
      token_count: Math.max(0, Number.parseInt(String(normalizedResult.tokenCount || normalizedResult.token_count || 0), 10) || 0),
      timestamp: normalizeIso(timeProvider.nowIso(), "1970-01-01T00:00:00.000Z"),
      correlation_id: safeString(context.correlationId)
    });

    return canonicalize({ ok: true, task_id: normalizedTaskId });
  }

  async function generateRLHFEntry(taskId, interaction = {}, context = {}) {
    const normalizedTaskId = safeString(taskId);
    const timestamp = normalizeIso(timeProvider.nowIso(), "1970-01-01T00:00:00.000Z");
    const responseText = safeString(interaction.response || interaction.text);
    const taskSourceHash = sha256(`${normalizedTaskId}|${responseText}`);

    const entry = canonicalize({
      source: "phase14-task-execution",
      task_id: normalizedTaskId,
      created_at: timestamp,
      provider: safeString(interaction.provider) || "mock",
      model: safeString(interaction.model) || "mock-v1",
      prompt_hash: sha256(safeString(interaction.prompt)),
      response_hash: sha256(responseText),
      token_count: Math.max(0, Number.parseInt(String(interaction.tokenCount || interaction.token_count || 0), 10) || 0),
      duration_ms: Math.max(0, Number.parseInt(String(interaction.durationMs || interaction.duration_ms || 0), 10) || 0)
    });

    let globalRecord = null;

    if (apiGovernance && typeof apiGovernance.withGovernanceTransaction === "function") {
      globalRecord = await apiGovernance.withGovernanceTransaction(async (tx) => {
        const state = tx.state;
        if (!state.rlhfWorkflows || typeof state.rlhfWorkflows !== "object") {
          state.rlhfWorkflows = {
            drafts: [],
            candidateQueue: [],
            reviewQueue: [],
            nextDraftSequence: 0,
            nextQueueSequence: 0,
            lastAutomationRunAt: "",
            generatorVersion: "v1"
          };
        }

        const nextDraftSequence = Math.max(0, Number(state.rlhfWorkflows.nextDraftSequence || 0)) + 1;
        const draftWithoutHash = canonicalize({
          sequence: nextDraftSequence,
          sourcePaperId: `task:${normalizedTaskId}`,
          sourceHash: taskSourceHash,
          domainTag: "research-task",
          complexityScore: 50,
          monetizationScore: 0,
          generatedAt: timestamp,
          generatorVersion: "phase14-task-v1",
          status: "draft",
          aiAssisted: true,
          reviewedBy: null,
          reviewedAt: null,
          notes: `Generated from task execution ${normalizedTaskId}`,
          manualSubmissionRequired: true
        });

        const contentHash = computeDraftContentHash(draftWithoutHash);
        const draft = canonicalize({ ...draftWithoutHash, contentHash });
        state.rlhfWorkflows.drafts.push(draft);
        state.rlhfWorkflows.drafts.sort((left, right) => Number(left.sequence) - Number(right.sequence));
        state.rlhfWorkflows.nextDraftSequence = nextDraftSequence;

        const nextQueueSequence = Math.max(0, Number(state.rlhfWorkflows.nextQueueSequence || 0)) + 1;
        state.rlhfWorkflows.reviewQueue.push(canonicalize({
          queueSequence: nextQueueSequence,
          draftSequence: nextDraftSequence,
          status: "pending_review",
          enqueuedAt: timestamp,
          updatedAt: timestamp,
          notes: `phase14_auto_ingest:${normalizedTaskId}`
        }));
        state.rlhfWorkflows.reviewQueue.sort((left, right) => Number(left.queueSequence) - Number(right.queueSequence));
        state.rlhfWorkflows.nextQueueSequence = nextQueueSequence;
        state.rlhfWorkflows.lastAutomationRunAt = timestamp;

        return canonicalize({
          draft_sequence: nextDraftSequence,
          queue_sequence: nextQueueSequence,
          content_hash: contentHash
        });
      }, {
        correlationId: safeString(context.correlationId)
      });
    }

    let localMirrorPath = "";
    if (safeString(context.taskOutputDir)) {
      localMirrorPath = path.join(path.resolve(context.taskOutputDir), "rlhf-entry.json");
      writeJson(localMirrorPath, canonicalize({ entry, global_record: globalRecord }));
    }

    return canonicalize({
      ok: true,
      task_id: normalizedTaskId,
      entry,
      global_record: globalRecord,
      local_mirror_path: localMirrorPath
    });
  }

  return Object.freeze({
    requestSupervisorApproval,
    requestTaskApproval,
    recordTaskExecution,
    generateRLHFEntry
  });
}

module.exports = {
  createGovernanceBridge
};
