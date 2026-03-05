"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { safeString, canonicalize } = require("../../workflows/governance-automation/common.js");

function readPolicy(policyPath) {
  try {
    return JSON.parse(fs.readFileSync(policyPath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { roles: {} };
    }
    throw error;
  }
}

function createAutonomyLadder(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const policyPath = path.resolve(safeString(options.policyPath) || path.join(process.cwd(), "config", "autonomy-ladder.json"));

  function resolveRolePolicy(role) {
    const policy = readPolicy(policyPath);
    const roles = policy && typeof policy.roles === "object" ? policy.roles : {};
    return roles[safeString(role).toLowerCase()] || { allowedActions: [], requireHumanApproval: [] };
  }

  function canRolePerform(role, actionType) {
    const rolePolicy = resolveRolePolicy(role);
    const allowed = Array.isArray(rolePolicy.allowedActions) ? rolePolicy.allowedActions : [];
    return allowed.includes(safeString(actionType));
  }

  function requireHumanApproval(role, actionType) {
    const rolePolicy = resolveRolePolicy(role);
    const approvalList = Array.isArray(rolePolicy.requireHumanApproval) ? rolePolicy.requireHumanApproval : [];
    const required = approvalList.includes(safeString(actionType));
    logger.info({ event: "phase15_autonomy_check", role: safeString(role), action_type: safeString(actionType), human_approval_required: required });
    return required;
  }

  return Object.freeze({
    canRolePerform,
    requireHumanApproval,
    policyPath,
    getPolicySnapshot: () => canonicalize(readPolicy(policyPath))
  });
}

module.exports = {
  createAutonomyLadder
};
