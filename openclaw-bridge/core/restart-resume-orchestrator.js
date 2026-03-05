"use strict";

const { canonicalize, safeString } = require("../../workflows/governance-automation/common.js");

function createRestartResumeOrchestrator(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const stateHydrator = options.stateHydrator;
  const openLoopManager = options.openLoopManager;
  const supervisorAuthority = options.supervisorAuthority;
  const governanceBridge = options.governanceBridge;
  const laneQueue = options.laneQueue || null;

  function assertResumeDependencies(context) {
    if (!context || context.executeResumedTasks !== true) {
      return;
    }
    if (!supervisorAuthority || typeof supervisorAuthority.requestApproval !== "function") {
      const error = new Error("Supervisor authority is required for resumed execution");
      error.code = "SUPERVISOR_AUTHORITY_REQUIRED";
      throw error;
    }
    if (!governanceBridge || typeof governanceBridge.requestTaskApproval !== "function") {
      const error = new Error("Governance bridge approval is required for resumed execution");
      error.code = "GOVERNANCE_APPROVAL_REQUIRED";
      throw error;
    }
  }

  async function resumePendingWork(context = {}) {
    if (!stateHydrator || typeof stateHydrator.buildResumePlan !== "function") {
      throw new Error("stateHydrator.buildResumePlan is required");
    }
    assertResumeDependencies(context);

    const resumePlan = await stateHydrator.buildResumePlan();
    const requeueResult = openLoopManager && typeof openLoopManager.requeueOpenLoops === "function"
      ? await openLoopManager.requeueOpenLoops()
      : { ok: true, requeued_count: 0, requeued: [] };
    const approvals = [];

    if (context.executeResumedTasks === true) {
      const requeued = Array.isArray(requeueResult.requeued) ? requeueResult.requeued.slice() : [];
      requeued.sort((left, right) => Number(left.queue_sequence || 0) - Number(right.queue_sequence || 0));

      for (const queued of requeued) {
        const taskEnvelope = queued && typeof queued.task_envelope === "object" && queued.task_envelope
          ? queued.task_envelope
          : {};
        const supervisorDecision = await supervisorAuthority.requestApproval(taskEnvelope, {
          ...context,
          operatorId: safeString(context.operatorId) || "operator-resume",
          confirm: context.confirm === true
        });

        let governanceDecision = { approved: false, reason: "supervisor_denied" };
        if (supervisorDecision && supervisorDecision.approved === true) {
          governanceDecision = await governanceBridge.requestTaskApproval(taskEnvelope, {
            ...context,
            supervisorDecision
          });
        }

        approvals.push(canonicalize({
          loop_id: safeString(queued.loop_id),
          queue_sequence: Number(queued.queue_sequence || 0),
          supervisor_decision: supervisorDecision,
          governance_decision: governanceDecision
        }));

        if (
          supervisorDecision
          && supervisorDecision.approved === true
          && governanceDecision
          && governanceDecision.approved === true
          && typeof context.executeHandler === "function"
        ) {
          await context.executeHandler(taskEnvelope, {
            ...context,
            supervisorDecision,
            governanceDecision
          });
        }
      }
    }

    if (governanceBridge && typeof governanceBridge.recordTaskExecution === "function") {
      await governanceBridge.recordTaskExecution("phase17-resume", {
        status: "resume_planned",
        resume_actions: resumePlan.actions,
        requeued_count: requeueResult.requeued_count,
        approvals
      }, {
        correlationId: safeString(context.correlationId) || "phase17-resume"
      });
    }

    logger.info({
      event: "phase17_resume_completed",
      requeued_count: requeueResult.requeued_count,
      approval_count: approvals.length
    });

    return canonicalize({
      ok: true,
      resume_plan: resumePlan,
      requeue_result: requeueResult,
      approvals,
      queue_state: laneQueue && typeof laneQueue.getQueueState === "function"
        ? laneQueue.getQueueState(safeString(context.sessionId) || "default")
        : null,
      supervisor_required: true
    });
  }

  return Object.freeze({
    resumePendingWork
  });
}

module.exports = {
  createRestartResumeOrchestrator
};
