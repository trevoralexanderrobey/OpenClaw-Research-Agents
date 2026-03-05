"use strict";

const { safeString, canonicalize } = require("../../workflows/governance-automation/common.js");

function createAgentRegistry(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const topologyConfig = options.topologyConfig && typeof options.topologyConfig === "object" ? options.topologyConfig : {};
  const handlers = new Map();

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
    listRoles
  });
}

module.exports = {
  createAgentRegistry
};
