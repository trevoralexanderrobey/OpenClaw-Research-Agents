"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createSupervisorV1 } = require("../supervisor/supervisor-v1.js");
const { RequestQueue } = require("../supervisor/request-queue.js");
const { createCircuitBreaker } = require("../supervisor/circuit-breaker.js");
const supervisorRegistry = require("../supervisor/supervisor-registry.json");
const { safeString, canonicalize, sha256 } = require("../../workflows/governance-automation/common.js");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeIso(value) {
  const text = safeString(value);
  if (!text || !Number.isFinite(Date.parse(text))) {
    return "1970-01-01T00:00:00.000Z";
  }
  return text;
}

function makeError(code, message, details) {
  const error = new Error(String(message || "Supervisor authority error"));
  error.code = String(code || "PHASE14_SUPERVISOR_AUTHORITY_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function createSupervisorAuthority(options = {}) {
  const logger = isPlainObject(options.logger) ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function" && typeof options.timeProvider.nowMs === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z", nowMs: () => 0 };
  const executeHandler = typeof options.executeHandler === "function" ? options.executeHandler : async (taskEnvelope) => ({ ok: true, taskEnvelope });
  const supervisorConfig = isPlainObject(options.supervisorConfig) ? options.supervisorConfig : {};
  const approvalPolicy = isPlainObject(options.approvalPolicy) ? options.approvalPolicy : {};

  const registryPath = path.join(process.cwd(), "openclaw-bridge", "supervisor", "supervisor-registry.json");
  if (!Array.isArray(supervisorRegistry) || supervisorRegistry.length === 0 || !fs.existsSync(registryPath)) {
    throw makeError("PHASE14_SUPERVISOR_REGISTRY_MISSING", "Supervisor registry is required");
  }

  const laneQueue = new RequestQueue(Number.parseInt(String(supervisorConfig.maxQueueLength || 100), 10) || 100);
  const circuitBreaker = createCircuitBreaker({
    enabled: true,
    failureThreshold: Number.parseInt(String(supervisorConfig.failureThreshold || 3), 10) || 3,
    successThreshold: Number.parseInt(String(supervisorConfig.successThreshold || 1), 10) || 1,
    timeout: Number.parseInt(String(supervisorConfig.timeoutMs || 30000), 10) || 30000
  });

  const supervisorV1 = createSupervisorV1({
    queue: { enabled: true, maxLength: Number.parseInt(String(supervisorConfig.maxQueueLength || 100), 10) || 100 },
    circuitBreaker: { enabled: true },
    handlers: {
      "operator-stub-tool": async () => ({ ok: true, code: "PHASE14_SUPERVISOR_MARKER" })
    }
  });

  const decisions = new Map();
  let initialized = false;
  let nextDecisionSequence = 1;

  async function initialize() {
    if (initialized) {
      return { ok: true, alreadyInitialized: true };
    }
    await supervisorV1.initialize();
    initialized = true;
    return { ok: true, registry_entries: supervisorRegistry.length };
  }

  function buildDecision(taskDefinition, context, approved, reason) {
    const taskId = safeString(taskDefinition && (taskDefinition.task_id || taskDefinition.taskId));
    const sequence = nextDecisionSequence;
    nextDecisionSequence += 1;
    const decision = canonicalize({
      decision_id: `sup-${sequence}`,
      decision_sequence: sequence,
      approved: Boolean(approved),
      reason: safeString(reason) || (approved ? "approved" : "denied"),
      task_id: taskId,
      operator_id: safeString(context && context.operatorId) || "operator",
      timestamp: normalizeIso(timeProvider.nowIso()),
      receipt_hash: sha256(`supervisor-decision-v1|${taskId}|${sequence}|${String(approved)}`)
    });
    decisions.set(decision.decision_id, decision);
    return decision;
  }

  async function requestApproval(taskDefinition = {}, context = {}) {
    if (!initialized) {
      throw makeError("PHASE14_SUPERVISOR_NOT_INITIALIZED", "Supervisor authority is not initialized");
    }

    const requireConfirm = approvalPolicy.requireConfirm !== false;
    const confirm = context.confirm === true;
    if (requireConfirm && !confirm) {
      const denied = buildDecision(taskDefinition, context, false, "missing_confirm");
      logger.warn({ event: "phase14_supervisor_denied", reason: denied.reason, task_id: denied.task_id });
      return denied;
    }

    const description = safeString(taskDefinition.description);
    if (!description) {
      const denied = buildDecision(taskDefinition, context, false, "missing_description");
      logger.warn({ event: "phase14_supervisor_denied", reason: denied.reason, task_id: denied.task_id });
      return denied;
    }

    const approved = buildDecision(taskDefinition, context, true, "supervisor_approved");
    logger.info({ event: "phase14_supervisor_approved", decision_id: approved.decision_id, task_id: approved.task_id });
    return approved;
  }

  function requireApprovedDecision(context = {}) {
    const decision = context && isPlainObject(context.supervisorDecision) ? context.supervisorDecision : null;
    if (!decision || decision.approved !== true) {
      throw makeError("SUPERVISOR_APPROVAL_REQUIRED", "Supervisor approval receipt is required");
    }

    const decisionId = safeString(decision.decision_id);
    const known = decisions.get(decisionId);
    if (!known || known.approved !== true) {
      throw makeError("SUPERVISOR_RECEIPT_INVALID", "Supervisor approval receipt is invalid");
    }

    return known;
  }

  function enqueueApprovedTask(taskEnvelope = {}, context = {}) {
    const decision = requireApprovedDecision(context);
    const queued = laneQueue.enqueue(canonicalize({
      taskEnvelope: isPlainObject(taskEnvelope) ? canonicalize(taskEnvelope) : {},
      supervisorDecision: decision,
      enqueued_at: normalizeIso(timeProvider.nowIso())
    }));

    if (!queued) {
      throw makeError("PHASE14_SUPERVISOR_QUEUE_FULL", "Supervisor queue is full");
    }

    return {
      ok: true,
      queued: true,
      queue_length: laneQueue.length,
      decision_id: decision.decision_id
    };
  }

  async function runApprovedTask(taskEnvelope = {}, context = {}) {
    const decision = requireApprovedDecision(context);

    const breakerGate = circuitBreaker.checkBeforeRequest("task-execution", timeProvider.nowMs());
    if (!breakerGate.allowed) {
      throw makeError("PHASE14_SUPERVISOR_BREAKER_OPEN", "Supervisor circuit breaker is open", {
        decision_id: decision.decision_id,
        next_retry_at: breakerGate.nextRetryAt
      });
    }

    try {
      const result = await executeHandler(taskEnvelope, {
        ...context,
        supervisorDecision: decision
      });
      circuitBreaker.recordSuccess("task-execution", timeProvider.nowMs());
      return result;
    } catch (error) {
      circuitBreaker.recordFailure("task-execution", timeProvider.nowMs());
      throw error;
    } finally {
      circuitBreaker.releaseHalfOpenLease("task-execution");
    }
  }

  async function drainOne() {
    const item = laneQueue.dequeue();
    if (!item) {
      return null;
    }
    const result = await runApprovedTask(item.taskEnvelope, {
      supervisorDecision: item.supervisorDecision,
      confirm: true,
      source: "supervisor_queue"
    });
    return { item, result };
  }

  function getStatus() {
    return canonicalize({
      initialized,
      queue_length: laneQueue.length,
      breaker: circuitBreaker.getSnapshot("task-execution", timeProvider.nowMs()),
      supervisor_registry_entries: supervisorRegistry.length
    });
  }

  return Object.freeze({
    initialize,
    requestApproval,
    runApprovedTask,
    enqueueApprovedTask,
    drainOne,
    getStatus,
    _debug_requireApprovedDecision: requireApprovedDecision,
    _debug_decisions: () => canonicalize(Array.from(decisions.values()).sort((a, b) => Number(a.decision_sequence) - Number(b.decision_sequence)))
  });
}

module.exports = {
  createSupervisorAuthority
};
