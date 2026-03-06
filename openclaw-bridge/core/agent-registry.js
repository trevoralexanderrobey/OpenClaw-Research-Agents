"use strict";

const { safeString, canonicalize } = require("../../workflows/governance-automation/common.js");

function createAgentRegistry(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const topologyConfig = options.topologyConfig && typeof options.topologyConfig === "object" ? options.topologyConfig : {};
  const handlers = new Map();
  const agents = new Map();

  function registerRole(role, handler) {
    const normalizedRole = safeString(role).toLowerCase();
    if (!normalizedRole) {
      const error = new Error("role is required");
      error.code = "PHASE15_ROLE_REQUIRED";
      throw error;
    }
    if (typeof handler !== "function") {
      const error = new Error("handler must be a function");
      error.code = "PHASE15_HANDLER_REQUIRED";
      throw error;
    }

    handlers.set(normalizedRole, handler);
    logger.info({ event: "phase15_role_registered", role: normalizedRole });
    return { ok: true, role: normalizedRole };
  }

  function getRole(role) {
    const normalizedRole = safeString(role).toLowerCase();
    return handlers.get(normalizedRole) || null;
  }

  function registerAgent(agentId, metadata = {}, handler = null) {
    const normalizedAgentId = safeString(agentId);
    const normalizedRole = safeString(metadata.role).toLowerCase();
    if (!normalizedAgentId) {
      const error = new Error("agentId is required");
      error.code = "PHASE18_AGENT_ID_REQUIRED";
      throw error;
    }
    if (!normalizedRole) {
      const error = new Error("agent role is required");
      error.code = "PHASE18_AGENT_ROLE_REQUIRED";
      throw error;
    }

    agents.set(normalizedAgentId, canonicalize({
      agent_id: normalizedAgentId,
      mission_id: safeString(metadata.mission_id || metadata.missionId),
      role: normalizedRole,
      lane_key: safeString(metadata.lane_key || metadata.laneKey),
      order: Number(metadata.order || 0),
      handler: typeof handler === "function" ? handler : null
    }));
    logger.info({ event: "phase18_agent_registered", agent_id: normalizedAgentId, role: normalizedRole });
    return { ok: true, agent_id: normalizedAgentId, role: normalizedRole };
  }

  function getAgent(agentId) {
    const normalizedAgentId = safeString(agentId);
    return agents.get(normalizedAgentId) || null;
  }

  function listAgents(filter = {}) {
    const missionId = safeString(filter.mission_id || filter.missionId);
    const out = Array.from(agents.values())
      .filter((entry) => !missionId || safeString(entry.mission_id) === missionId)
      .map((entry) => canonicalize({
        ...entry,
        handler: entry.handler ? "[function]" : null
      }))
      .sort((left, right) => left.agent_id.localeCompare(right.agent_id));
    return canonicalize(out);
  }

  function unregisterAgent(agentId) {
    const normalizedAgentId = safeString(agentId);
    const removed = agents.delete(normalizedAgentId);
    return canonicalize({ ok: removed, agent_id: normalizedAgentId });
  }

  function teardownMissionAgents(missionId) {
    const normalizedMissionId = safeString(missionId);
    const removed = [];
    for (const [agentId, entry] of agents.entries()) {
      if (safeString(entry.mission_id) !== normalizedMissionId) {
        continue;
      }
      agents.delete(agentId);
      removed.push(agentId);
    }
    removed.sort((left, right) => left.localeCompare(right));
    return canonicalize({ ok: true, mission_id: normalizedMissionId, removed_agent_ids: removed });
  }

  function listRoles() {
    const configuredRoles = Array.isArray(topologyConfig.roles) ? topologyConfig.roles : [];
    const registered = Array.from(handlers.keys());
    const all = [...new Set([...configuredRoles, ...registered].map((entry) => safeString(entry).toLowerCase()).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right));
    return canonicalize(all);
  }

  return Object.freeze({
    registerRole,
    getRole,
    listRoles,
    registerAgent,
    getAgent,
    listAgents,
    unregisterAgent,
    teardownMissionAgents
  });
}

module.exports = {
  createAgentRegistry
};
