"use strict";

const { safeString, canonicalize } = require("../../workflows/governance-automation/common.js");

function createRoleRouter(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const registry = options.registry;
  const autonomyLadder = options.autonomyLadder;

  if (!registry || typeof registry.getRole !== "function") {
    throw new Error("registry.getRole is required");
  }
  if (!autonomyLadder || typeof autonomyLadder.canRolePerform !== "function") {
    throw new Error("autonomyLadder.canRolePerform is required");
  }

  function resolveRole(taskEnvelope = {}) {
    const agentId = safeString(taskEnvelope.agent_id || taskEnvelope.agentId);
    if (agentId && typeof registry.getAgent === "function") {
      const agent = registry.getAgent(agentId);
      if (agent && safeString(agent.role)) {
        return safeString(agent.role);
      }
    }

    const explicitRole = safeString(taskEnvelope.role).toLowerCase();
    if (explicitRole) {
      return explicitRole;
    }

    const taskType = safeString(taskEnvelope.type).toLowerCase();
    if (taskType === "summarize" || taskType === "extract") return "analyst";
    if (taskType === "analyze") return "analyst";
    if (taskType === "synthesize") return "synthesizer";
    return "scout";
  }

  async function dispatch(taskEnvelope = {}, context = {}) {
    if (!context.supervisorDecision || context.supervisorDecision.approved !== true) {
      const error = new Error("Supervisor approval required for role dispatch");
      error.code = "SUPERVISOR_APPROVAL_REQUIRED";
      throw error;
    }

    const agentId = safeString(taskEnvelope.agent_id || taskEnvelope.agentId);
    const role = resolveRole(taskEnvelope);
    const actionType = safeString(taskEnvelope.actionType) || "execute_task";

    if (!autonomyLadder.canRolePerform(role, actionType)) {
      const error = new Error(`Role '${role}' cannot perform action '${actionType}'`);
      error.code = "PHASE15_ROLE_ACTION_DENIED";
      throw error;
    }

    if (autonomyLadder.requireHumanApproval(role, actionType) && context.operatorApproved !== true) {
      const error = new Error(`Human approval required for role '${role}' action '${actionType}'`);
      error.code = "PHASE15_HUMAN_APPROVAL_REQUIRED";
      throw error;
    }

    const agent = agentId && typeof registry.getAgent === "function" ? registry.getAgent(agentId) : null;
    const handler = agent && typeof agent.handler === "function"
      ? agent.handler
      : registry.getRole(role);
    if (!handler) {
      const error = new Error(`No registered handler for role '${role}'`);
      error.code = "PHASE15_ROLE_HANDLER_MISSING";
      throw error;
    }

    logger.info({ event: "phase15_role_dispatch", role, action_type: actionType, agent_id: agentId });
    const result = await handler(taskEnvelope, context);
    return canonicalize({ role, agent_id: agentId, action_type: actionType, result });
  }

  return Object.freeze({
    resolveRole,
    dispatch
  });
}

module.exports = {
  createRoleRouter
};
