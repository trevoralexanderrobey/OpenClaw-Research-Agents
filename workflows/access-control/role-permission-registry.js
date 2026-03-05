"use strict";

const path = require("node:path");

const { asArray, canonicalize, safeString } = require("../governance-automation/common.js");
const {
  ACCESS_CONTROL_SCHEMA_VERSION,
  readJsonFileIfExists,
  roleAlias
} = require("./access-control-common.js");

function normalizePermission(entry = {}) {
  return canonicalize({
    permission_id: safeString(entry.permission_id) || "",
    action: safeString(entry.action) || "",
    resource: safeString(entry.resource) || "",
    conditions: entry.conditions && typeof entry.conditions === "object" ? canonicalize(entry.conditions) : {}
  });
}

function normalizeRole(role = {}) {
  const permissions = asArray(role.permissions)
    .map((entry) => normalizePermission(entry))
    .filter((entry) => entry.permission_id && entry.action && entry.resource)
    .sort((left, right) => {
      if (left.permission_id !== right.permission_id) {
        return left.permission_id.localeCompare(right.permission_id);
      }
      if (left.action !== right.action) {
        return left.action.localeCompare(right.action);
      }
      return left.resource.localeCompare(right.resource);
    });

  const scopes = asArray(role.scopes)
    .map((entry) => safeString(entry))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

  return canonicalize({
    role_id: roleAlias(role.role_id),
    description: safeString(role.description),
    permissions,
    scopes
  });
}

function matchValue(allowed, candidate) {
  const lhs = safeString(allowed);
  const rhs = safeString(candidate);
  if (!lhs || !rhs) {
    return false;
  }
  if (lhs === "*") {
    return true;
  }
  if (lhs === rhs) {
    return true;
  }
  if (lhs.endsWith(".*") && rhs.startsWith(lhs.slice(0, -1))) {
    return true;
  }
  return false;
}

function createRolePermissionRegistry(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const policyPath = path.resolve(safeString(options.policyPath) || path.join(process.cwd(), "security", "rbac-policy.json"));

  const raw = readJsonFileIfExists(policyPath, null);
  if (!raw || typeof raw !== "object") {
    const error = new Error(`RBAC policy file missing or invalid at ${policyPath}`);
    error.code = "PHASE13_RBAC_POLICY_MISSING";
    throw error;
  }

  const schemaVersion = safeString(raw.schema_version) || ACCESS_CONTROL_SCHEMA_VERSION;
  const roles = asArray(raw.roles)
    .map((entry) => normalizeRole(entry))
    .filter((entry) => entry.role_id);

  const rolesById = new Map();
  for (const role of roles) {
    rolesById.set(role.role_id, role);
  }

  function getRole(roleId) {
    const normalizedRole = roleAlias(roleId);
    const role = rolesById.get(normalizedRole);
    if (!role) {
      return null;
    }
    return canonicalize(role);
  }

  function hasPermission(roleId, action, resource) {
    const role = getRole(roleId);
    if (!role) {
      return false;
    }
    const desiredAction = safeString(action);
    const desiredResource = safeString(resource);
    if (!desiredAction || !desiredResource) {
      return false;
    }

    return asArray(role.permissions).some((permission) => (
      matchValue(permission.action, desiredAction)
      && matchValue(permission.resource, desiredResource)
    ));
  }

  function listRoles() {
    return canonicalize(
      [...rolesById.values()]
        .sort((left, right) => left.role_id.localeCompare(right.role_id))
    );
  }

  function listPermissions(roleId) {
    const role = getRole(roleId);
    if (!role) {
      return [];
    }
    return canonicalize(asArray(role.permissions));
  }

  logger.info({
    event: "phase13_rbac_registry_loaded",
    policy_path: policyPath,
    role_count: rolesById.size,
    schema_version: schemaVersion
  });

  return Object.freeze({
    policyPath,
    schema_version: schemaVersion,
    getRole,
    hasPermission,
    listRoles,
    listPermissions
  });
}

module.exports = {
  createRolePermissionRegistry
};
